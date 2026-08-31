import { randomUUID } from 'crypto'
import type pg from 'pg'

import { currentReviewDecisions, evaluateQuorum } from './authority.js'
import type { ValidatedV2Grant } from './authorization.js'
import { loadEffectiveReviewPolicySnapshot } from './review-policy.js'
import type { PromotionCandidateRow, ReviewDecisionKind } from './types.js'

/**
 * ADR-P3-07 review decisions and the §4.3 publication transaction. Decisions
 * are append-only and bind (candidate_revision, membership, membership_
 * revision); publication re-evaluates every counted decision against the
 * still-active mirror membership, requires the current evidence package and
 * candidate TTL, applies the explicit conflict resolution, and appends the
 * target Claim/Version/Evidence plus authority provenance and the shared
 * index job in ONE fenced transaction. Publication never calls a model.
 */

export type PublicationErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'revision_conflict'
  | 'state_conflict'
  | 'quorum_failed'
  | 'expired'
  | 'evidence_missing'
  | 'invalid_resolution'
  | 'policy_head_changed'

export class PublicationError extends Error {
  readonly code: PublicationErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: PublicationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'PublicationError'
    this.code = code
    this.details = details
  }
}

export interface ReviewDecisionInput {
  grant: ValidatedV2Grant
  targetInstallationId: string
  candidateId: string
  expectedCandidateRevision: number
  decision: ReviewDecisionKind
  reasonCode?: string
}

export interface PublishInput {
  grant: ValidatedV2Grant
  targetInstallationId: string
  candidateId: string
  expectedCandidateRevision: number
  resolution: 'new' | 'parallel' | 'supersede'
  supersedeClaimIds?: string[]
}

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

