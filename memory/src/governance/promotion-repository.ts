import { randomUUID } from 'crypto'
import type pg from 'pg'

import type {
  PromotionCandidateRow,
  PromotionCandidateVersionRow,
  ReviewDecisionRow,
} from './types.js'
import { loadEffectiveReviewPolicySnapshot } from './review-policy.js'

/**
 * Read-side and revision-side access for promotion candidates. Every query is
 * installation-fenced; proposal revisions are immutable rows appended by the
 * promotion service inside its own transaction.
 */

function toCandidate(row: Record<string, unknown>): PromotionCandidateRow {
  return {
    candidate_id: String(row.candidate_id),
    target_installation_id: String(row.target_installation_id),
    source_installation_id: String(row.source_installation_id),
    source_scope_kind: row.source_scope_kind as 'personal' | 'team',
    source_claim_id: String(row.source_claim_id),
    source_version_id: String(row.source_version_id),
    source_content_hash: String(row.source_content_hash),
    target_claim_type: String(row.target_claim_type),
    scope_kind: String(row.scope_kind),
    scope_key: String(row.scope_key),
    normalized_key: String(row.normalized_key),
    state: row.state as PromotionCandidateRow['state'],
    conflict_group_id: row.conflict_group_id === null ? null : String(row.conflict_group_id),
    duplicate_of_claim_id: row.duplicate_of_claim_id === null ? null : String(row.duplicate_of_claim_id),
    expires_at: row.expires_at as Date,
    revision: Number(row.revision),
    created_by_membership_id: row.created_by_membership_id === null ? null : String(row.created_by_membership_id),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  }
}

