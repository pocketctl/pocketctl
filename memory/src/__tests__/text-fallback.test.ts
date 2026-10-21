import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import type { ModelJsonResult, TextGenerator } from '../ports/text-generator.js'
import { withTextProviderBudget, type ProviderBudgetStore } from '../model/provider-budget.js'
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

    expect(result).toEqual({ ...success, timeoutFallback: { primary: { code: 'http_error', detail: 'timeout' } } })
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

// Keep the two production wrappers real; replace only external boundaries.
describe('timeout fallback composed with provider budget guards', () => {
  const timeout = { ok: false as const, code: 'http_error' as const, detail: 'timeout', retryable: true }
  const success = { ok: true as const, value: { provider: 'deepseek' },
    usage: { inputTokens: 7, outputTokens: 3, model: 'deepseek-flash' } }
  const limits = { key: 'shared-daily', window: 'daily-asia-shanghai' as const,
    maxRequests: 2, maxInputTokens: 100_000, maxOutputTokens: 100,
    maxOutputTokensPerRequest: 10 }

  function fixture(primaryResult: ModelJsonResult<unknown> = timeout, maxRequests = 2) {
    const reservations = new Map<string, { id: string; settled: boolean }>()
    const reserve = vi.fn<ProviderBudgetStore['reserve']>(async request => {
      const identity = JSON.stringify([request.key, request.kind, request.requestKey])
      if (reservations.has(identity)) return { ok: false, dimension: 'text_requests', reason: 'provider_result_unknown' }
      if (reservations.size >= request.maxRequests) return { ok: false, dimension: 'text_requests',
        retryAt: new Date('2030-01-02T16:00:00Z') }
      const id = `reservation-${reservations.size + 1}`
      reservations.set(identity, { id, settled: false })
      return { ok: true, reservationId: id }
    })
    const settle = vi.fn<ProviderBudgetStore['settle']>(async id => {
      const row = [...reservations.values()].find(row => row.id === id)!
      row.settled = true
    })
    const store = { reserve, settle }
    const primary = { generateJson: vi.fn(async () => primaryResult) } as TextGenerator
    const fallback = { generateJson: vi.fn(async () => success) } as TextGenerator
    const wrap = (provider: TextGenerator) => withTextProviderBudget(provider, store, { ...limits, maxRequests })
    return { reservations, store, primary, fallback, wrap,
      generator: withTimeoutFallback(wrap(primary), wrap(fallback)) }
  }

  test('timeout keeps primary reserved and independently settles fallback in the shared daily pool', async () => {
    const f = fixture()
    const request = { ...input({}), requestKey: 'extraction:run-1:candidate_extract' }
    const result = await f.generator.generateJson(request)
    expect(result).toMatchObject({ ...success, budgetReservationId: 'reservation-2',
      timeoutFallback: { primary: { code: 'http_error', detail: 'timeout',
        budgetReservationId: 'reservation-1', billingUncertain: true } } })
    expect([...f.reservations.values()]).toEqual([
      { id: 'reservation-1', settled: false }, { id: 'reservation-2', settled: true },
    ])
    const [primaryReservation, fallbackReservation] = f.store.reserve.mock.calls.map(([value]) => value)
    expect(primaryReservation.requestKey).toBe(request.requestKey)
    expect(fallbackReservation.requestKey).toBeTruthy()
    expect(fallbackReservation.requestKey).not.toBe(request.requestKey)
    for (const reservation of [primaryReservation, fallbackReservation]) {
      expect(reservation).toMatchObject({ key: 'shared-daily', window: 'daily-asia-shanghai', maxRequests: 2 })
    }
    expect(f.store.settle).toHaveBeenCalledExactlyOnceWith('reservation-2', { inputTokens: 7, outputTokens: 3 })
  })

  test('replay after a timeout/fallback pair makes neither remote request again', async () => {
    const f = fixture()
    const request = { ...input({}), requestKey: 'extraction:run-1:candidate_extract' }
    expect((await f.generator.generateJson(request)).ok).toBe(true)
    await expect(f.generator.generateJson(request)).resolves.toMatchObject({ ok: false, code: 'provider_result_unknown' })
    expect(f.primary.generateJson).toHaveBeenCalledTimes(1)
    expect(f.fallback.generateJson).toHaveBeenCalledTimes(1)
    expect(f.reservations.size).toBe(2)
  })

  test('fallback identity is stable across reconstructed routers and its settled replay is blocked', async () => {
    const f = fixture()
    const request = { ...input({}), requestKey: 'extraction:run-1:candidate_extract' }
    // Allow the timeout twice to exercise the fallback guard independently.
    const router = () => withTimeoutFallback(f.primary, f.wrap(f.fallback))
    expect((await router().generateJson(request)).ok).toBe(true)
    await expect(router().generateJson(request)).resolves.toMatchObject({ ok: false, code: 'provider_result_unknown' })
    expect(f.fallback.generateJson).toHaveBeenCalledTimes(1)
    expect(f.reservations.size).toBe(1)
  })

  test('primary timeout consumes the last shared request, so fallback is budget blocked', async () => {
    const f = fixture(timeout, 1)
    await expect(f.generator.generateJson({ ...input({}), requestKey: 'last-request' }))
      .resolves.toMatchObject({ ok: false, code: 'budget_exceeded', detail: 'text_requests',
        retryAt: '2030-01-02T16:00:00.000Z', timeoutFallback: { primary: { billingUncertain: true } } })
    expect(f.fallback.generateJson).not.toHaveBeenCalled()
    expect([...f.reservations.values()]).toEqual([{ id: 'reservation-1', settled: false }])
  })

  test.each([
    { ok: false as const, code: 'http_error' as const, detail: 'http_status_500', retryable: true },
    { ok: false as const, code: 'aborted' as const, retryable: false },
    success,
  ])('does not make a fallback request when primary returns $code / $ok', async result => {
    const f = fixture(result)
    await f.generator.generateJson({ ...input({}), requestKey: 'no-timeout' })
    expect(f.fallback.generateJson).not.toHaveBeenCalled()
    expect(f.reservations.size).toBe(1)
  })

  test('no primary budget means no remote requests or fallback reservation', async () => {
    const f = fixture(timeout, 0)
    await expect(f.generator.generateJson({ ...input({}), requestKey: 'no-budget' }))
      .resolves.toMatchObject({ ok: false, code: 'budget_exceeded' })
    expect(f.primary.generateJson).not.toHaveBeenCalled()
    expect(f.fallback.generateJson).not.toHaveBeenCalled()
    expect(f.store.reserve).toHaveBeenCalledTimes(1)
  })

  test('caller cancellation during primary timeout prevents fallback', async () => {
    const f = fixture()
    const controller = new AbortController()
    vi.mocked(f.primary.generateJson).mockImplementation(async () => {
      controller.abort()
      return timeout
    })
    await expect(f.generator.generateJson({ ...input({}, controller.signal), requestKey: 'cancelled' }))
      .resolves.toMatchObject(timeout)
    expect(f.fallback.generateJson).not.toHaveBeenCalled()
    expect(f.store.reserve).toHaveBeenCalledTimes(1)
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
