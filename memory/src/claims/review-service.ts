import {candidateReviewHash} from './review-hash.js'
import type pg from 'pg'
import type { ClaimRepository } from './repository.js'
import { parseAcceptedDeliveryProvenance } from '../episodes/accepted-delivery-source.js'
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
      expectedHash?:string
      reviewDurationMs?:number
      expectedRevision: number
      editedStatement?: string
    }) {
      return claims.acceptCandidate(input)
    },

    async rejectCandidate(input: {
      installationId: string
      candidateId: string
      expectedHash?:string
      reviewDurationMs?:number
      expectedRevision: number
      reasonCode?: string
    }) {
      return claims.rejectCandidate(input)
    },

    /** Review queue: validated/conflict candidates only; shadow excluded. */
    async reviewQueue(input: { installationId: string; limit?: number; submissionId?: string; decisionId?: string }) {
      const limit = Math.min(Math.max(1, input.limit ?? 50), 100)
      const result = await pool.query(`
        SELECT c.candidate_id::text, c.claim_type, c.statement, c.structured_content,
               c.scope_kind, c.scope_key,
               c.confidence::text, c.freshness_at, c.status, c.revision::text, c.episode_id::text,
               c.repository_id::text, c.repo_snapshot_id::text, c.branch, c.evidence_handles,
               c.duplicate_of_claim_id::text, c.created_at, c.review_expires_at, c.validation,
               e.document AS episode_document, e.evidence_manifest,
               e.summary->'references'->'source' AS episode_source,
               memory_delivery_source_available(e.summary->'references'->'source') AS source_available
        FROM memory_candidates c
        JOIN work_episodes e
          ON e.installation_id = c.installation_id AND e.episode_id = c.episode_id
        JOIN memory_extraction_runs r
          ON r.installation_id = c.installation_id AND r.run_id = c.run_id
        WHERE c.installation_id = $1 AND c.status IN ('validated', 'conflict')
          AND c.review_expires_at>clock_timestamp()
          AND ($3::jsonb IS NULL OR e.summary->'references'->'source' @> $3::jsonb)
          AND r.episode_source_digest = e.source_digest
          AND NOT EXISTS (SELECT 1 FROM memory_feed_inbox gap
            WHERE gap.installation_id=e.installation_id AND gap.session_id=e.session_id
              AND gap.error_code='oversized_content' AND gap.projection_state='quarantined'
              AND (gap.turn_id IS NULL OR gap.turn_id=e.turn_id))
        ORDER BY c.created_at DESC, c.candidate_id
        LIMIT $2
      `, [input.installationId, limit, input.submissionId && input.decisionId ? JSON.stringify({ source_kind: 'team_session', source_version: 2, accepted_delivery: { submission_id: input.submissionId, decision_id: input.decisionId } }) : null])
      return result.rows.map(row => ({
        content_hash:candidateReviewHash(row),
        ...row,
        delivery_source: candidateDeliverySource(row.episode_source, row.source_available),
        evidence: resolvePacketEvidence(
          row.episode_document,
          row.evidence_manifest,
          Array.isArray(row.evidence_handles)
            ? row.evidence_handles.filter((handle: unknown): handle is string => typeof handle === 'string')
            : [],
        ).map(item => ({ handle: item.handle, excerpt: item.excerpt })),
        episode_source: undefined,
        source_available: undefined,
        episode_document: undefined,
        evidence_manifest: undefined,
      }))
    },
  }
}

export type ReviewService = ReturnType<typeof createReviewService>

/** Public review metadata is reconstructed, never spread from model content or reader grants. */
export function candidateDeliverySource(value: unknown, available: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (source.source_kind !== 'team_session' || source.source_version !== 2) return null
  const delivery = parseAcceptedDeliveryProvenance(source.accepted_delivery)
  if (!delivery) return null
  return {
    task_id: delivery.task_id, spec_revision: delivery.spec_revision,
    submission_id: delivery.submission_id, submission_version: delivery.submission_version,
    decision_id: delivery.decision_id, accepted_at: delivery.accepted_at,
    state: available === true ? 'available' as const : 'withdrawn' as const,
  }
}