export function createPublicationService(pool: pg.Pool) {
  return {
    /** Append one review decision; a new candidate revision invalidates nothing retroactively. */
    async decide(input: ReviewDecisionInput): Promise<{ decisionId: string }> {
      const binding = input.grant.scopeBindings.find(
        candidate => candidate.installation_id === input.targetInstallationId)
      if (!binding || !binding.permissions.includes('review')) {
        throw new PublicationError('forbidden', 'review permission required')
      }
      if (!['approve', 'request_changes', 'reject'].includes(input.decision)) {
        throw new PublicationError('state_conflict', 'unknown decision')
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const candidate = await client.query<Record<string, unknown>>(`
          SELECT * FROM memory_promotion_candidates
          WHERE target_installation_id = $1 AND candidate_id = $2 FOR UPDATE
        `, [input.targetInstallationId, input.candidateId])
        const row = candidate.rows[0]
        if (!row) throw new PublicationError('not_found', 'candidate not found')
        if (Number(row.revision) !== input.expectedCandidateRevision) {
          throw new PublicationError('revision_conflict', 'candidate revision mismatch', {
            current_revision: Number(row.revision),
          })
        }
        if (!['proposed', 'changes_requested', 'conflict', 'approved'].includes(String(row.state))) {
          throw new PublicationError('state_conflict', `candidate state ${row.state} is not reviewable`)
        }
        const revision = await client.query<{ candidate_revision_id: string; created_by_membership_id: string | null }>(`
          SELECT candidate_revision_id, created_by_membership_id
          FROM memory_promotion_candidate_versions
          WHERE candidate_id = $1 ORDER BY revision_number DESC LIMIT 1
        `, [input.candidateId])
        const latest = revision.rows[0]
        if (!latest) throw new PublicationError('state_conflict', 'candidate has no revisions')
        const decisionId = randomUUID()
        try {
          await client.query(`
            INSERT INTO memory_review_decisions
              (decision_id, candidate_revision_id, membership_id, membership_revision, decision, reason_code)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            decisionId, latest.candidate_revision_id, binding.membership_id,
            binding.membership_revision, input.decision, input.reasonCode ?? null,
          ])
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new PublicationError('state_conflict', 'membership already decided on this revision')
          }
          throw error
        }
        await client.query(`
          INSERT INTO memory_governance_events
            (event_id, installation_id, actor_membership_id, action, target_kind, target_id,
             previous_state, next_state, metadata)
          VALUES ($1, $2, $3, 'decision_recorded', 'promotion_candidate', $4, $5, $5, $6::jsonb)
        `, [
          randomUUID(), input.targetInstallationId, binding.membership_id,
          input.candidateId, String(row.state), JSON.stringify({ reason_code: input.decision }),
        ])
        await client.query('COMMIT')
        return { decisionId }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    /**
     * The §4.3 publication transaction. The actor's binding must carry
     * `publish` on the exact target installation.
     */
    async publish(input: PublishInput): Promise<{
      claimId: string
      versionId: string
      conflictGroupId: string | null
      conflictVariant: number | null
      resolution: PublishInput['resolution']
    }> {
      const binding = input.grant.scopeBindings.find(
        candidate => candidate.installation_id === input.targetInstallationId)
      if (!binding || !binding.permissions.includes('publish')) {
        throw new PublicationError('forbidden', 'publish permission required')
      }
      if (!['new', 'parallel', 'supersede'].includes(input.resolution)) {
        throw new PublicationError('invalid_resolution', 'resolution must be new, parallel, or supersede')
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const candidateResult = await client.query<Record<string, unknown>>(`
            SELECT * FROM memory_promotion_candidates
            WHERE target_installation_id = $1 AND candidate_id = $2 FOR UPDATE
          `, [input.targetInstallationId, input.candidateId])
          const candidateRow = candidateResult.rows[0]
          if (!candidateRow) throw new PublicationError('not_found', 'candidate not found')
          const candidate = toCandidate(candidateRow)
          if (candidate.revision !== input.expectedCandidateRevision) {
            throw new PublicationError('revision_conflict', 'candidate revision mismatch', {
              current_revision: candidate.revision,
            })
          }
          if (candidate.duplicate_of_claim_id) {
            throw new PublicationError('state_conflict', 'duplicate candidates cannot publish')
          }
          if (!['proposed', 'approved', 'conflict'].includes(candidate.state)) {
            throw new PublicationError('state_conflict', `candidate state ${candidate.state} is not publishable`)
          }
          if (candidate.expires_at.getTime() <= Date.now()) {
            throw new PublicationError('expired', 'candidate TTL elapsed')
          }
          if (candidate.state === 'conflict' && input.resolution === 'new') {
            throw new PublicationError('invalid_resolution', 'conflicted candidates require parallel or supersede')
          }
          if (candidate.state !== 'conflict' && input.resolution !== 'new') {
            throw new PublicationError('invalid_resolution', 'resolution only applies to conflicted candidates')
          }

          // Lock the current revision, its evidence, the policy head, and decisions.
          const revision = await client.query<{
            candidate_revision_id: string
            revision_number: string | number
            statement: string
            structured_content: Record<string, unknown>
            content_hash: string
            review_policy_version_id: string
            parent_review_policy_version_id: string | null
            created_by_membership_id: string | null
          }>(`
            SELECT candidate_revision_id, revision_number, statement, structured_content,
                   content_hash, review_policy_version_id,
                   parent_review_policy_version_id, created_by_membership_id
            FROM memory_promotion_candidate_versions
            WHERE candidate_id = $1 ORDER BY revision_number DESC LIMIT 1 FOR UPDATE
          `, [input.candidateId])
          const latest = revision.rows[0]
          if (!latest) throw new PublicationError('state_conflict', 'candidate has no revisions')

          const evidence = await client.query<{
            ordinal: number
            evidence_kind: string
            excerpt: string
            excerpt_hash: string
            source_evidence_hash: string
            occurred_at: Date | null
          }>(`
            SELECT ordinal, evidence_kind, excerpt, excerpt_hash, source_evidence_hash, occurred_at
            FROM memory_promotion_evidence WHERE candidate_revision_id = $1
            ORDER BY ordinal ASC FOR UPDATE
          `, [latest.candidate_revision_id])
          if (evidence.rows.length === 0) {
            throw new PublicationError('evidence_missing', 'candidate revision has no shared evidence package')
          }

          // Re-resolve both policy layers under the publication transaction.
          // Any head change invalidates approvals on this immutable revision.
          const policySnapshot = await loadEffectiveReviewPolicySnapshot(
            client,
            input.targetInstallationId,
          )
          const targetKind = policySnapshot.scopeKind
          if (policySnapshot.activeVersionId !== latest.review_policy_version_id
            || policySnapshot.parentActiveVersionId !== latest.parent_review_policy_version_id) {
            throw new PublicationError('policy_head_changed',
              'review policy changed after this candidate revision')
          }
          const policy = policySnapshot.policy
          if (evidence.rows.length > policy.max_shared_evidence) {
            throw new PublicationError('evidence_missing',
              'candidate evidence exceeds the active policy maximum')
          }

          // Re-evaluate every counted decision against the live mirror.
          const decisions = await client.query<{
            decision_id: string
            membership_id: string
            membership_revision: string | number
            decision: string
          }>(`
            SELECT d.decision_id, d.membership_id, d.membership_revision, d.decision
            FROM memory_review_decisions d
            WHERE d.candidate_revision_id = $1
          `, [latest.candidate_revision_id])
          const stillActive = await client.query<{
            membership_id: string
            membership_revision: string | number
            state: string
            roles: string[]
          }>(`
            SELECT membership_id, membership_revision, state, roles
            FROM memory_scope_memberships
            WHERE installation_id = $1
          `, [input.targetInstallationId])
          const countedDecisions = currentReviewDecisions(
            decisions.rows.map(row => ({
              decisionId: row.decision_id,
              membershipId: row.membership_id,
              membershipRevision: String(row.membership_revision),
              decision: row.decision as ReviewDecisionKind,
            })),
            stillActive.rows.map(row => ({
              membershipId: row.membership_id,
              membershipRevision: String(row.membership_revision),
              state: row.state,
              roles: row.roles,
            })),
          )

          const quorum = evaluateQuorum({
            decisions: countedDecisions.map(row => ({
              membershipId: row.membershipId,
              decision: row.decision as ReviewDecisionKind,
            })),
            policy,
            proposerMembershipId: latest.created_by_membership_id,
            publisherMembershipId: binding.membership_id!,
          })
          if (!quorum.ok) {
            throw new PublicationError('quorum_failed', `publication quorum failed: ${quorum.reason}`, {
              reason: quorum.reason,
            })
          }

          // Conflict resolution bookkeeping.
          const targetScope = await client.query<{ owner_scope_id: string }>(`
            SELECT owner_scope_id::text FROM memory_owner_scopes WHERE installation_id = $1
          `, [input.targetInstallationId])
          const targetScopeId = targetScope.rows[0]?.owner_scope_id ?? input.targetInstallationId
          let conflictGroupId: string | null = null
          let conflictVariant: number | null = null
          let supersededClaimIds: string[] = []
          const claimId = randomUUID()
          const versionId = randomUUID()
          const authorityKind = targetKind === 'organization' ? 'organization_published' : 'team_published'

          if (input.resolution === 'parallel') {
            conflictGroupId = candidate.conflict_group_id ?? randomUUID()
            // A first conflict starts from an ungrouped canonical incumbent.
            // Lock and attach every matching ungrouped active row before
            // choosing the new variant, so both sides become visible in one
            // conflict group atomically.
            const existingVariants = await client.query<{
              claim_id: string
              conflict_group_id: string | null
              conflict_variant: string | number
            }>(`
              SELECT claim_id::text, conflict_group_id::text, conflict_variant
              FROM knowledge_claims
              WHERE installation_id = $1 AND claim_type = $2 AND scope_key = $3
                AND normalized_key = $4 AND state = 'active'
                AND (conflict_group_id IS NULL OR conflict_group_id = $5)
              ORDER BY claim_id
              FOR UPDATE
            `, [input.targetInstallationId, candidate.target_claim_type,
              candidate.scope_key, candidate.normalized_key, conflictGroupId])
            let maxVariant = existingVariants.rows
              .filter(row => row.conflict_group_id === conflictGroupId)
              .reduce((max, row) => Math.max(max, Number(row.conflict_variant)), -1)
            for (const incumbent of existingVariants.rows.filter(row => row.conflict_group_id === null)) {
              maxVariant += 1
              await client.query(`
                UPDATE knowledge_claims
                SET conflict_group_id = $2, conflict_variant = $3, updated_at = NOW()
                WHERE installation_id = $1 AND claim_id = $4 AND state = 'active'
              `, [input.targetInstallationId, conflictGroupId, maxVariant, incumbent.claim_id])
            }
            conflictVariant = maxVariant + 1
          } else if (input.resolution === 'supersede') {
            const supersedeIds = input.supersedeClaimIds ?? []
            if (supersedeIds.length === 0 || new Set(supersedeIds).size !== supersedeIds.length) {
              throw new PublicationError('invalid_resolution', 'supersede must name the affected claims')
            }
            conflictGroupId = candidate.conflict_group_id ?? randomUUID()
            const selected = await client.query<{
              claim_id: string
              conflict_variant: string | number
            }>(`
              SELECT claim_id::text, conflict_variant
              FROM knowledge_claims
              WHERE installation_id = $1 AND claim_id = ANY($2::uuid[]) AND state = 'active'
                AND claim_type = $3 AND scope_key = $4 AND normalized_key = $5
                AND (conflict_group_id IS NULL OR conflict_group_id = $6)
              FOR UPDATE
            `, [input.targetInstallationId, supersedeIds, candidate.target_claim_type,
              candidate.scope_key, candidate.normalized_key, conflictGroupId])
            if (selected.rows.length !== supersedeIds.length) {
              throw new PublicationError('invalid_resolution',
                'supersede target must be an active claim in the same conflict group')
            }
            let lowestVariant: number | null = null
            for (const superseded of selected.rows) {
              await client.query(`
                UPDATE knowledge_claims
                SET state = 'superseded', conflict_group_id = $2, updated_at = NOW()
                WHERE installation_id = $1 AND claim_id = $3 AND state = 'active'
              `, [input.targetInstallationId, conflictGroupId, superseded.claim_id])
              const variant = Number(superseded.conflict_variant)
              lowestVariant = lowestVariant === null ? variant : Math.min(lowestVariant, variant)
            }
            conflictVariant = lowestVariant ?? 0
            supersededClaimIds = supersedeIds
          }

          // Append the shared Claim, Version, and Evidence copies. The new
          // claim must exist before the supersession FK can point at it.
          await client.query(`
            INSERT INTO knowledge_claims
              (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key,
               state, current_version_id, owner_scope_kind, owner_scope_id,
               conflict_group_id, conflict_variant)
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11)
          `, [
            claimId, input.targetInstallationId, candidate.target_claim_type,
            candidate.scope_kind, candidate.scope_key, `${candidate.normalized_key}`,
            versionId, targetKind, targetScopeId, conflictGroupId, conflictVariant ?? 0,
          ])
          await client.query(`
            INSERT INTO knowledge_versions
              (version_id, installation_id, claim_id, version_number, statement,
               structured_content, authority, confidence, source_promotion_candidate_id)
            VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, 1.0, $7)
          `, [
            versionId, input.targetInstallationId, claimId, latest.statement,
            JSON.stringify(latest.structured_content ?? {}), authorityKind, input.candidateId,
          ])
          if (supersededClaimIds.length > 0) {
            await client.query(`
              UPDATE knowledge_claims SET superseded_by_claim_id = $2
              WHERE installation_id = $1 AND claim_id = ANY($3::uuid[])
            `, [input.targetInstallationId, claimId, supersededClaimIds])
          }

          // Shared evidence rows hang off a synthetic target episode so the
          // (installation, episode) FK stays intact without any personal link.
          const sharedEpisode = await client.query<{ episode_id: string }>(`
            INSERT INTO work_episodes
              (installation_id, episode_id, session_id, turn_id, state, compiler_version)
            VALUES ($1, gen_random_uuid(), 'shared-governance', $2, 'ready', 'phase3')
            RETURNING episode_id::text
          `, [input.targetInstallationId, `shared-${claimId}`])
          const sharedEpisodeId = sharedEpisode.rows[0].episode_id
          for (const item of evidence.rows) {
            await client.query(`
              INSERT INTO knowledge_evidence
                (evidence_id, installation_id, version_id, episode_id, ordinal, evidence_kind,
                 excerpt, excerpt_hash, occurred_at, visibility, source_evidence_hash, contributor_membership_id)
              VALUES ($1, $2, $3, $4, $5, 'episode', $6, $7, $8, 'shared', $9, $10)
            `, [
              randomUUID(), input.targetInstallationId, versionId,
              sharedEpisodeId, item.ordinal, item.excerpt, item.excerpt_hash, item.occurred_at,
              item.source_evidence_hash, candidate.created_by_membership_id,
            ])
          }

          // Authority provenance + index enqueue + governance event + CAS.
          await client.query(`
            INSERT INTO memory_authority_records
              (authority_id, installation_id, version_id, candidate_revision_id,
               review_policy_version_id, parent_review_policy_version_id,
               counted_decision_ids, publisher_membership_id,
               source_scope_kind, source_content_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10)
          `, [
            randomUUID(), input.targetInstallationId, versionId, latest.candidate_revision_id,
            latest.review_policy_version_id, latest.parent_review_policy_version_id,
            countedDecisions
              .filter(decision => quorum.countedDecisionMemberships.includes(decision.membershipId))
              .map(decision => decision.decisionId),
            binding.membership_id, candidate.source_scope_kind, candidate.source_content_hash,
          ])
          await client.query(`
            INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
            VALUES (gen_random_uuid(), $1, 'index_shared_claim', $2, 60, $3::jsonb)
            ON CONFLICT DO NOTHING
          `, [input.targetInstallationId, `index_shared_claim:${claimId}`, JSON.stringify({ claim_id: claimId, version_id: versionId })])
          await client.query(`
            INSERT INTO memory_governance_events
              (event_id, installation_id, actor_membership_id, action, target_kind, target_id,
               previous_state, next_state, metadata)
            VALUES ($1, $2, $3, 'candidate_published', 'promotion_candidate', $4, $5, 'published', $6::jsonb)
          `, [
            randomUUID(), input.targetInstallationId, binding.membership_id,
            input.candidateId, candidate.state, JSON.stringify({ resolution: input.resolution }),
          ])
          const published = await client.query(`
            UPDATE memory_promotion_candidates
            SET state = 'published', updated_at = NOW()
            WHERE candidate_id = $1 AND revision = $2
            RETURNING candidate_id
          `, [input.candidateId, input.expectedCandidateRevision])
          if ((published.rowCount ?? 0) === 0) {
            throw new PublicationError('revision_conflict', 'candidate revision mismatch')
          }

          await client.query('COMMIT')
          return { claimId, versionId, conflictGroupId, conflictVariant, resolution: input.resolution }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

export type PublicationService = ReturnType<typeof createPublicationService>

/** Shared-claim lifecycle helpers appended beside the publication service. */
export function createSharedClaimLifecycle(pool: pg.Pool) {
  return {
    /**
     * Revoke a published shared Claim (publisher permission proven by the
     * caller's validated grant binding). Evidence copies are retained per
     * the review policy's retention window for audit; state is terminal.
     */
    async revokeSharedClaim(input: {
      grant: ValidatedV2Grant
      targetInstallationId: string
      claimId: string
      reason: string
      expectedRevision: number
    }): Promise<{ state: string }> {
      const binding = input.grant.scopeBindings.find(
        candidate => candidate.installation_id === input.targetInstallationId)
      if (!binding || !binding.permissions.includes('publish')) {
        throw new PublicationError('forbidden', 'publish permission required')
      }
      if (typeof input.reason !== 'string' || input.reason.length === 0 || input.reason.length > 512) {
        throw new PublicationError('invalid_resolution', 'reason must be 1..512 characters')
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const claim = await client.query<{ revision: string; owner_scope_kind: string; state: string }>(`
          SELECT revision::text, owner_scope_kind, state FROM knowledge_claims
          WHERE installation_id = $1 AND claim_id = $2 FOR UPDATE
        `, [input.targetInstallationId, input.claimId])
        const row = claim.rows[0]
        if (!row || row.owner_scope_kind === 'personal') {
          throw new PublicationError('not_found', 'shared claim not found')
        }
        if (Number(row.revision) !== input.expectedRevision) {
          throw new PublicationError('revision_conflict', 'claim revision mismatch')
        }
        if (row.state !== 'active') {
          throw new PublicationError('state_conflict', `claim state ${row.state} is not revocable`)
        }
        await client.query(`
          UPDATE knowledge_claims SET state = 'revoked', revision = revision + 1, updated_at = NOW()
          WHERE installation_id = $1 AND claim_id = $2 AND revision = $3
        `, [input.targetInstallationId, input.claimId, input.expectedRevision])
        await client.query(`
          INSERT INTO memory_governance_events
            (event_id, installation_id, actor_membership_id, action, target_kind, target_id,
             previous_state, next_state, metadata)
          VALUES ($1, $2, $3, 'shared_claim_revoked', 'knowledge_claim', $4, 'active', 'revoked', $5::jsonb)
        `, [
          randomUUID(), input.targetInstallationId, binding.membership_id,
          input.claimId, JSON.stringify({ reason_code: input.reason.slice(0, 128) }),
        ])
        await client.query('COMMIT')
        return { state: 'revoked' }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    /** expire_promotion_candidates job body: TTL-elapsed candidates expire. */
    async expirePromotionCandidates(installationId: string): Promise<number> {
      const result = await pool.query(`
        UPDATE memory_promotion_candidates
        SET state = 'expired', updated_at = NOW()
        WHERE target_installation_id = $1
          AND state IN ('proposed', 'changes_requested', 'approved', 'conflict')
          AND expires_at <= NOW()
      `, [installationId])
      return result.rowCount ?? 0
    },
  }
}

export type SharedClaimLifecycle = ReturnType<typeof createSharedClaimLifecycle>
