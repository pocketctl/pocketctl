/**
 * Phase 1 port: bounded JSON generation from an untrusted-content-safe model
 * adapter. The model has no tools and no network access through Memory; the
 * document is quoted data, never instructions. Concrete adapters live in
 * `../model/` and must never log prompts, documents, or outputs.
 */

export type TextGeneratorOperation = 'candidate_extract' | 'candidate_repair'

/** A JSON Schema object describing the expected model output shape. */
export type JsonSchema = Record<string, unknown>

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  model: string
  costMicros?: number
}

export type ModelJsonResult<T> =
  | { ok: true; value: T; usage: ModelUsage }
  | {
      ok: false
      code: 'invalid_json' | 'empty_content' | 'invalid_usage' | 'http_error' | 'aborted' | 'budget_exceeded' | 'budget_unavailable'
      retryable: boolean
      /** Bounded machine code only — never raw provider text. */
      detail?: string
      /** Provider-reported content-free usage, when a response was received. */
      usage?: ModelUsage
    }

export interface TextGenerator {
  generateJson<T>(input: {
    operation: TextGeneratorOperation
    system: string
    document: unknown
    schema: JsonSchema
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ModelJsonResult<T>>
}
