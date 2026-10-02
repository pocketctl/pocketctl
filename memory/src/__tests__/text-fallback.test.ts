import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'
import { createExtractionTextRoute, withTimeoutFallback } from '../model/text-fallback.js'

function input(document: unknown, signal = new AbortController().signal) {
  return { operation: 'candidate_extract' as const, system: 'return JSON', document,
    schema: { type: 'object' }, timeoutMs: 5_000, signal }
}

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
  test('invalidates Batch consent when switching to the realtime endpoint', () => {
    const route = createExtractionTextRoute({
      provider: 'mimo-realtime', baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.6-flash', apiKey: 'synthetic', thinking: 'disabled',
    }, undefined)
    const oldFingerprint = createHash('sha256').update(
      'mimo-batch\nhttps://batch-api-cn.xiaomimimo.com/v1\nmimo-v2.6-flash\nfallback:none',
    ).digest('hex')
    expect(route?.fingerprint).toBeDefined()
    expect(route?.fingerprint).not.toBe(oldFingerprint)
    expect(route?.fingerprint).toBe(createExtractionTextRoute({
      provider: 'mimo-realtime', baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.6-flash', apiKey: 'rotated-synthetic', thinking: 'disabled',
    }, undefined)?.fingerprint)
  })

  test('uses one fingerprint for the MiMo primary and DeepSeek timeout fallback', () => {
    const route = createExtractionTextRoute(
      {
        provider: 'mimo-realtime', baseUrl: 'https://mimo.example/v1',
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
      provider: 'mimo-realtime',
      origin: 'https://mimo.example/v1',
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
