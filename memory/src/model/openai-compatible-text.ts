import { createModelHttpClient, ModelHttpError } from './http.js'
import type {
  JsonSchema,
  ModelJsonResult,
  ModelUsage,
  TextGenerator,
  TextGeneratorOperation,
} from '../ports/text-generator.js'

export interface OpenAICompatibleTextOptions {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  maxResponseBytes?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  inputCostMicrosPerMillionTokens?: number
  outputCostMicrosPerMillionTokens?: number
  maxOutputTokens?: number
  maxAttempts?: number
  thinking?: 'enabled' | 'disabled'
}

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  model?: unknown
}

const MAX_PROVIDER_TOKENS = 1_000_000_000

/**
 * `openai-compatible` chat-completions adapter. JSON-mode output only; the
 * document travels as quoted user content and the schema is summarized in the
 * system prompt contract — deeper validation is the caller's Zod stage.
 * Errors surface bounded codes without URL, key, or body material.
 */
export function createOpenAICompatibleTextGenerator(options: OpenAICompatibleTextOptions): TextGenerator {
  const client = createModelHttpClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    maxAttempts: options.maxAttempts,
  })

  return {
    async generateJson<T>(input: {
      operation: TextGeneratorOperation
      system: string
      document: unknown
      schema: JsonSchema
      timeoutMs: number
      signal: AbortSignal
    }): Promise<ModelJsonResult<T>> {
      let payload: unknown
      try {
        payload = await client.postJson('/chat/completions', {
          model: options.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: JSON.stringify(input.document) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking } }),
          ...(options.maxOutputTokens === undefined ? {} : { max_tokens: options.maxOutputTokens }),
        }, { signal: input.signal, timeoutMs: input.timeoutMs })
      } catch (error) {
        if (error instanceof ModelHttpError) {
          if (input.signal.aborted) {
            return { ok: false, code: 'aborted', retryable: false }
          }
          return {
            ok: false,
            code: 'http_error',
            retryable: error.retryable,
            detail: error.code,
          }
        }
        return { ok: false, code: 'http_error', retryable: false, detail: 'unknown' }
      }

      const completion = payload as ChatCompletionPayload
      const content = completion.choices?.[0]?.message?.content
      const usage = completionUsage(
        completion,
        options.model,
        options.inputCostMicrosPerMillionTokens ?? 0,
        options.outputCostMicrosPerMillionTokens ?? 0,
      )
      if (!usage) {
        return { ok: false, code: 'invalid_usage', retryable: false, detail: 'invalid_usage' }
      }
      if (typeof content !== 'string' || content.length === 0) {
        return { ok: false, code: 'empty_content', retryable: false, usage }
      }
      try {
        return {
          ok: true,
          value: JSON.parse(content) as T,
          usage,
        }
      } catch {
        return { ok: false, code: 'invalid_json', retryable: false, usage }
      }
    },
  }
}

function completionUsage(
  completion: ChatCompletionPayload,
  fallbackModel: string,
  inputRate: number,
  outputRate: number,
): ModelUsage | null {
  const inputTokens = boundedCounter(completion.usage?.prompt_tokens)
  const outputTokens = boundedCounter(completion.usage?.completion_tokens)
  if (inputTokens === null || outputTokens === null) return null
  return {
    inputTokens,
    outputTokens,
    model: typeof completion.model === 'string' && completion.model.length <= 128
      ? completion.model
      : fallbackModel,
    costMicros: tokenCostMicros(
      inputTokens,
      outputTokens,
      inputRate,
      outputRate,
    ),
  }
}

export function tokenCostMicros(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number {
  return Math.round((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000)
}

function boundedCounter(value: unknown): number | null {
  if (value === undefined) return 0
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= MAX_PROVIDER_TOKENS
    ? value
    : null
}
