import {
  RelayRequestError,
  isRetryableStatus,
  relayErrorFromBody,
} from './errors.js'

export interface RelayHttpClientOptions {
  baseUrl: string
  timeoutMs: number
  /** Immediate in-operation retries (default 3); long loops own backoff. */
  maxRetries?: number
  maxResponseBytes?: number
  fetchImpl?: typeof fetch
  now?: () => number
  /** Injectable bounded delay for Retry-After handling and deterministic tests. */
  sleep?: (ms: number) => Promise<void>
  /** Optional per-request observation for metrics (labels are bounded). */
  observe?(input: {
    operation: string
    result: 'success' | 'error'
    code?: string
    durationMs: number
  }): void
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const RETRY_AFTER_CAP_SECONDS = 30

function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const seconds = /^[0-9]+$/.test(header) ? Number(header) : Number(Date.parse(header))
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  // HTTP-date values arrive as epoch ms above 10^12; cap both shapes.
  const ms = seconds > 10_000_000_000 ? seconds - now : seconds * 1000
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_SECONDS * 1000)
}

/**
 * Bounded HTTP core for every Relay call: fixed timeouts via AbortSignal,
 * immediate retries for transient failures only, byte-capped responses and
 * typed errors that never carry bodies, tokens or lease material.
 */
export function createRelayHttpClient(options: RelayHttpClientOptions) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))

  async function once(
    operation: string,
    method: string,
    path: string,
    body: unknown,
    token: string | undefined,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    let response: Response
    try {
      response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RelayRequestError({ operation, code: 'timeout' })
      }
      throw new RelayRequestError({ operation, code: 'network' })
    } finally {
      clearTimeout(timer)
    }

    if (isRetryableStatus(response.status)) {
      throw new RelayRequestError({
        operation,
        code: response.status === 429 ? 'rate_limited' : 'relay_error',
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), now()),
      })
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > maxResponseBytes) {
      throw new RelayRequestError({ operation, code: 'response_too_large', status: response.status })
    }
    const text = await readBoundedBody(response, maxResponseBytes, operation)
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null

    if (!response.ok) {
      throw relayErrorFromBody(operation, response.status, parsed)
    }
    return parsed
  }

  return {
    request(
      method: string,
      path: string,
      input: { body?: unknown; token?: string; operation?: string } = {},
    ): Promise<unknown> {
      const operation = input.operation ?? `${method} ${path}`
      let attempts = 0
      const startedAt = now()
      const run = (): Promise<unknown> => {
        attempts++
        return once(operation, method, path, input.body, input.token).catch((error: unknown) => {
          const retryable = error instanceof RelayRequestError
            && (error.code === 'network'
              || error.code === 'rate_limited'
              || (error.code === 'relay_error'
                && error.status !== undefined
                && isRetryableStatus(error.status)))
          if (retryable && attempts <= maxRetries) {
            const delayMs = error instanceof RelayRequestError ? error.retryAfterMs ?? 0 : 0
            return delayMs > 0 ? sleep(delayMs).then(run) : run()
          }
          throw error
        })
      }
      return run().then(
        result => {
          options.observe?.({ operation, result: 'success', durationMs: now() - startedAt })
          return result
        },
        error => {
          options.observe?.({
            operation,
            result: 'error',
            code: error instanceof RelayRequestError ? error.code : 'unknown',
            durationMs: now() - startedAt,
          })
          throw error
        },
      )
    },
  }
}

export type RelayHttpClient = ReturnType<typeof createRelayHttpClient>

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  operation: string,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maxResponseBytes) {
      await reader.cancel()
      throw new RelayRequestError({
        operation, code: 'response_too_large', status: response.status,
      })
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}
