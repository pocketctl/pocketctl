import { describe, expect, test, vi } from 'vitest'
import { createRelayHttpClient } from '../relay/http-client.js'
import { RelayRequestError } from '../relay/errors.js'

type FetchLike = typeof fetch

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function client(overrides: {
  fetchImpl?: FetchLike
  maxRetries?: number
  maxResponseBytes?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
} = {}) {
  return createRelayHttpClient({
    baseUrl: 'http://relay.test',
    timeoutMs: overrides.timeoutMs ?? 5000,
    maxRetries: overrides.maxRetries ?? 3,
    maxResponseBytes: overrides.maxResponseBytes ?? 1024 * 1024,
    fetchImpl: overrides.fetchImpl ?? (vi.fn() as unknown as FetchLike),
    sleep: overrides.sleep,
  })
}

describe('relay http client retries', () => {
  test('observes every request once with bounded labels', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') return jsonResponse(200, { ok: true })
      return jsonResponse(503, { error: { code: 'relay_error', message: 'down' } })
    })
    const observed: Array<{ operation: string; result: string; code?: string }> = []
    const http = createRelayHttpClient({
      baseUrl: 'http://relay.test',
      timeoutMs: 5000,
      fetchImpl,
      observe: input => observed.push(input),
    })
    await http.request('GET', '/api/x', { operation: 'pull_feed' })
    expect(observed).toEqual([
      expect.objectContaining({ operation: 'pull_feed', result: 'success' }),
    ])
    observed.length = 0
    await expect(http.request('POST', '/gone', { operation: 'get_snapshot' }))
      .rejects.toBeInstanceOf(RelayRequestError)
    expect(observed).toEqual([
      expect.objectContaining({
        operation: 'get_snapshot',
        result: 'error',
        code: expect.any(String),
      }),
    ])
  })

  test('retries network failures up to the cap, then succeeds', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls < 3) throw new TypeError('fetch failed')
      return jsonResponse(200, { ok: true })
    })
    const result = await client({ fetchImpl }).request('GET', '/api/x')
    expect(calls).toBe(3)
    expect((result as { ok: boolean }).ok).toBe(true)
  })

  test('exhausts retries on persistent network failure with a typed error', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(client({ fetchImpl }).request('GET', '/api/x'))
      .rejects.toMatchObject({ code: 'network' })
  })

  test('retries 408, 429 and 5xx but never other 4xx', async () => {
    for (const status of [408, 429, 503]) {
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        calls++
        if (calls === 1) return jsonResponse(status, { error: { code: 'x', message: 'y' } })
        return jsonResponse(200, { ok: true })
      })
      const result = await client({ fetchImpl }).request('GET', '/api/x')
      expect(calls, `status ${status}`).toBe(2)
      expect((result as { ok: boolean }).ok).toBe(true)
    }
    for (const status of [400, 404, 409]) {
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        calls++
        return jsonResponse(status, { error: { code: 'x', message: 'y' } })
      })
      await expect(client({ fetchImpl }).request('GET', '/api/x')).rejects.toBeInstanceOf(RelayRequestError)
      expect(calls, `status ${status}`).toBe(1)
    }
  })

  test('waits for the bounded Retry-After hint before retrying', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return jsonResponse(429, { error: { code: 'x', message: 'y' } }, { 'retry-after': '3600' })
      return jsonResponse(200, { ok: true })
    })
    const delays: number[] = []
    const result = await client({
      fetchImpl,
      maxRetries: 1,
      sleep: async ms => { delays.push(ms) },
    }).request('GET', '/api/x')
    expect(result).toEqual({ ok: true })
    expect(delays).toEqual([30_000])
  })

  test('maps relay error bodies to typed codes without echoing the body', async () => {
    const secret = 'lease-secret-should-not-appear'
    const fetchImpl = vi.fn(async () => jsonResponse(409, {
      error: { code: 'stale_lease', message: `lease ${secret} is gone` },
    }))
    try {
      await client({ fetchImpl }).request('GET', '/api/x')
      expect.unreachable('expected stale_lease')
    } catch (error) {
      expect(error).toBeInstanceOf(RelayRequestError)
      const typed = error as RelayRequestError
      expect(typed.code).toBe('stale_lease')
      expect(typed.status).toBe(409)
      expect(typed.message).not.toContain(secret)
    }
  })

  test('surfaces snapshot_required detail from hard-retention 410s', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(410, {
      error: { code: 'cursor_expired', message: 'retention passed', snapshot_required: true },
    }))
    await expect(client({ fetchImpl }).request('GET', '/api/x'))
      .rejects.toMatchObject({ code: 'cursor_expired', snapshotRequired: true })
  })

  test('classifies timeouts distinctly from network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      // The runtime surfaces an AbortError when the deadline elapses.
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    })
    await expect(client({ fetchImpl, maxRetries: 0 }).request('GET', '/api/x'))
      .rejects.toMatchObject({ code: 'timeout' })
  })

  test('rejects responses beyond the byte budget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { blob: 'x'.repeat(4096) }))
    await expect(client({ fetchImpl, maxResponseBytes: 512, maxRetries: 0 }).request('GET', '/api/x'))
      .rejects.toMatchObject({ code: 'response_too_large' })
  })

  test('cancels a chunked response as soon as the byte budget is exceeded', async () => {
    let pulls = 0
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(300))
        if (pulls === 3) controller.close()
      },
      cancel() {
        canceled = true
      },
    }, { highWaterMark: 0 })
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(client({ fetchImpl, maxResponseBytes: 512, maxRetries: 0 }).request('GET', '/api/x'))
      .rejects.toMatchObject({ code: 'response_too_large' })
    expect(canceled).toBe(true)
    expect(pulls).toBe(2)
  })

  test('never sends the provider token in logs or error messages', async () => {
    const bearer = 'provider-jwt-secret-material'
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const http = client({ fetchImpl, maxRetries: 0 })
    try {
      await http.request('GET', '/api/x', { token: bearer })
      expect.unreachable()
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(bearer)
    }
  })
})

describe('relay provider token client', () => {
  test('caches the token and refreshes 30s before expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'))
    let exchanges = 0
    const fetchImpl = vi.fn(async () => {
      exchanges++
      return jsonResponse(200, { access_token: `tok-${exchanges}`, expires_in: 900 })
    })
    const { createProviderTokenClient } = await import('../relay/token-client.js')
    const tokens = createProviderTokenClient({
      relayUrl: 'http://relay.test',
      clientId: 'client-1',
      clientSecret: 'client-secret-1',
      http: client({ fetchImpl }),
    })
    expect(await tokens.get()).toBe('tok-1')
    expect(await tokens.get()).toBe('tok-1')
    expect(exchanges).toBe(1)

    vi.setSystemTime(new Date('2026-08-23T00:14:31Z')) // expiry - 29s
    expect(await tokens.get()).toBe('tok-2')
    expect(exchanges).toBe(2)

    tokens.invalidate()
    expect(await tokens.get()).toBe('tok-3')
    vi.useRealTimers()
  })
})
