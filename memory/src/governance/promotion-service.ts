import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import { sanitizeText } from '../episodes/content-policy.js'
import { createAuditRepository } from './audit-repository.js'
import type { ValidatedV2Grant } from './authorization.js'
import type { PromotionCandidateRow, PromotionCandidateVersionRow } from './types.js'
import { loadEffectiveReviewPolicySnapshot } from './review-policy.js'

/**
 * ADR-P3-06 explicit promotion. Personal→Team and Team→Organization only:
 * the proposer selects the source Claim's current Version and 1–8 Evidence
 * items, Memory re-redacts the excerpts into an immutable target-side copy,
 * and the proposal transaction never publishes. Shared rows never store a
 * personal Evidence ID, Session ID, event ID, artifact ID, or locator.
 */

export type PromotionErrorCode =
  | 'invalid_edge'
  | 'source_not_current'
  | 'source_not_active'
  | 'evidence_out_of_bounds'
  | 'evidence_not_owned'
  | 'evidence_empty_after_redaction'
  | 'forbidden_direction'
  | 'not_found'

export class PromotionError extends Error {
  readonly code: PromotionErrorCode
  constructor(code: PromotionErrorCode, message: string) {
    super(message)
    this.name = 'PromotionError'
    this.code = code
  }
}

export interface ProposeInput {
  grant: ValidatedV2Grant
  sourceInstallationId: string
  sourceClaimId: string
  evidenceIds: string[]
  idempotencyDigest: string
}

export interface ProposeResult {
  candidate: PromotionCandidateRow
  candidateRevision: PromotionCandidateVersionRow
  classification: 'new' | 'duplicate' | 'conflict'
}

const MAX_SHARED_EVIDENCE = 8
const MAX_EXCERPT_CHARS = 4000

interface SourceVersionRow {
  claim_id: string
  claim_state: string
  current_version_id: string
  version_id: string
  statement: string
  structured_content: Record<string, unknown>
  claim_type: string
  scope_kind: string
  scope_key: string
  normalized_key: string
}

interface SourceEvidenceRow {
  evidence_id: string
  version_id: string
  evidence_kind: string
  excerpt: string
  excerpt_hash: Buffer | string
  occurred_at: Date | null
}

interface TargetClaimRow {
  claim_id: string
  conflict_group_id: string | null
  current_version_id: string
}

