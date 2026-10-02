import { describe, expect, test, vi } from 'vitest'
import { createMimoRealtimeTextGenerator } from '../model/mimo-realtime-text.js'
import { withTimeoutFallback } from '../model/text-fallback.js'
import { withTextProviderBudget, type ProviderBudgetStore } from '../model/provider-budget.js'
import type { TextGenerator } from '../ports/text-generator.js'

const options = {
  baseUrl: 'https://api.xiaomimimo.com/v1/',
  model: 'mimo-v2.6-flash',
  apiKey: 'synthetic-mimo-secret',
  timeoutMs: 5_000,
  maxOutputTokens: 128,
}

function input(signal = new AbortController().signal) {
  return { operation: 'candidate_extract' as const, system: 'Return JSON only',
    document: { synthetic: true }, schema: { type: 'object' }, timeoutMs: 5_000, signal }
}

function response(content = '{"ok":true}', status = 200) {
  return new Response(JSON.stringify({
    model: 'mimo-v2.6-flash', choices: [{ message: { content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }), { status, headers: { 'content-type': 'application/json' } })
}

describe('MiMo realtime text adapter', () => {
  test('returns a completion from one bounded, non-streaming Chat Completions request', async () => {
    const fetchImpl = vi.fn(async () => response())
    const result = await createMimoRealtimeTextGenerator({ ...options, fetchImpl }).generateJson(input())
    expect(result).toEqual({ ok: true, value: { ok: true },
      usage: { inputTokens: 11, outputTokens: 7, model: 'mimo-v2.6-flash' } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const headers = new Headers(init.headers)
    expect(headers.get('api-key')).toBe('synthetic-mimo-secret')
    expect(headers.has('authorization')).toBe(false)
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model: 'mimo-v2.6-flash',
      thinking: { type: 'disabled' }, stream: false,
      max_completion_tokens: 128, response_format: { type: 'json_object' } })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body.messages[1].content).toBe('{"synthetic":true}')
  })

  test('concurrent callers issue separate realtime requests without Batch upload or polling', async () => {
    const fetchImpl = vi.fn(async () => response())
    const provider = createMimoRealtimeTextGenerator({ ...options, fetchImpl })
    const results = await Promise.all([provider.generateJson(input()), provider.generateJson(input())])
    expect(results.every(result => result.ok)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [url] of fetchImpl.mock.calls as unknown as Array<[string]>) {
      expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    }
  })

  test.each([401, 429, 500])('HTTP %s neither retries outside the budget nor invokes DeepSeek', async status => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'sensitive provider response', api_key: options.apiKey },
    }), { status }))
    const fallback = { generateJson: vi.fn(async () => ({ ok: true as const,
      value: {}, usage: { inputTokens: 1, outputTokens: 1, model: 'deepseek-flash' } })) } as TextGenerator
    const result = await withTimeoutFallback(
      createMimoRealtimeTextGenerator({ ...options, fetchImpl }), fallback,
    ).generateJson(input())
    expect(result).toMatchObject({ ok: false, code: 'http_error' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fallback.generateJson).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('sensitive provider response')
    expect(JSON.stringify(result)).not.toContain(options.apiKey)
  })

  test('a provider deadline invokes the timeout fallback and reserves each request separately', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
      }))
    const store: ProviderBudgetStore = {
      reserve: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation' })),
      settle: vi.fn(async () => undefined),
    }
    const limits = { key: 'synthetic', maxRequests: 2, maxInputTokens: 10_000,
      maxOutputTokens: 256, maxOutputTokensPerRequest: 128 }
    const fallback = { generateJson: vi.fn(async () => ({ ok: true as const,
      value: { fallback: true }, usage: { inputTokens: 2, outputTokens: 3, model: 'deepseek-flash' } })) } as TextGenerator
    const provider = withTimeoutFallback(
      withTextProviderBudget(createMimoRealtimeTextGenerator({ ...options, fetchImpl }), store, limits),
      withTextProviderBudget(fallback, store, limits),
    )
    const result = await provider.generateJson({ ...input(), timeoutMs: 10 })
    expect(result).toMatchObject({ ok: true, value: { fallback: true } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fallback.generateJson).toHaveBeenCalledTimes(1)
    expect(store.reserve).toHaveBeenCalledTimes(2)
    expect(store.settle).toHaveBeenCalledWith('reservation', { inputTokens: 2, outputTokens: 3 })
  })

  test('caller cancellation aborts the realtime request without fallback', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    })
    const fallback = { generateJson: vi.fn() }
    const result = await withTimeoutFallback(
      createMimoRealtimeTextGenerator({ ...options, fetchImpl }), fallback,
    ).generateJson(input(controller.signal))
    expect(result).toMatchObject({ ok: false, code: 'aborted', retryable: false })
    expect(fallback.generateJson).not.toHaveBeenCalled()
  })

  test('invalid JSON retains usage and does not invoke the timeout fallback', async () => {
    const fallback = { generateJson: vi.fn() }
    const result = await withTimeoutFallback(createMimoRealtimeTextGenerator({
      ...options, fetchImpl: async () => response('not JSON'),
    }), fallback).generateJson(input())
    expect(result).toMatchObject({ ok: false, code: 'invalid_json', retryable: false,
      usage: { inputTokens: 11, outputTokens: 7 } })
    expect(fallback.generateJson).not.toHaveBeenCalled()
  })

  test('an exhausted budget prevents the realtime request', async () => {
    const fetchImpl = vi.fn(async () => response())
    const store: ProviderBudgetStore = { reserve: vi.fn(async () => ({ ok: false as const,
      dimension: 'text_requests' as const })), settle: vi.fn() }
    const result = await withTextProviderBudget(
      createMimoRealtimeTextGenerator({ ...options, fetchImpl }), store,
      { key: 'synthetic', maxRequests: 1, maxInputTokens: 4096, maxOutputTokens: 128, maxOutputTokensPerRequest: 128 },
    ).generateJson(input())
    expect(result).toMatchObject({ ok: false, code: 'budget_exceeded', detail: 'text_requests' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