export function createPromotionRepository(pool: pg.Pool) {
  return {
    async getCandidate(
      targetInstallationId: string,
      candidateId: string,
    ): Promise<PromotionCandidateRow | null> {
      const result = await pool.query(`
        SELECT * FROM memory_promotion_candidates
        WHERE target_installation_id = $1 AND candidate_id = $2
      `, [targetInstallationId, candidateId])
      return result.rows[0] ? toCandidate(result.rows[0]) : null
    },

    async listQueue(targetInstallationId: string, states?: string[]): Promise<PromotionCandidateRow[]> {
      const result = await pool.query(`
        SELECT * FROM memory_promotion_candidates
        WHERE target_installation_id = $1
          AND ($2::text[] IS NULL OR state = ANY($2::text[]))
        ORDER BY created_at ASC, candidate_id ASC
        LIMIT 100
      `, [targetInstallationId, states && states.length > 0 ? states : null])
      return result.rows.map(toCandidate)
    },

    async getLatestRevision(candidateId: string): Promise<PromotionCandidateVersionRow | null> {
      const result = await pool.query(`
        SELECT * FROM memory_promotion_candidate_versions
        WHERE candidate_id = $1
        ORDER BY revision_number DESC
        LIMIT 1
      `, [candidateId])
      return result.rows[0] as unknown as PromotionCandidateVersionRow | null
    },

    async listEvidence(candidateRevisionId: string): Promise<Array<{
      ordinal: number
      evidence_kind: string
      excerpt: string
      excerpt_hash: string
      occurred_at: Date | null
    }>> {
      const result = await pool.query(`
        SELECT ordinal, evidence_kind, excerpt, excerpt_hash, occurred_at
        FROM memory_promotion_evidence
        WHERE candidate_revision_id = $1
        ORDER BY ordinal ASC
      `, [candidateRevisionId])
      return result.rows.map(row => ({
        ordinal: Number(row.ordinal),
        evidence_kind: String(row.evidence_kind),
        excerpt: String(row.excerpt),
        excerpt_hash: String(row.excerpt_hash),
        occurred_at: row.occurred_at,
      }))
    },

    async listDecisions(candidateRevisionId: string): Promise<ReviewDecisionRow[]> {
      const result = await pool.query(`
        SELECT * FROM memory_review_decisions
        WHERE candidate_revision_id = $1
        ORDER BY created_at ASC
      `, [candidateRevisionId])
      return result.rows as unknown as ReviewDecisionRow[]
    },

    /** Active incumbents that the publisher may explicitly supersede. */
    async listConflictClaims(
      targetInstallationId: string,
      candidate: Pick<PromotionCandidateRow,
        'target_claim_type' | 'scope_key' | 'normalized_key' | 'conflict_group_id'>,
    ): Promise<Array<{ claim_id: string; statement: string; conflict_variant: number }>> {
      const result = await pool.query<{
        claim_id: string
        statement: string
        conflict_variant: string | number
      }>(`
        SELECT c.claim_id::text, v.statement, c.conflict_variant
        FROM knowledge_claims c
        JOIN knowledge_versions v ON v.version_id = c.current_version_id
          AND v.installation_id = c.installation_id
        WHERE c.installation_id = $1 AND c.state = 'active'
          AND c.claim_type = $2 AND c.scope_key = $3 AND c.normalized_key = $4
          AND (c.conflict_group_id IS NULL OR c.conflict_group_id = $5)
        ORDER BY c.conflict_variant ASC, c.claim_id ASC
        LIMIT 100
      `, [targetInstallationId, candidate.target_claim_type, candidate.scope_key,
        candidate.normalized_key, candidate.conflict_group_id])
      return result.rows.map(row => ({
        claim_id: row.claim_id,
        statement: row.statement,
        conflict_variant: Number(row.conflict_variant),
      }))
    },

    /** Append an immutable proposal revision (edit creates revision N+1). */
    async appendRevision(input: {
      targetInstallationId: string
      candidateId: string
      expectedRevision: number
      statement: string
      structuredContent: Record<string, unknown>
      contentHash: string
      createdByMembershipId: string | null
    }): Promise<{ candidateRevisionId: string; revisionNumber: number }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const locked = await client.query<{ state: string; revision: string | number }>(`
          SELECT state, revision FROM memory_promotion_candidates
          WHERE target_installation_id = $1 AND candidate_id = $2 FOR UPDATE
        `, [input.targetInstallationId, input.candidateId])
        const row = locked.rows[0]
        if (!row) throw new Error('candidate not found')
        if (Number(row.revision) !== input.expectedRevision) throw new Error('candidate revision mismatch')
        if (!['proposed', 'changes_requested', 'conflict'].includes(row.state)) {
          throw new Error(`candidate state ${row.state} is not editable`)
        }
        const next = await client.query<{ next: string }>(`
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
          FROM memory_promotion_candidate_versions WHERE candidate_id = $1
        `, [input.candidateId])
        // Editing is the explicit rebind point after either the Team or its
        // parent Organization policy changes. The new immutable revision
        // snapshots the currently effective pair of policy heads.
        const policySnapshot = await loadEffectiveReviewPolicySnapshot(
          client,
          input.targetInstallationId,
          { ensure: true },
        )
        const inserted = await client.query<{ candidate_revision_id: string }>(`
          INSERT INTO memory_promotion_candidate_versions
            (candidate_revision_id, candidate_id, revision_number, statement,
             structured_content, content_hash, review_policy_version_id,
             parent_review_policy_version_id, created_by_membership_id)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
          RETURNING candidate_revision_id
        `, [
          randomUUID(), input.candidateId, Number(next.rows[0].next),
          input.statement, JSON.stringify(input.structuredContent), input.contentHash,
          policySnapshot.activeVersionId, policySnapshot.parentActiveVersionId,
          input.createdByMembershipId,
        ])
        await client.query(`
          UPDATE memory_promotion_candidates
          SET revision = revision + 1,
              state = CASE WHEN state = 'changes_requested' THEN 'proposed' ELSE state END,
              updated_at = NOW()
          WHERE target_installation_id = $1 AND candidate_id = $2 AND revision = $3
        `, [input.targetInstallationId, input.candidateId, input.expectedRevision])
        await client.query('COMMIT')
        return {
          candidateRevisionId: inserted.rows[0].candidate_revision_id,
          revisionNumber: Number(next.rows[0].next),
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async withdraw(input: {
      targetInstallationId: string
      candidateId: string
      expectedRevision: number
      actorMembershipId: string | null
      actorIsScopeAdmin: boolean
    }): Promise<{ state: 'withdrawn'; revision: number }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const locked = await client.query<{
          state: string
          revision: string | number
          created_by_membership_id: string | null
        }>(`
          SELECT state, revision, created_by_membership_id
          FROM memory_promotion_candidates
          WHERE target_installation_id = $1 AND candidate_id = $2 FOR UPDATE
        `, [input.targetInstallationId, input.candidateId])
        const row = locked.rows[0]
        if (!row) throw new Error('candidate not found')
        if (Number(row.revision) !== input.expectedRevision) throw new Error('candidate revision mismatch')
        if (!input.actorIsScopeAdmin && row.created_by_membership_id !== input.actorMembershipId) {
          throw new Error('candidate withdraw forbidden')
        }
        if (!['proposed', 'changes_requested', 'approved', 'conflict'].includes(row.state)) {
          throw new Error(`candidate state ${row.state} is not withdrawable`)
        }
        const updated = await client.query<{ revision: string | number }>(`
          UPDATE memory_promotion_candidates
          SET state = 'withdrawn', revision = revision + 1, updated_at = NOW()
          WHERE target_installation_id = $1 AND candidate_id = $2 AND revision = $3
          RETURNING revision
        `, [input.targetInstallationId, input.candidateId, input.expectedRevision])
        await client.query('COMMIT')
        return { state: 'withdrawn', revision: Number(updated.rows[0].revision) }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export type PromotionRepository = ReturnType<typeof createPromotionRepository>
