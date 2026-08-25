/**
 * Bounded HTTP transport for model providers. Requests and responses are
 * size-limited, every call is abortable, failures classify into a stable
 * retry decision, and error surfaces never include the base URL, API key,
 * request body, or response body.
 */

export type ModelHttpErrorCode =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'unauthorized'
  | 'bad_request'
  | 'response_too_large'
  | 'invalid_response'

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 8_000

export class ModelHttpError extends Error {
  readonly code: ModelHttpErrorCode
  readonly status?: number
  readonly retryable: boolean
  /** Bounded server-provided delay hint (rate limits), in milliseconds. */
  retryAfterMs?: number

  constructor(input: { code: ModelHttpErrorCode; status?: number; retryable: boolean }) {
    super(`model request failed: ${input.code}`)
    this.name = 'ModelHttpError'
    this.code = input.code
    this.status = input.status
    this.retryable = input.retryable
  }
}

export interface ModelHttpClientOptions {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  maxResponseBytes?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export interface ModelHttpClient {
  postJson(path: string, body: unknown, options: {
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<unknown>
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after')
  if (raw === null) return null
  const seconds = Number(raw)
  const ms = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : Date.parse(raw) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(ms, 30_000)
}

function classifyStatus(status: number): ModelHttpError {
  if (status === 401 || status === 403) {
    return new ModelHttpError({ code: 'unauthorized', status, retryable: false })
  }
  if (status === 429) {
    return new ModelHttpError({ code: 'rate_limited', status, retryable: true })
  }
  if (status === 408) {
    return new ModelHttpError({ code: 'timeout', status, retryable: true })
  }
  if (status >= 500) {
    return new ModelHttpError({ code: 'server_error', status, retryable: true })
  }
  return new ModelHttpError({ code: 'bad_request', status, retryable: false })
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
      throw new ModelHttpError({ code: 'response_too_large', retryable: false })
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}

export function createModelHttpClient(options: ModelHttpClientOptions): ModelHttpClient {
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

  return {
    async postJson(path, body, requestOptions): Promise<unknown> {
      const timeoutMs = requestOptions.timeoutMs ?? options.timeoutMs
      const lastError: ModelHttpError[] = []
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (requestOptions.signal.aborted) {
          throw new ModelHttpError({ code: 'timeout', retryable: false })
        }
        const controller = new AbortController()
        const abortForward = () => controller.abort()
        requestOptions.signal.addEventListener('abort', abortForward, { once: true })
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await doFetch(`${options.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: 'error',
          })
          if (requestOptions.signal.aborted) {
            throw new ModelHttpError({ code: 'timeout', retryable: false })
          }
          const text = await readBoundedBody(response, maxResponseBytes)
          if (!response.ok) {
            const classified = classifyStatus(response.status)
            if (classified.code === 'rate_limited') {
              classified.retryAfterMs = retryAfterMs(response) ?? undefined
            }
            throw classified
          }
          try {
            return text.length > 0 ? JSON.parse(text) as unknown : null
          } catch {
            throw new ModelHttpError({ code: 'invalid_response', retryable: false })
          }
        } catch (error) {
          if (requestOptions.signal.aborted) {
            throw new ModelHttpError({ code: 'timeout', retryable: false })
          }
          let classified: ModelHttpError
          if (error instanceof ModelHttpError) {
            classified = error
          } else if (error instanceof Error && error.name === 'AbortError') {
            classified = new ModelHttpError({ code: 'timeout', retryable: true })
          } else if (error instanceof TypeError) {
            classified = new ModelHttpError({ code: 'network', retryable: true })
          } else {
            classified = new ModelHttpError({ code: 'network', retryable: true })
          }
          lastError.push(classified)
          if (!classified.retryable || attempt === MAX_ATTEMPTS) throw classified
          const backoff = classified.retryAfterMs
            ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
          await abortableSleep(sleep, backoff, requestOptions.signal)
        } finally {
          clearTimeout(timer)
          requestOptions.signal.removeEventListener('abort', abortForward)
        }
      }
      throw lastError[lastError.length - 1] ?? new ModelHttpError({ code: 'network', retryable: true })
    },
  }
}

async function abortableSleep(
  sleep: ((ms: number) => Promise<void>) | undefined,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new ModelHttpError({ code: 'timeout', retryable: false })
  if (!sleep) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, ms)
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(new ModelHttpError({ code: 'timeout', retryable: false }))
      }
      signal.addEventListener('abort', abort, { once: true })
    })
    return
  }
  let abort: (() => void) | undefined
  try {
    await Promise.race([
      sleep(ms),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ModelHttpError({ code: 'timeout', retryable: false }))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}
