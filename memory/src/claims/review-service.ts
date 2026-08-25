import type pg from 'pg'
import type { ClaimRepository } from './repository.js'
import { resolvePacketEvidence } from './evidence-resolver.js'

/**
 * Review workflow facade: accept as-is, accept with correction, reject. All
 * authorization is upstream (REST `memory.manage` in Task 10); this service
 * only executes ledger transactions with CAS revisions.
 */
export function createReviewService(pool: pg.Pool, claims: ClaimRepository) {
  return {
    async acceptCandidate(input: {
      installationId: string
      candidateId: string
      expectedRevision: number
      editedStatement?: string
    }) {
      return claims.acceptCandidate(input)
    },

    async rejectCandidate(input: {
      installationId: string
      candidateId: string
      expectedRevision: number
      reasonCode?: string
    }) {
      return claims.rejectCandidate(input)
    },

    /** Review queue: validated/conflict candidates only; shadow excluded. */
    async reviewQueue(input: { installationId: string; limit?: number }) {
      const limit = Math.min(Math.max(1, input.limit ?? 50), 100)
      const result = await pool.query(`
        SELECT c.candidate_id::text, c.claim_type, c.statement, c.structured_content,
               c.scope_kind, c.scope_key,
               c.confidence::text, c.freshness_at, c.status, c.revision::text, c.episode_id::text,
               c.repository_id::text, c.repo_snapshot_id::text, c.branch, c.evidence_handles,
               c.duplicate_of_claim_id::text, c.created_at,
               e.document AS episode_document, e.evidence_manifest
        FROM memory_candidates c
        JOIN work_episodes e
          ON e.installation_id = c.installation_id AND e.episode_id = c.episode_id
        WHERE c.installation_id = $1 AND c.status IN ('validated', 'conflict')
        ORDER BY c.created_at DESC, c.candidate_id
        LIMIT $2
      `, [input.installationId, limit])
      return result.rows.map(row => ({
        ...row,
        evidence: resolvePacketEvidence(
          row.episode_document,
          row.evidence_manifest,
          Array.isArray(row.evidence_handles)
            ? row.evidence_handles.filter((handle: unknown): handle is string => typeof handle === 'string')
            : [],
        ).map(item => ({ handle: item.handle, excerpt: item.excerpt })),
        episode_document: undefined,
        evidence_manifest: undefined,
      }))
    },
  }
}

export type ReviewService = ReturnType<typeof createReviewService>
