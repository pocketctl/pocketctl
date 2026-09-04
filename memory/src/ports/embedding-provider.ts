/**
 * Phase 1 port: embedding vectors for claim indexing and recall queries.
 * Adapters compare only vectors of the same provider/model/dimension; a
 * mismatch is a hard error, never a silent cross-model comparison.
 */

export type EmbeddingOperation = 'claim_index' | 'recall_query'

export interface EmbeddingResult {
  vectors: number[][]
  model: string
  tokens: number
  costMicros?: number
}

export interface EmbeddingProvider {
  readonly dimensions: number
  embed(input: {
    operation: EmbeddingOperation
    texts: string[]
    signal: AbortSignal
  }): Promise<EmbeddingResult>
}
