import type pg from 'pg'
import type {
  ClaimVector,
  VectorHit,
  VectorIndex,
  VectorSearch,
} from '../ports/vector-index.js'

/**
 * PostgreSQL exact-vector index behind the VectorIndex port (ADR-P1-04).
 * Comparisons stay within one (provider, model, dimensions) family; vectors
 * are L2-normalized on write so cosine similarity reduces to a dot product.
 */
export function createPostgresVectorIndex(pool: pg.Pool): VectorIndex {
  return {
    async upsert(input: ClaimVector): Promise<void> {
      const vector = normalize(input.vector)
      if (vector.length !== input.dimensions) {
        throw new Error(`vector dimension mismatch: expected ${input.dimensions}, got ${vector.length}`)
      }
      await pool.query(`
        UPDATE claim_search_documents SET
          embedding = $3::real[],
          embedding_provider = $4,
          embedding_model = $5,
          embedding_dimensions = $6,
          embedding_status = 'ready',
          indexed_at = NOW()
        WHERE installation_id = $1 AND version_id = $2
      `, [
        input.installationId, input.versionId,
        vector, input.provider, input.model, input.dimensions,
      ])
    },

    async search(input: VectorSearch): Promise<VectorHit[]> {
      const query = normalize(input.vector)
      if (query.length !== input.dimensions) {
        throw new Error(`query dimension mismatch: expected ${input.dimensions}, got ${query.length}`)
      }
      const candidateFilter = input.candidateVersionIds && input.candidateVersionIds.length > 0
        ? 'AND version_id = ANY($6::uuid[])'
        : ''
      const limitPlaceholder = candidateFilter ? '$7' : '$6'
      // Plain-SQL cosine: both sides are L2-normalized, so the dot product
      // over unnest pairs IS the similarity — pgvector stays out (ADR-P1-04).
      const result = await pool.query<{ version_id: string; score: string }>(`
        SELECT version_id::text,
               (SELECT COALESCE(sum(pair.a * pair.b), 0)
                FROM unnest(embedding, $3::real[]) AS pair(a, b)) AS score
        FROM claim_search_documents
        WHERE installation_id = $1
          AND embedding_provider = $2
          AND embedding_model = $4
          AND embedding_dimensions = $5
          AND embedding_status = 'ready'
          ${candidateFilter}
        ORDER BY score DESC, version_id
        LIMIT ${limitPlaceholder}
      `, candidateFilter
        ? [input.installationId, input.provider, query, input.model, input.dimensions,
            [...(input.candidateVersionIds ?? [])], Math.min(Math.max(1, input.limit), 200)]
        : [input.installationId, input.provider, query, input.model, input.dimensions,
            Math.min(Math.max(1, input.limit), 200)])
      return result.rows.map(row => ({
        versionId: row.version_id,
        score: Number(row.score),
      }))
    },

    async deleteVersion(installationId: string, versionId: string): Promise<void> {
      await pool.query(`
        DELETE FROM claim_search_documents
        WHERE installation_id = $1 AND version_id = $2
      `, [installationId, versionId])
    },
  }
}

/** L2 normalization; a zero vector stays zero (never NaN). */
export function normalize(vector: readonly number[]): number[] {
  let scale = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('vector values must be finite')
    scale = Math.max(scale, Math.abs(value))
  }
  if (scale === 0) return vector.map(() => 0)
  const scaledMagnitude = Math.sqrt(vector.reduce((sum, value) => {
    const scaled = value / scale
    return sum + scaled * scaled
  }, 0))
  return vector.map(value => (value / scale) / scaledMagnitude)
}
