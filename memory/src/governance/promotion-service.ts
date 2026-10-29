import {claimIdentityV2} from '../claims/identity.js'
import {classifyClaimConflict,summarizeClaimRelationships} from '../claims/conflict-classifier.js'
import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import { sanitizeText } from '../episodes/content-policy.js'
import { createAuditRepository } from './audit-repository.js'
import { assertCurrentGrantClock, requireCurrentScopePermission, TargetBindingError, type ValidatedV2Grant } from './authorization.js'
import type { PromotionCandidateRow, PromotionCandidateVersionRow } from './types.js'
import {canonicalRepositoryRemotes,publicationApplicability,PublicationApplicabilityError} from './publication-applicability.js'
import {findClaimTopicFamily} from '../claims/identity-lookup.js'
import {captureSourceApplicability} from './applicability.js'
import {bundleEvidence,revisionBundleHash,type RevisionBundle} from './revision-bundle.js'
import { canonicalReviewPolicyHash, loadEffectiveReviewPolicySnapshot } from './review-policy.js'

/**
 * ADR-P3-06 explicit promotion. Personal→Team and Team→Organization only:
 * the proposer selects the source Claim's current Version and 1–8 Evidence
 * items, Memory re-redacts the excerpts into an immutable target-side copy,
 * and the proposal transaction never publishes. Shared rows never store a
 * personal Evidence ID, raw Session ID, source event ID, or artifact ID.
 * A bounded Team-source locator may survive so published evidence remains
 * traceable to the shared event/read-scope versions that authorized capture.
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
  classification: 'new' | 'duplicate' | 'related' | 'potential_conflict' | 'conflict'
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
  repository_id:string|null; repo_snapshot_id:string|null; branch:string|null; canonical_repository_key:string|null
  applicability:unknown;consumption_hold_reason:string|null;source_snapshot_commit_sha:string|null;source_repository_key:string|null;source_canonical_remote:string|null;source_metadata_owned:boolean;source_origin_policy_hash:string|null
  valid_from_exact:string|null;valid_until_exact:string|null;valid_from:Date|null; valid_until:Date|null; freshness_at:Date|null
}

interface SourceEvidenceRow {
  evidence_id: string
  version_id: string
  evidence_kind: string
  excerpt: string
  excerpt_hash: Buffer | string
  occurred_at: Date | null
  locator: Record<string, unknown>
}

function sharedSourceLocator(locator: Record<string, unknown>): Record<string, unknown> | null {
  const source = locator.source_provenance
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const record = source as Record<string, unknown>
  if (record.source_kind !== 'team_session') return null
  return { source_provenance: record }
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
          try {
            await requireCurrentScopePermission({client, grant, targetInstallationId:grant.primaryInstallationId, permission:'contribute'})
          } catch (error) {
            if (error instanceof TargetBindingError) throw new PromotionError('forbidden_direction', 'current target contribution permission required')
            throw error
          }
          try {
            await requireCurrentScopePermission({client, grant, targetInstallationId:input.sourceInstallationId, permission:'read'})
          } catch (error) {
            if (error instanceof TargetBindingError) throw new PromotionError('not_found', 'source installation not found')
            throw error
          }
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
                   c.claim_type, c.scope_kind, c.scope_key, c.normalized_key, c.canonical_repository_key,
                   v.repository_id,v.repo_snapshot_id,v.branch,v.valid_from,v.valid_until,
                   to_char(v.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from_exact,
                   to_char(v.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_until_exact,
                   v.freshness_at,v.applicability,c.consumption_hold_reason,r.repository_key AS source_repository_key,r.canonical_remote AS source_canonical_remote,s.commit_sha AS source_snapshot_commit_sha,
                   ((v.repository_id IS NULL OR r.repository_id IS NOT NULL) AND (v.repo_snapshot_id IS NULL OR s.repo_snapshot_id IS NOT NULL)) AS source_metadata_owned, COALESCE(pr.revision_bundle->>'originPolicyHash',pr.revision_bundle->>'reviewPolicyHash',gr.policy_hash) AS source_origin_policy_hash
            FROM knowledge_claims c
            JOIN knowledge_versions v ON v.version_id = c.current_version_id
                 AND v.installation_id = c.installation_id
            LEFT JOIN repositories r ON r.installation_id=v.installation_id AND r.repository_id=v.repository_id
            LEFT JOIN repo_snapshots s ON s.installation_id=v.installation_id AND s.repository_id=v.repository_id AND s.repo_snapshot_id=v.repo_snapshot_id
            LEFT JOIN memory_authority_records ar ON ar.installation_id=v.installation_id AND ar.version_id=v.version_id
            LEFT JOIN memory_promotion_candidate_versions pr ON pr.candidate_revision_id=ar.candidate_revision_id
   LEFT JOIN memory_git_claim_authority ga ON ga.installation_id=v.installation_id AND ga.version_id=v.version_id
     AND ga.claim_id=c.claim_id AND ga.revision_id=ar.candidate_revision_id
   LEFT JOIN memory_git_governed_revisions gr ON gr.installation_id=ga.installation_id AND gr.revision_id=ga.revision_id
     AND gr.claim_id=c.claim_id AND gr.review_policy_version_id=ar.review_policy_version_id
            WHERE c.installation_id = $1 AND c.claim_id = $2
            FOR UPDATE OF c
          `, [input.sourceInstallationId, input.sourceClaimId])
          const sourceRow = source.rows[0]
          if (!sourceRow) throw new PromotionError('not_found', 'source claim not found')
          if (sourceRow.claim_state !== 'active') {
            throw new PromotionError('source_not_active', 'source claim is not active')
          }
          const deliverySource = await client.query<{ available: boolean }>('SELECT memory_delivery_version_available($1,$2) AS available', [input.sourceInstallationId, sourceRow.version_id])
          if (!deliverySource.rows[0]?.available) throw new PromotionError('source_not_active', 'delivery source has been withdrawn')
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
              SELECT c.*, r.candidate_revision_id,r.revision_bundle FROM memory_promotion_candidates c
              JOIN memory_promotion_candidate_versions r ON r.candidate_id = c.candidate_id
                AND r.revision_number = 1
              WHERE c.candidate_id = $1
            `, [replay.rows[0].target_id])
            if (existing.rows[0]) {
              if(!targetBinding.permissions.includes('read')&&(existing.rows[0].revision_bundle?.relationships||existing.rows[0].conflict_group_id||existing.rows[0].duplicate_of_claim_id))throw new PromotionError('not_found','proposal result unavailable')
              try { await assertCurrentGrantClock(client, grant,[input.sourceInstallationId]) } catch (error) {
            if (error instanceof TargetBindingError) throw new PromotionError('forbidden_direction', 'grant expired before commit')
            throw error
          }
          await client.query('COMMIT')
              return {
                candidate: toCandidate(existing.rows[0]),
                candidateRevision: existing.rows[0] as unknown as PromotionCandidateVersionRow,
                classification: existing.rows[0].revision_bundle?.relationships?.classification??(existing.rows[0].duplicate_of_claim_id ? 'duplicate'
                  : existing.rows[0].conflict_group_id ? 'conflict' : 'new'),
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
            SELECT evidence_id, version_id, evidence_kind, excerpt, excerpt_hash, occurred_at, locator
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
              sanitized_locator: sharedSourceLocator(row.locator ?? {}),
            }
          })

          // Deterministic duplicate/conflict classification inside the target.
          const sourceHash = contentHashOf(sourceRow.statement)
          const bundle:RevisionBundle={schemaVersion:2,statement:sourceRow.statement,structuredContent:sourceRow.structured_content??{},
            applicability:captureSourceApplicability({scopeKind:sourceRow.scope_kind,scopeKey:sourceRow.scope_key,
              canonicalRepositoryKey:sourceRow.canonical_repository_key,repositoryId:sourceRow.repository_id,snapshotId:sourceRow.repo_snapshot_id,branch:sourceRow.branch,
              applicability:sourceRow.applicability,consumptionHoldReason:sourceRow.consumption_hold_reason??(!sourceRow.source_metadata_owned||(sourceRow.canonical_repository_key&& !canonicalRepositoryRemotes(sourceRow.canonical_repository_key).includes(sourceRow.source_canonical_remote??''))?'source_metadata_requires_review':null)}),
            sourceSnapshotCommitSha:sourceRow.source_snapshot_commit_sha,sourceRepositoryKey:sourceRow.source_repository_key,
            sourceContentHash:sourceHash,sourceValidFrom:sourceRow.valid_from_exact?.replace(/(\.\d{3})000Z$/,'$1Z')??sourceRow.valid_from?.toISOString()??null,
            sourceValidUntil:sourceRow.valid_until_exact?.replace(/(\.\d{3})000Z$/,'$1Z')??sourceRow.valid_until?.toISOString()??null,sourceFreshnessAt:sourceRow.freshness_at?.toISOString()??null,
            evidence:bundleEvidence(sanitizedEvidence),originPolicyHash:sourceRow.source_origin_policy_hash,reviewPolicyHash:canonicalReviewPolicyHash(effectivePolicy)}
          let classification:ProposeResult['classification']='new',state:PromotionCandidateRow['state']='proposed'
          let conflictGroupId:string|null=null,duplicateOfClaimId:string|null=null
          try{
            const mapped=await publicationApplicability(client,bundle,grant.primaryInstallationId)
            const proposed={...mapped,claimType:sourceRow.claim_type,statement:sourceRow.statement,structuredContent:sourceRow.structured_content??{},validFrom:bundle.sourceValidFrom,validUntil:bundle.sourceValidUntil}
            if(targetBinding.permissions.includes('read')){
              const existing=await findClaimTopicFamily(client,{installationId:grant.primaryInstallationId,claimType:sourceRow.claim_type,
                applicability:mapped,statement:sourceRow.statement})
              const items=existing.map(row=>({claimId:row.claim_id,versionId:row.version_id,...classifyClaimConflict(proposed,row.facts)}))
              bundle.relationships=summarizeClaimRelationships(items)
              classification=bundle.relationships.classification
              const duplicate=items.find(item=>item.relation==='duplicate')
              if(duplicate)duplicateOfClaimId=duplicate.claimId
              // Identity collisions still require explicit parallel/supersede even
              // when different conditions make the statements merely related.
              const conflict=existing.find(row=>items.some(item=>item.claimId===row.claim_id&&item.relation==='potential_conflict')
                ||claimIdentityV2(row.facts).key===claimIdentityV2(proposed).key)
              if(!duplicate&&conflict){state='conflict';conflictGroupId=conflict.conflict_group_id??randomUUID()}
            }
          }catch(error){if(!(error instanceof PublicationApplicabilityError))throw error}

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
               parent_review_policy_version_id, created_by_membership_id,revision_bundle,revision_bundle_hash)
            VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7, $8,$9::jsonb,$10)
            RETURNING *
          `, [
            candidateRevisionId, candidateId, sourceRow.statement,
            JSON.stringify(sourceRow.structured_content ?? {}), sourceHash,
            policySnapshot.activeVersionId, policySnapshot.parentActiveVersionId,
            targetBinding.membership_id,JSON.stringify(bundle),revisionBundleHash(bundle),
          ])
          for (const item of sanitizedEvidence) {
            await client.query(`
              INSERT INTO memory_promotion_evidence
                (candidate_revision_id, ordinal, evidence_kind, excerpt, excerpt_hash,
                 sanitized_locator, source_evidence_hash, occurred_at)
              VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
            `, [
              candidateRevisionId, item.ordinal, item.evidence_kind, item.excerpt,
              item.excerpt_hash,
              item.sanitized_locator,
              item.source_evidence_hash, item.occurred_at,
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

          try { await assertCurrentGrantClock(client, grant,[input.sourceInstallationId]) } catch (error) {
            if (error instanceof TargetBindingError) throw new PromotionError('forbidden_direction', 'grant expired before commit')
            throw error
          }
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
