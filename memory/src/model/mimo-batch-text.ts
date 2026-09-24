import { randomUUID } from 'node:crypto'
import type {
  JsonSchema,
  ModelJsonResult,
  TextGenerator,
  TextGeneratorOperation,
} from '../ports/text-generator.js'
import { completionUsage } from './openai-compatible-text.js'

export interface MimoBatchTextOptions {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  maxResponseBytes?: number
  maxOutputTokens?: number
  batchWindowMs?: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  inputCostMicrosPerMillionTokens?: number
  outputCostMicrosPerMillionTokens?: number
}

interface GenerateInput {
  operation: TextGeneratorOperation
  system: string
  document: unknown
  schema: JsonSchema
  timeoutMs: number
  signal: AbortSignal
}

interface PendingRequest {
  id: string
  input: GenerateInput
  resolve: (result: ModelJsonResult<unknown>) => void
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  abort: () => void
  onSettled?: () => void
}

interface BatchStatus {
  id?: unknown
  status?: unknown
  output_file_id?: unknown
}

interface BatchOutputLine {
  custom_id?: unknown
  response?: { status_code?: unknown; body?: unknown } | null
  error?: unknown
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_BATCH_WINDOW_MS = 25
const DEFAULT_POLL_INTERVAL_MS = 1_000

class MimoBatchError extends Error {
  constructor(readonly detail: string, readonly retryable: boolean) {
    super(`MiMo Batch request failed: ${detail}`)
    this.name = 'MimoBatchError'
  }
}

/**
 * Coalescing adapter for Xiaomi's asynchronous Batch API. Concurrent Memory
 * jobs share one JSONL file and one provider batch; custom_id correlates each
 * content-free result without exposing the Episode Packet to logs.
 */
export function createMimoBatchTextGenerator(options: MimoBatchTextOptions): TextGenerator {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? fetch
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const batchWindowMs = Math.max(0, options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS)
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const sleep = options.sleep ?? (async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  let queue: PendingRequest[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function settle(pending: PendingRequest, result: ModelJsonResult<unknown>): void {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.input.signal.removeEventListener('abort', pending.abort)
    pending.resolve(result)
    pending.onSettled?.()
  }

  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<string> {
    try {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${options.apiKey}`)
      const response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal,
        redirect: 'error',
      })
      const text = await readBoundedBody(response, maxResponseBytes)
      if (!response.ok) {
        throw new MimoBatchError(
          `http_status_${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        )
      }
      return text
    } catch (error) {
      if (error instanceof MimoBatchError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MimoBatchError('timeout', true)
      }
      throw new MimoBatchError('network', true)
    }
  }

  async function requestJson(path: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    const text = await request(path, init, signal)
    try {
      const value = JSON.parse(text) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // Mapped to a bounded code below.
    }
    throw new MimoBatchError('invalid_response', false)
  }

  function jsonBody(body: unknown): Pick<RequestInit, 'headers' | 'body'> {
    return {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  }

  async function bestEffortCancel(batchId: string, signal: AbortSignal): Promise<void> {
    try {
      await requestJson(`/batches/${encodeURIComponent(batchId)}/cancel`, {
        method: 'POST', ...jsonBody({}),
      }, signal)
    } catch {
      // Cancellation is cost hygiene after callers have an authoritative
      // result; it must not replace that result or leak provider details.
    }
  }

  async function processBatch(batch: PendingRequest[]): Promise<void> {
    const active = batch.filter(item => !item.settled)
    if (active.length === 0) return
    const controller = new AbortController()
    let batchId: string | undefined
    const stopWhenUnused = () => {
      if (active.every(item => item.settled)) controller.abort()
    }
    for (const item of active) item.onSettled = stopWhenUnused

    try {
      const lines = active.map(item => JSON.stringify({
        custom_id: item.id,
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: options.model,
          messages: [
            {
              role: 'system',
              content: `${item.input.system}\n\nOutput JSON Schema:\n${JSON.stringify(item.input.schema)}`,
            },
            { role: 'user', content: JSON.stringify(item.input.document) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          thinking: { type: 'disabled' },
          ...(options.maxOutputTokens === undefined
            ? {}
            : { max_completion_tokens: options.maxOutputTokens }),
        },
      })).join('\n') + '\n'
      const form = new FormData()
      form.append('purpose', 'batch')
      form.append('file', new Blob([lines], { type: 'application/jsonl' }), 'pocketctl-memory.jsonl')
      const uploaded = await requestJson('/files', { method: 'POST', body: form }, controller.signal)
      if (typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
        throw new MimoBatchError('invalid_response', false)
      }
      const created = await requestJson('/batches', {
        method: 'POST',
        ...jsonBody({
          input_file_id: uploaded.id,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
          // Xiaomi's Batch API fails with 500 internal_error when name is
          // absent (OpenAI treats it as optional). Bounded, content-free.
          name: `pocketctl-memory-${randomUUID().slice(0, 8)}`,
        }),
      }, controller.signal) as BatchStatus
      if (typeof created.id !== 'string' || created.id.length === 0) {
        throw new MimoBatchError('invalid_response', false)
      }
      batchId = created.id

      let status: BatchStatus = created
      while (true) {
        if (active.every(item => item.settled)) {
          void bestEffortCancel(batchId, new AbortController().signal)
          return
        }
        const state = typeof status.status === 'string' ? status.status.toLowerCase() : ''
        if (state === 'completed') break
        if (state === 'failed' || state === 'expired' || state === 'cancelled') {
          throw new MimoBatchError(state === 'expired' ? 'timeout' : `batch_${state}`, state === 'expired')
        }
        await sleep(pollIntervalMs)
        status = await requestJson(`/batches/${encodeURIComponent(batchId)}`, {
          method: 'GET',
        }, controller.signal) as BatchStatus
      }

      if (typeof status.output_file_id !== 'string' || status.output_file_id.length === 0) {
        throw new MimoBatchError('invalid_response', false)
      }
      const output = await request(
        `/files/${encodeURIComponent(status.output_file_id)}/content`,
        { method: 'GET' },
        controller.signal,
      )
      const byId = parseOutputLines(output)
      for (const item of active) {
        if (item.settled) continue
        const line = byId.get(item.id)
        if (!line) {
          settle(item, { ok: false, code: 'http_error', detail: 'missing_batch_result', retryable: false })
          continue
        }
        settle(item, parseCompletion(line, options))
      }
    } catch (error) {
      const failure = error instanceof MimoBatchError
        ? error
        : new MimoBatchError('unknown', false)
      for (const item of active) {
        if (item.settled) continue
        if (item.input.signal.aborted) {
          settle(item, { ok: false, code: 'aborted', retryable: false })
        } else {
          settle(item, {
            ok: false,
            code: 'http_error',
            detail: failure.detail,
            retryable: failure.retryable,
          })
        }
      }
      if (batchId && failure.detail === 'timeout') {
        void bestEffortCancel(batchId, new AbortController().signal)
      }
    } finally {
      for (const item of active) item.onSettled = undefined
    }
  }

  function flush(): void {
    flushTimer = undefined
    const batch = queue
    queue = []
    void processBatch(batch)
  }

  return {
    generateJson<T>(input: GenerateInput): Promise<ModelJsonResult<T>> {
      if (input.signal.aborted) {
        return Promise.resolve({ ok: false, code: 'aborted', retryable: false })
      }
      return new Promise(resolve => {
        const pending: PendingRequest = {
          id: `memory-${randomUUID()}`,
          input,
          resolve: result => resolve(result as ModelJsonResult<T>),
          settled: false,
          abort: () => settle(pending, { ok: false, code: 'aborted', retryable: false }),
        }
        const timeoutMs = Math.max(1, Math.min(options.timeoutMs, input.timeoutMs))
        pending.timer = setTimeout(() => {
          settle(pending, { ok: false, code: 'http_error', detail: 'timeout', retryable: true })
        }, timeoutMs)
        input.signal.addEventListener('abort', pending.abort, { once: true })
        queue.push(pending)
        if (!flushTimer) flushTimer = setTimeout(flush, batchWindowMs)
      })
    },
  }
}

function parseOutputLines(text: string): Map<string, BatchOutputLine> {
  const output = new Map<string, BatchOutputLine>()
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let line: BatchOutputLine
    try {
      line = JSON.parse(raw) as BatchOutputLine
    } catch {
      throw new MimoBatchError('invalid_response', false)
    }
    if (typeof line.custom_id !== 'string' || line.custom_id.length === 0 || output.has(line.custom_id)) {
      throw new MimoBatchError('invalid_response', false)
    }
    output.set(line.custom_id, line)
  }
  return output
}

function parseCompletion<T>(line: BatchOutputLine, options: MimoBatchTextOptions): ModelJsonResult<T> {
  if (!line.response || line.response.status_code !== 200) {
    const status = line.response?.status_code
    return {
      ok: false,
      code: 'http_error',
      detail: status === 408 ? 'timeout' : 'batch_item_error',
      retryable: status === 408 || status === 429 || (typeof status === 'number' && status >= 500),
    }
  }
  const completion = line.response.body && typeof line.response.body === 'object'
    ? line.response.body as {
        choices?: Array<{ message?: { content?: unknown } }>
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
        model?: unknown
      }
    : {}
  const usage = completionUsage(
    completion,
    options.model,
    options.inputCostMicrosPerMillionTokens,
    options.outputCostMicrosPerMillionTokens,
  )
  if (!usage) return { ok: false, code: 'invalid_usage', retryable: false, detail: 'invalid_usage' }
  const content = completion.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    return { ok: false, code: 'empty_content', retryable: false, usage }
  }
  try {
    return { ok: true, value: JSON.parse(content) as T, usage }
  } catch {
    return { ok: false, code: 'invalid_json', retryable: false, usage }
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new MimoBatchError('response_too_large', false)
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}
