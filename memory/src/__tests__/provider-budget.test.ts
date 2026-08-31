import { describe, expect, test, vi } from 'vitest'
import {
  ProviderBudgetExceededError,
  withEmbeddingProviderBudget,
  withTextProviderBudget,
  type ProviderBudgetStore,
} from '../model/provider-budget.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import type { TextGenerator } from '../ports/text-generator.js'

describe('provider budget guard', () => {
  test('hard rejection happens before any provider request', async () => {
    const store: ProviderBudgetStore = {
      reserve: vi.fn(async () => ({ ok: false as const, dimension: 'text_output_tokens' as const })),
      settle: vi.fn(async () => undefined),
    }
    const generateJson = vi.fn(async () => ({
      ok: true as const,
      value: {},
      usage: { inputTokens: 1, outputTokens: 1, model: 'm' },
    }))
    const guarded = withTextProviderBudget({ generateJson } as TextGenerator, store, {
      key: 'pilot', maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 10,
      maxOutputTokensPerRequest: 10,
    })
    const result = await guarded.generateJson({
      operation: 'candidate_extract', system: 'system', document: { task: 'x' }, schema: {},
      timeoutMs: 1000, signal: new AbortController().signal,
    })
    expect(result).toEqual({ ok: false, code: 'budget_exceeded', retryable: false, detail: 'text_output_tokens' })
    expect(generateJson).not.toHaveBeenCalled()
    expect(store.settle).not.toHaveBeenCalled()
  })

  test('settles provider-reported usage after a successful request', async () => {
    const store: ProviderBudgetStore = {
      reserve: vi.fn(async () => ({ ok: true as const, reservationId: 'r1' })),
      settle: vi.fn(async () => undefined),
    }
    const generateJson = vi.fn(async () => ({
      ok: true as const,
      value: {},
      usage: { inputTokens: 7, outputTokens: 3, model: 'm' },
    }))
    const guarded = withTextProviderBudget({ generateJson } as TextGenerator, store, {
      key: 'pilot', maxRequests: 2, maxInputTokens: 100, maxOutputTokens: 20,
      maxOutputTokensPerRequest: 10,
    })
    await guarded.generateJson({
      operation: 'candidate_extract', system: 's', document: {}, schema: {},
      timeoutMs: 1000, signal: new AbortController().signal,
    })
    expect(store.settle).toHaveBeenCalledWith('r1', { inputTokens: 7, outputTokens: 3 })
  })

  test('a budget-store outage fails closed before the provider', async () => {
    const store: ProviderBudgetStore = {
      reserve: vi.fn(async () => { throw new Error('database unavailable') }),
      settle: vi.fn(async () => undefined),
    }
    const generateJson = vi.fn()
    const guarded = withTextProviderBudget({ generateJson } as TextGenerator, store, {
      key: 'pilot', maxRequests: 1, maxInputTokens: 100, maxOutputTokens: 10,
      maxOutputTokensPerRequest: 10,
    })
    await expect(guarded.generateJson({
      operation: 'candidate_extract', system: 's', document: {}, schema: {},
      timeoutMs: 1000, signal: new AbortController().signal,
    })).resolves.toEqual({ ok: false, code: 'budget_unavailable', retryable: true, detail: 'reservation_failed' })
    expect(generateJson).not.toHaveBeenCalled()
  })

  test('embedding budget rejection also happens before the provider', async () => {
    const store: ProviderBudgetStore = {
      reserve: vi.fn(async () => ({ ok: false as const, dimension: 'embedding_tokens' as const })),
      settle: vi.fn(async () => undefined),
    }
    const embed = vi.fn()
    const guarded = withEmbeddingProviderBudget({ dimensions: 3, embed } as EmbeddingProvider, store, {
      key: 'pilot', maxRequests: 2, maxTokens: 10,
    })
    await expect(guarded.embed({
      operation: 'recall_query', texts: ['query'], signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<ProviderBudgetExceededError>>({
      code: 'budget_exceeded', dimension: 'embedding_tokens',
    }))
    expect(embed).not.toHaveBeenCalled()
  })
})
