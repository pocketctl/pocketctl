import { describe, expect, test, vi } from 'vitest'
import { createOpenAICompatibleTextGenerator } from '../model/openai-compatible-text.js'
import { createOpenAICompatibleEmbeddingProvider } from '../model/openai-compatible-embedding.js'
import { ModelHttpError } from '../model/http.js'

const TEXT_OPTIONS = {
  baseUrl: 'https://api.model.example/v1',
  model: 'extractor-small',
  apiKey: 'secret-text-key',
  timeoutMs: 5_000,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function chatCompletion(content: string, usage = { prompt_tokens: 11, completion_tokens: 7 }) {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    model: 'extractor-small',
  }
}

describe('openai-compatible text adapter', () => {
  test('parses a JSON completion with usage accounting', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(chatCompletion('{"candidates":[]}')))
    const generator = createOpenAICompatibleTextGenerator({
      ...TEXT_OPTIONS, fetchImpl,
      maxOutputTokens: 4096,
      inputCostMicrosPerMillionTokens: 2_000_000,
      outputCostMicrosPerMillionTokens: 4_000_000,
    })
    const result = await generator.generateJson({
      operation: 'candidate_extract',
      system: 'system prompt',
      document: { episode: 1 },
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      ok: true,
      value: { candidates: [] },
      usage: { inputTokens: 11, outputTokens: 7, model: 'extractor-small', costMicros: 50 },
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(payload.response_format).toEqual({ type: 'json_object' })
    expect(payload.max_tokens).toBe(4096)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer secret-text-key')
    expect(init.redirect).toBe('error')
  })

  test('forwards an explicit disabled thinking mode for bounded JSON output', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(chatCompletion('{"candidates":[]}')))
    const options = { ...TEXT_OPTIONS, fetchImpl, thinking: 'disabled' as const }
    const generator = createOpenAICompatibleTextGenerator(options)

    const result = await generator.generateJson({
      operation: 'candidate_extract',
      system: 'return JSON',
      document: { episode: 1 },
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })

    expect(result.ok).toBe(true)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(payload.thinking).toEqual({ type: 'disabled' })
  })

  test('non-JSON model output is a non-retryable invalid_json result', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(chatCompletion('certainly not json')))
    const generator = createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl })
    const result = await generator.generateJson({
      operation: 'candidate_extract',
      system: 's',
      document: {},
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid_json')
      expect(result.retryable).toBe(false)
      expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 })
    }
  })

  test('rejects unsafe, fractional, negative, and excessive usage counters', async () => {
    for (const promptTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER, 1_000_000_001]) {
      const fetchImpl = vi.fn(async () => jsonResponse({
        ...chatCompletion('{"candidates":[]}'),
        usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
      }))
      const result = await createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl })
        .generateJson({
          operation: 'candidate_extract', system: 's', document: {}, schema: {},
          timeoutMs: 5_000, signal: new AbortController().signal,
        })
      expect(result).toMatchObject({ ok: false, code: 'invalid_usage', retryable: false })
    }
  })

  test('retries rate limits and server errors, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse(chatCompletion('{"ok":true}')))
    const sleep = vi.fn(async () => undefined)
    const generator = createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl, sleep })
    const result = await generator.generateJson({
      operation: 'candidate_repair',
      system: 's',
      document: {},
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  test('permanent client errors fail immediately without retry', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401))
    const sleep = vi.fn(async () => undefined)
    const generator = createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl, sleep })
    const result = await generator.generateJson({
      operation: 'candidate_extract',
      system: 's',
      document: {},
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('http_error')
      expect(result.retryable).toBe(false)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('abort signals terminate the call', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      controller.abort()
      return jsonResponse(chatCompletion('{}'))
    })
    const generator = createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl })
    const result = await generator.generateJson({
      operation: 'candidate_extract',
      system: 's',
      document: {},
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
  })

  test('abort signals interrupt retry backoff immediately', async () => {
    const controller = new AbortController()
    let markSleeping!: () => void
    const sleeping = new Promise<void>(resolve => { markSleeping = resolve })
    const generator = createOpenAICompatibleTextGenerator({
      ...TEXT_OPTIONS,
      fetchImpl: vi.fn(async () => jsonResponse({ error: 'retry' }, 500)),
      sleep: vi.fn(async () => {
        markSleeping()
        await new Promise<void>(() => undefined)
      }),
    })
    const pending = generator.generateJson({
      operation: 'candidate_extract', system: 's', document: {}, schema: {},
      timeoutMs: 5_000, signal: controller.signal,
    })
    await sleeping
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'aborted', retryable: false })
  })

  test('aborting the default retry delay clears its referenced timer', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'retry' }, 500))
      const generator = createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl })
      const pending = generator.generateJson({
        operation: 'candidate_extract', system: 's', document: {}, schema: {},
        timeoutMs: 5_000, signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      controller.abort()
      await expect(pending).resolves.toMatchObject({ ok: false, code: 'aborted' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('error results never leak the api key, url, or response body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'leaky detail with secret-text-key' }, 500))
    const sleep = vi.fn(async () => undefined)
    const generator = createOpenAICompatibleTextGenerator({ ...TEXT_OPTIONS, fetchImpl, sleep })
    const result = await generator.generateJson({
      operation: 'candidate_extract',
      system: 's',
      document: {},
      schema: { type: 'object' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-text-key')
    expect(serialized).not.toContain('api.model.example')
    expect(serialized).not.toContain('leaky detail')
  })
})

describe('openai-compatible embedding adapter', () => {
  const EMBED_OPTIONS = {
    baseUrl: 'https://api.model.example/v1',
    model: 'embed-small',
    apiKey: 'secret-embed-key',
    dimensions: 3,
    timeoutMs: 5_000,
  }

  test('embeds texts and reports usage in input order', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
      usage: { prompt_tokens: 9, total_tokens: 9 },
      model: 'embed-small',
    }))
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...EMBED_OPTIONS, fetchImpl, inputCostMicrosPerMillionTokens: 3_000_000,
    })
    const result = await provider.embed({
      operation: 'claim_index',
      texts: ['first', 'second'],
      signal: new AbortController().signal,
    })
    expect(result.vectors).toEqual([[1, 0, 0], [0, 1, 0]])
    expect(result.model).toBe('embed-small')
    expect(result.tokens).toBe(9)
    expect(result.costMicros).toBe(27)
    expect(provider.dimensions).toBe(3)
  })

  test('count and dimension mismatches are hard errors', async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...EMBED_OPTIONS,
      fetchImpl: vi.fn(async () => jsonResponse({
        data: [{ index: 0, embedding: [1, 0, 0] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
        model: 'embed-small',
      })),
    })
    await expect(provider.embed({
      operation: 'recall_query', texts: ['a', 'b'], signal: new AbortController().signal,
    })).rejects.toThrow(/count/)

    const wrongDimensions = createOpenAICompatibleEmbeddingProvider({
      ...EMBED_OPTIONS,
      fetchImpl: vi.fn(async () => jsonResponse({
        data: [{ index: 0, embedding: [1, 0] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
        model: 'embed-small',
      })),
    })
    await expect(wrongDimensions.embed({
      operation: 'recall_query', texts: ['a'], signal: new AbortController().signal,
    })).rejects.toThrow(/dimension/)
  })

  test('non-finite vector elements are rejected', async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...EMBED_OPTIONS,
      fetchImpl: vi.fn(async () => jsonResponse({
        data: [{ index: 0, embedding: [1, 0, 'oops' as unknown as number] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
        model: 'embed-small',
      })),
    })
    await expect(provider.embed({
      operation: 'recall_query', texts: ['a'], signal: new AbortController().signal,
    })).rejects.toThrow()
  })

  test('rejects unsafe, fractional, negative, and excessive embedding usage counters', async () => {
    for (const promptTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER, 1_000_000_001]) {
      const provider = createOpenAICompatibleEmbeddingProvider({
        ...EMBED_OPTIONS,
        fetchImpl: vi.fn(async () => jsonResponse({
          data: [{ index: 0, embedding: [1, 0, 0] }],
          usage: { prompt_tokens: promptTokens },
          model: 'embed-small',
        })),
      })
      await expect(provider.embed({
        operation: 'recall_query', texts: ['a'], signal: new AbortController().signal,
      })).rejects.toThrow(/usage/)
    }
  })
})

describe('model http error classification', () => {
  test('exposes a stable code and retryability, never the url or key', () => {
    const error = new ModelHttpError({ code: 'rate_limited', status: 429, retryable: true })
    expect(error.code).toBe('rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.message).not.toContain('http')
    expect(String(error.message)).toBeTruthy()
  })
})
