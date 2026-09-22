import { describe, expect, test, vi } from 'vitest'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'
import { createMimoBatchTextGenerator } from '../model/mimo-batch-text.js'
import { createExtractionTextRoute, withTimeoutFallback } from '../model/text-fallback.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function input(document: unknown, signal = new AbortController().signal) {
  return {
    operation: 'candidate_extract' as const,
    system: 'return JSON',
    document,
    schema: { type: 'object' },
    timeoutMs: 5_000,
    signal,
  }
}

describe('MiMo Batch text adapter', () => {
  test('coalesces concurrent requests, disables thinking, and correlates reversed results', async () => {
    let uploadedJsonl = ''
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/files') && init?.method === 'POST') {
        const form = init.body as FormData
        uploadedJsonl = await (form.get('file') as Blob).text()
        return jsonResponse({ id: 'file-input', status: 'active' })
      }
      if (path.endsWith('/batches') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          input_file_id: 'file-input', endpoint: '/v1/chat/completions', completion_window: '24h',
        })
        return jsonResponse({ id: 'batch-1', status: 'validating' })
      }
      if (path.endsWith('/batches/batch-1')) {
        return jsonResponse({ id: 'batch-1', status: 'completed', output_file_id: 'file-output' })
      }
      if (path.endsWith('/files/file-output/content')) {
        const requests = uploadedJsonl.trim().split('\n').map(line => JSON.parse(line))
        expect(requests).toHaveLength(2)
        for (const request of requests) {
          expect(request.url).toBe('/v1/chat/completions')
          expect(request.body).toMatchObject({
            model: 'mimo-v2.6-flash',
            response_format: { type: 'json_object' },
            thinking: { type: 'disabled' },
            max_completion_tokens: 4096,
          })
          expect(request.body).not.toHaveProperty('max_tokens')
        }
        const result = (request: any) => JSON.stringify({
          custom_id: request.custom_id,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: JSON.stringify({ source: request.body.messages[1].content }) } }],
              usage: { prompt_tokens: 11, completion_tokens: 7 },
              model: 'mimo-v2.6-flash',
            },
          },
          error: null,
        })
        return new Response([...requests].reverse().map(result).join('\n'))
      }
      throw new Error(`unexpected request: ${path}`)
    })
    const generator = createMimoBatchTextGenerator({
      baseUrl: 'https://batch-api-cn.xiaomimimo.com/v1',
      model: 'mimo-v2.6-flash',
      apiKey: 'mimo-secret',
      timeoutMs: 5_000,
      batchWindowMs: 0,
      pollIntervalMs: 0,
      maxOutputTokens: 4096,
      fetchImpl: fetchImpl as typeof fetch,
    })

    const [first, second] = await Promise.all([
      generator.generateJson<{ source: string }>(input({ episode: 1 })),
      generator.generateJson<{ source: string }>(input({ episode: 2 })),
    ])

    expect(first).toMatchObject({ ok: true, usage: { model: 'mimo-v2.6-flash' } })
    expect(second).toMatchObject({ ok: true, usage: { model: 'mimo-v2.6-flash' } })
    if (first.ok && second.ok) {
      expect(first.value.source).toContain('"episode":1')
      expect(second.value.source).toContain('"episode":2')
    }
    const uploadHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers)
    expect(uploadHeaders.get('authorization')).toBe('Bearer mimo-secret')
  })

  test('classifies a provider AbortError as a timeout eligible for fallback', async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException('timed out', 'AbortError') })
    const generator = createMimoBatchTextGenerator({
      baseUrl: 'https://batch.example/v1', model: 'mimo-v2.6-flash', apiKey: 'secret',
      timeoutMs: 5_000, batchWindowMs: 0, fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(generator.generateJson(input({ episode: 1 }))).resolves.toMatchObject({
      ok: false, code: 'http_error', detail: 'timeout', retryable: true,
    })
  })

  test('caller cancellation is aborted and never timeout fallback', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const generator = createMimoBatchTextGenerator({
      baseUrl: 'https://batch.example/v1', model: 'mimo-v2.6-flash', apiKey: 'secret',
      timeoutMs: 5_000, batchWindowMs: 0, fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(generator.generateJson(input({}, controller.signal))).resolves.toMatchObject({
      ok: false, code: 'aborted', retryable: false,
    })
  })
})

describe('timeout-only text fallback', () => {
  const success: ModelJsonResult<{ provider: string }> = {
    ok: true,
    value: { provider: 'deepseek' },
    usage: { inputTokens: 1, outputTokens: 1, model: 'deepseek-flash' },
  }

  test('uses fallback only for provider timeout detail', async () => {
    const primary = { generateJson: vi.fn(async () => ({
      ok: false as const, code: 'http_error' as const, detail: 'timeout', retryable: true,
    })) } as TextGenerator
    const fallback = { generateJson: vi.fn(async () => success) } as TextGenerator

    const result = await withTimeoutFallback(primary, fallback).generateJson<{ provider: string }>(input({}))

    expect(result).toEqual(success)
    expect(fallback.generateJson).toHaveBeenCalledTimes(1)
  })

  test.each([
    { code: 'http_error' as const, detail: 'unauthorized', retryable: false },
    { code: 'invalid_json' as const, retryable: false },
    { code: 'aborted' as const, retryable: false },
  ])('does not fallback for $code/$detail', async failure => {
    const primary = { generateJson: vi.fn(async () => ({ ok: false as const, ...failure })) } as TextGenerator
    const fallback = { generateJson: vi.fn(async () => success) } as TextGenerator

    const result = await withTimeoutFallback(primary, fallback).generateJson(input({}))

    expect(result).toMatchObject(failure)
    expect(fallback.generateJson).not.toHaveBeenCalled()
  })
})

describe('extraction text route disclosure', () => {
  test('uses one fingerprint for the MiMo primary and DeepSeek timeout fallback', () => {
    const route = createExtractionTextRoute(
      {
        provider: 'mimo-batch', baseUrl: 'https://batch.example/v1',
        model: 'mimo-v2.6-flash', apiKey: 'mimo', thinking: 'disabled',
      },
      {
        provider: 'openai-compatible', baseUrl: 'https://deepseek.example/v1',
        model: 'deepseek-flash', apiKey: 'deepseek', thinking: 'disabled',
        pricingConfigured: true,
        inputCostMicrosPerMillionTokens: 1,
        outputCostMicrosPerMillionTokens: 2,
      },
    )
    expect(route).toMatchObject({
      provider: 'mimo-batch',
      origin: 'https://batch.example/v1',
      model: 'mimo-v2.6-flash',
      pricing_configured: false,
      fallback: {
        provider: 'openai-compatible',
        origin: 'https://deepseek.example/v1',
        model: 'deepseek-flash',
      },
    })
    expect(route?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })
})
