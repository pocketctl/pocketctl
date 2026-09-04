import { createModelHttpClient } from './http.js'
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../ports/embedding-provider.js'

export interface OpenAICompatibleEmbeddingOptions {
  baseUrl: string
  model: string
  apiKey: string
  dimensions: number
  timeoutMs: number
  maxResponseBytes?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  inputCostMicrosPerMillionTokens?: number
  maxAttempts?: number
}

interface EmbeddingsPayload {
  data?: Array<{ index?: unknown; embedding?: unknown }>
  usage?: { prompt_tokens?: unknown }
  model?: unknown
}

const MAX_PROVIDER_TOKENS = 1_000_000_000

/**
 * `openai-compatible` embeddings adapter. The adapter refuses vector sets
 * whose count, dimension, or element finiteness does not match its
 * configured contract — a mismatch can never corrupt cross-model ranking.
 */
export function createOpenAICompatibleEmbeddingProvider(
  options: OpenAICompatibleEmbeddingOptions,
): EmbeddingProvider {
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
    dimensions: options.dimensions,
    async embed(input: {
      operation: 'claim_index' | 'recall_query'
      texts: string[]
      signal: AbortSignal
    }): Promise<EmbeddingResult> {
      const payload = await client.postJson('/embeddings', {
        model: options.model,
        input: input.texts,
      }, { signal: input.signal }) as EmbeddingsPayload

      const data = Array.isArray(payload.data) ? payload.data : []
      if (data.length !== input.texts.length) {
        throw new EmbeddingContractError(
          `embedding count mismatch: expected ${input.texts.length}, received ${data.length}`,
        )
      }
      const vectors: number[][] = new Array(input.texts.length)
      for (const entry of data) {
        const index = entry.index
        if (typeof index !== 'number' || !Number.isInteger(index)
          || index < 0 || index >= input.texts.length || vectors[index] !== undefined) {
          throw new EmbeddingContractError('embedding entry index is invalid')
        }
        const embedding = entry.embedding
        if (!Array.isArray(embedding) || embedding.length !== options.dimensions) {
          throw dimensionError(embedding, options.dimensions)
        }
        const vector: number[] = []
        for (const element of embedding) {
          if (typeof element !== 'number' || !Number.isFinite(element)) {
            throw new EmbeddingContractError('embedding contains a non-finite element')
          }
          vector.push(element)
        }
        vectors[index] = vector
      }
      for (const vector of vectors) {
        if (vector === undefined) {
          throw new EmbeddingContractError('embedding set is incomplete')
        }
      }
      const rawTokens = payload.usage?.prompt_tokens
      if (rawTokens !== undefined && (typeof rawTokens !== 'number'
        || !Number.isSafeInteger(rawTokens) || rawTokens < 0
        || rawTokens > MAX_PROVIDER_TOKENS)) {
        throw new EmbeddingContractError('embedding usage is invalid')
      }
      const tokens = rawTokens ?? 0
      return {
        vectors,
        model: typeof payload.model === 'string' ? payload.model : options.model,
        tokens,
        costMicros: Math.round(tokens * (options.inputCostMicrosPerMillionTokens ?? 0) / 1_000_000),
      }
    },
  }
}

class EmbeddingContractError extends Error {
  readonly code = 'invalid_response'
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingContractError'
  }
}

function dimensionError(embedding: unknown, dimensions: number): Error {
  const actual = Array.isArray(embedding) ? embedding.length : 'non-array'
  return new EmbeddingContractError(
    `embedding dimension mismatch: expected ${dimensions}, received ${actual}`,
  )
}