function contentHashOf(statement: string): string {
  return createHash('sha256').update(statement, 'utf8').digest('hex')
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

export function createPromotionService(pool: pg.Pool) {
  const audit = createAuditRepository(pool, { cursorSecret: 'promotion-audit-internal' })

  return {
    /**
     * The §4.2 proposal transaction. Authorization (source read, target
     * contribute) must already be proven by the caller's validated grant.
     */
    async propose(input: ProposeInput): Promise<ProposeResult> {
      const grant = input.grant
      const sourceBinding = grant.scopeBindings.find(
        binding => binding.installation_id === input.sourceInstallationId)
      if (!sourceBinding || !sourceBinding.permissions.includes('read')) {
        throw new PromotionError('not_found', 'source installation not found')
      }
      const targetBinding = grant.scopeBindings.find(
        binding => binding.installation_id === grant.primaryInstallationId)
      if (!targetBinding || !targetBinding.permissions.includes('contribute')) {
        throw new PromotionError('forbidden_direction', 'target installation lacks contribute permission')
      }

      if (!Array.isArray(input.evidenceIds)
        || input.evidenceIds.length < 1
        || input.evidenceIds.length > MAX_SHARED_EVIDENCE
        || new Set(input.evidenceIds).size !== input.evidenceIds.length) {
        throw new PromotionError('evidence_out_of_bounds', 'evidence selection must be 1..8 unique items')
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Scope-edge validation (ADR-P3-06): personal→team, team→organization.
          const scopes = await client.query<{
            installation_id: string
            owner_scope_kind: string
          }>(`
            SELECT installation_id, owner_scope_kind FROM memory_owner_scopes
            WHERE installation_id = ANY($1::uuid[])
          `, [[input.sourceInstallationId, grant.primaryInstallationId]])
          const scopeByInstallation = new Map(scopes.rows.map(row => [row.installation_id, row.owner_scope_kind]))
          const sourceKind = scopeByInstallation.get(input.sourceInstallationId)
          const targetKind = scopeByInstallation.get(grant.primaryInstallationId)
          const edgeValid = (sourceKind === 'personal' && targetKind === 'team')
            || (sourceKind === 'team' && targetKind === 'organization')
          if (!edgeValid) {
            throw new PromotionError('invalid_edge',
              'only Personal→Team and Team→Organization promotion edges exist')
          }

          // Lock the source claim and its current version.
          const source = await client.query<SourceVersionRow>(`
            SELECT c.claim_id, c.state AS claim_state, c.current_version_id,
                   v.version_id, v.statement, v.structured_content,
                   c.claim_type, c.scope_kind, c.scope_key, c.normalized_key
            FROM knowledge_claims c
            JOIN knowledge_versions v ON v.version_id = c.current_version_id
                 AND v.installation_id = c.installation_id
            WHERE c.installation_id = $1 AND c.claim_id = $2
            FOR UPDATE OF c
          `, [input.sourceInstallationId, input.sourceClaimId])
          const sourceRow = source.rows[0]
          if (!sourceRow) throw new PromotionError('not_found', 'source claim not found')
          if (sourceRow.claim_state !== 'active') {
            throw new PromotionError('source_not_active', 'source claim is not active')
          }
          if (sourceRow.current_version_id !== sourceRow.version_id) {
            throw new PromotionError('source_not_current', 'source version is not the current version')
          }

          // Idempotent replay: an identical propose digest returns the
          // original candidate instead of creating a second one.
          const replay = await client.query<{ target_id: string }>(`
            SELECT target_id FROM memory_governance_events
            WHERE installation_id = $1 AND action = 'candidate_proposed' AND request_hash = $2
            LIMIT 1
          `, [grant.primaryInstallationId, input.idempotencyDigest])
          if (replay.rows[0]?.target_id) {
            const existing = await client.query(`
              SELECT c.*, r.candidate_revision_id FROM memory_promotion_candidates c
              JOIN memory_promotion_candidate_versions r ON r.candidate_id = c.candidate_id
                AND r.revision_number = 1
              WHERE c.candidate_id = $1
            `, [replay.rows[0].target_id])
            if (existing.rows[0]) {
              await client.query('COMMIT')
              return {
                candidate: toCandidate(existing.rows[0]),
                candidateRevision: existing.rows[0] as unknown as PromotionCandidateVersionRow,
                classification: existing.rows[0].duplicate_of_claim_id ? 'duplicate'
                  : existing.rows[0].conflict_group_id ? 'conflict' : 'new',
              }
            }
          }

          // Fence every policy layer that governs this candidate. Team policy
          // may only strengthen its parent Organization policy.
          const policySnapshot = await loadEffectiveReviewPolicySnapshot(
            client,
            grant.primaryInstallationId,
            { ensure: true },
          )
          const effectivePolicy = policySnapshot.policy
          if (input.evidenceIds.length > effectivePolicy.max_shared_evidence) {
            throw new PromotionError('evidence_out_of_bounds',
              `evidence selection exceeds the active policy maximum of ${effectivePolicy.max_shared_evidence}`)
          }

          // Explicit evidence ownership + re-redaction.
          const evidence = await client.query<SourceEvidenceRow>(`
            SELECT evidence_id, version_id, evidence_kind, excerpt, excerpt_hash, occurred_at
            FROM knowledge_evidence
            WHERE installation_id = $1 AND evidence_id = ANY($2::uuid[])
            ORDER BY ordinal ASC
          `, [input.sourceInstallationId, input.evidenceIds])
          const evidenceById = new Map(evidence.rows.map(row => [row.evidence_id, row]))
          for (const evidenceId of input.evidenceIds) {
            const row = evidenceById.get(evidenceId)
            if (!row || row.version_id !== sourceRow.version_id) {
              throw new PromotionError('evidence_not_owned',
                'evidence must belong to the source claim current version')
            }
          }
          const sanitizedEvidence = input.evidenceIds.map((evidenceId, index) => {
            const row = evidenceById.get(evidenceId)!
            const sanitized = sanitizeText(row.excerpt, MAX_EXCERPT_CHARS)
            if (sanitized.text.length === 0) {
              throw new PromotionError('evidence_empty_after_redaction',
                'evidence excerpt empty after redaction')
            }
            return {
              ordinal: index + 1,
              evidence_kind: row.evidence_kind,
              excerpt: sanitized.text,
              excerpt_hash: createHash('sha256').update(sanitized.text, 'utf8').digest('hex'),
              source_evidence_hash: Buffer.isBuffer(row.excerpt_hash)
                ? row.excerpt_hash.toString('hex')
                : String(row.excerpt_hash),
              occurred_at: row.occurred_at,
            }
          })

          // Deterministic duplicate/conflict classification inside the target.
          const sourceHash = contentHashOf(sourceRow.statement)
          const existing = await client.query<TargetClaimRow>(`
            SELECT claim_id, conflict_group_id, current_version_id
            FROM knowledge_claims
            WHERE installation_id = $1 AND claim_type = $2 AND scope_key = $3
              AND normalized_key = $4 AND state = 'active'
            LIMIT 1
          `, [grant.primaryInstallationId, sourceRow.claim_type, sourceRow.scope_key, sourceRow.normalized_key])
          const existingRow = existing.rows[0]
          let classification: ProposeResult['classification'] = 'new'
          let state: PromotionCandidateRow['state'] = 'proposed'
          let conflictGroupId: string | null = null
          let duplicateOfClaimId: string | null = null
          if (existingRow) {
            const existingVersion = await client.query<{ statement: string }>(`
              SELECT statement FROM knowledge_versions
              WHERE installation_id = $1 AND version_id = $2
            `, [grant.primaryInstallationId, existingRow.current_version_id])
            const existingHash = existingVersion.rows[0]
              ? contentHashOf(existingVersion.rows[0].statement)
              : ''
            if (existingHash === sourceHash) {
              classification = 'duplicate'
              duplicateOfClaimId = existingRow.claim_id
            } else {
              classification = 'conflict'
              state = 'conflict'
              conflictGroupId = existingRow.conflict_group_id ?? randomUUID()
            }
          }

          // TTL from the effective policy.
          const ttlDays = effectivePolicy.candidate_ttl_days
          const candidateId = randomUUID()
          const candidateRevisionId = randomUUID()
          const inserted = await client.query(`
            INSERT INTO memory_promotion_candidates
              (candidate_id, target_installation_id, source_installation_id, source_scope_kind,
               source_claim_id, source_version_id, source_content_hash, target_claim_type,
               scope_kind, scope_key, normalized_key, state, conflict_group_id,
               duplicate_of_claim_id, expires_at, created_by_membership_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    NOW() + ($15 * INTERVAL '1 day'), $16)
            RETURNING *
          `, [
            candidateId, grant.primaryInstallationId, input.sourceInstallationId, sourceKind,
            input.sourceClaimId, sourceRow.version_id, sourceHash, sourceRow.claim_type,
            sourceRow.scope_kind, sourceRow.scope_key, sourceRow.normalized_key, state,
            conflictGroupId, duplicateOfClaimId, ttlDays, targetBinding.membership_id,
          ])
          const revision = await client.query(`
            INSERT INTO memory_promotion_candidate_versions
              (candidate_revision_id, candidate_id, revision_number, statement,
               structured_content, content_hash, review_policy_version_id,
               parent_review_policy_version_id, created_by_membership_id)
            VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7, $8)
            RETURNING *
          `, [
            candidateRevisionId, candidateId, sourceRow.statement,
            JSON.stringify(sourceRow.structured_content ?? {}), sourceHash,
            policySnapshot.activeVersionId, policySnapshot.parentActiveVersionId,
            targetBinding.membership_id,
          ])
          for (const item of sanitizedEvidence) {
            await client.query(`
              INSERT INTO memory_promotion_evidence
                (candidate_revision_id, ordinal, evidence_kind, excerpt, excerpt_hash,
                 sanitized_locator, source_evidence_hash, occurred_at)
              VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)
            `, [
              candidateRevisionId, item.ordinal, item.evidence_kind, item.excerpt,
              item.excerpt_hash, item.source_evidence_hash, item.occurred_at,
            ])
          }
          await client.query(`
            INSERT INTO memory_governance_events
              (event_id, installation_id, actor_membership_id, action, target_kind, target_id,
               request_hash, previous_state, next_state, metadata)
            VALUES ($1, $2, $3, 'candidate_proposed', 'promotion_candidate', $4, $5, NULL, $6,
                    $7::jsonb)
          `, [
            randomUUID(), grant.primaryInstallationId, targetBinding.membership_id,
            candidateId, input.idempotencyDigest, state, JSON.stringify({ revision: 1 }),
          ])

          await client.query('COMMIT')
          return {
            candidate: toCandidate(inserted.rows[0]),
            candidateRevision: revision.rows[0] as unknown as PromotionCandidateVersionRow,
            classification,
          }
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

export type PromotionService = ReturnType<typeof createPromotionService>
