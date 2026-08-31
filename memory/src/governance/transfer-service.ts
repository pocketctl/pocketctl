import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import { sanitizeText } from '../episodes/content-policy.js'
import {
  DEFAULT_ORGANIZATION_REVIEW_POLICY,
  canonicalReviewPolicyHash,
  parseReviewPolicyDocument,
  resolveEffectivePolicy,
} from './review-policy.js'
import type { ValidatedV2Grant } from './authorization.js'

/**
 * ADR-P3-11 Team dissolution transfer. A scope_admin may start exactly one
 * transfer run from a dissolving Team installation to its parent
 * Organization installation: every ACTIVE team Claim becomes an Organization
 * promotion candidate (immutable evidence copies included) inside one
 * transaction. Transfer NEVER publishes — Organization Claims activate only
 * through the normal review policy.
 */

export class TransferError extends Error {
  readonly code: 'invalid_edge' | 'forbidden' | 'not_found' | 'conflict'
  constructor(code: TransferError['code'], message: string) {
    super(message)
    this.name = 'TransferError'
    this.code = code
  }
}

function contentHashOf(statement: string): string {
  return createHash('sha256').update(statement, 'utf8').digest('hex')
}

export function createTransferService(pool: pg.Pool) {
  return {
    async startTeamTransfer(input: {
      grant: ValidatedV2Grant
      sourceInstallationId: string
      targetInstallationId: string
      expectedAuthorizationEpoch: number
    }): Promise<{ transferId: string; candidates: number }> {
      const sourceBinding = input.grant.scopeBindings.find(
        binding => binding.installation_id === input.sourceInstallationId)
      const targetBinding = input.grant.scopeBindings.find(
        binding => binding.installation_id === input.targetInstallationId)
      if (!sourceBinding || !targetBinding
        || !sourceBinding.permissions.includes('scope_admin')
        || !targetBinding.permissions.includes('scope_admin')) {
        throw new TransferError('forbidden', 'scope_admin permission required on both installations')
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const scopes = await client.query<{
          installation_id: string
          owner_scope_kind: string
          parent_organization_id: string | null
          state: string
          authorization_epoch: string | number
        }>(`
          SELECT s.installation_id::text, s.owner_scope_kind, s.parent_organization_id::text,
                 s.state, s.authorization_epoch
          FROM memory_owner_scopes s WHERE s.installation_id = ANY($1::uuid[])
        `, [[input.sourceInstallationId, input.targetInstallationId]])
        const byId = new Map(scopes.rows.map(row => [row.installation_id, row]))
        const source = byId.get(input.sourceInstallationId)
        const target = byId.get(input.targetInstallationId)
        if (!source || !target || source.owner_scope_kind !== 'team'
          || target.owner_scope_kind !== 'organization'
          || source.state !== 'dissolving' || target.state !== 'active') {
          throw new TransferError('invalid_edge',
            'transfer requires a dissolving Team and an active parent Organization')
        }
        if (Number(source.authorization_epoch) !== input.expectedAuthorizationEpoch) {
          throw new TransferError('conflict', 'source authorization epoch mismatch')
        }
        // Parent linkage must agree with the requested target.
        const orgScope = await client.query<{ owner_scope_id: string }>(`
          SELECT owner_scope_id::text FROM memory_owner_scopes WHERE installation_id = $1
        `, [input.targetInstallationId])
        const sourceOrg = source.parent_organization_id
          ? (await client.query<{ owner_scope_id: string }>(`
              SELECT owner_scope_id::text FROM memory_owner_scopes
              WHERE owner_scope_kind = 'organization' AND owner_scope_id = $1
            `, [source.parent_organization_id])).rows[0]?.owner_scope_id
          : null
        if (!sourceOrg || sourceOrg !== orgScope.rows[0]?.owner_scope_id) {
          throw new TransferError('invalid_edge', 'target must be the parent Organization')
        }

        // Exactly one transfer run per source.
        const existing = await client.query(`
          SELECT 1 FROM memory_transfer_runs
          WHERE source_installation_id = $1 AND state IN ('running', 'completed')
        `, [input.sourceInstallationId])
        if (existing.rowCount && existing.rowCount > 0) {
          throw new TransferError('conflict', 'a transfer run already exists for this team')
        }

        // Organization review policy head (lazily seeded).
        await client.query(`
          INSERT INTO memory_review_policy_sets (policy_id, installation_id)
          VALUES (gen_random_uuid(), $1) ON CONFLICT (installation_id) DO NOTHING
        `, [input.targetInstallationId])
        const seeded = await client.query<{ policy_version_id: string }>(`
          INSERT INTO memory_review_policy_versions
            (policy_version_id, policy_id, version_number, document, content_hash)
          SELECT gen_random_uuid(), s.policy_id, 1, $2::jsonb, $3
          FROM memory_review_policy_sets s
          WHERE s.installation_id = $1
            AND NOT EXISTS (SELECT 1 FROM memory_review_policy_heads h WHERE h.policy_id = s.policy_id)
          RETURNING policy_version_id
        `, [input.targetInstallationId, JSON.stringify(DEFAULT_ORGANIZATION_REVIEW_POLICY),
          canonicalReviewPolicyHash(DEFAULT_ORGANIZATION_REVIEW_POLICY)])
        if (seeded.rows[0]) {
          await client.query(`
            INSERT INTO memory_review_policy_heads (policy_id, active_version_id, revision)
            SELECT s.policy_id, $2, 1 FROM memory_review_policy_sets s WHERE s.installation_id = $1
          `, [input.targetInstallationId, seeded.rows[0].policy_version_id])
        }
        const policyHead = await client.query<{
          active_version_id: string
          document: Record<string, unknown>
        }>(`
          SELECT h.active_version_id, v.document FROM memory_review_policy_heads h
          JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
          JOIN memory_review_policy_versions v ON v.policy_version_id = h.active_version_id
          WHERE s.installation_id = $1
        `, [input.targetInstallationId])
        const policyVersionId = policyHead.rows[0]?.active_version_id
        if (!policyVersionId) throw new TransferError('not_found', 'organization policy head missing')
        const storedPolicy = parseReviewPolicyDocument(policyHead.rows[0].document)
        if (!storedPolicy) throw new TransferError('conflict', 'organization policy document invalid')
        const effectivePolicy = resolveEffectivePolicy(
          DEFAULT_ORGANIZATION_REVIEW_POLICY,
          storedPolicy,
        )

        const transferId = randomUUID()
        await client.query(`
          INSERT INTO memory_transfer_runs
            (transfer_id, source_installation_id, target_installation_id, state,
             source_revision, created_by_membership_id)
          VALUES ($1, $2, $3, 'running', $4, $5)
        `, [
          transferId, input.sourceInstallationId, input.targetInstallationId,
          input.expectedAuthorizationEpoch, targetBinding.membership_id,
        ])

        // Active team claims become organization candidates.
        const claims = await client.query<{
          claim_id: string
          version_id: string
          statement: string
          structured_content: Record<string, unknown>
          claim_type: string
          scope_kind: string
          scope_key: string
          normalized_key: string
          conflict_group_id: string | null
          conflict_variant: string | number
        }>(`
          SELECT c.claim_id::text, v.version_id::text, v.statement, v.structured_content,
                 c.claim_type, c.scope_kind, c.scope_key, c.normalized_key,
                 c.conflict_group_id::text, c.conflict_variant
          FROM knowledge_claims c
          JOIN knowledge_versions v ON v.version_id = c.current_version_id AND v.installation_id = c.installation_id
          WHERE c.installation_id = $1 AND c.state = 'active'
        `, [input.sourceInstallationId])

        let count = 0
        for (const claim of claims.rows) {
          const sourceHash = contentHashOf(claim.statement)
          const candidateId = randomUUID()
          const candidateRevisionId = randomUUID()
          await client.query(`
            INSERT INTO memory_promotion_candidates
              (candidate_id, target_installation_id, source_installation_id, source_scope_kind,
               source_claim_id, source_version_id, source_content_hash, target_claim_type,
               scope_kind, scope_key, normalized_key, state, expires_at, created_by_membership_id)
            VALUES ($1, $2, $3, 'team', $4, $5, $6, $7, $8, $9, $10, 'proposed',
                    NOW() + ($11 * INTERVAL '1 day'), $12)
          `, [
            candidateId, input.targetInstallationId, input.sourceInstallationId,
            claim.claim_id, claim.version_id, sourceHash, claim.claim_type,
            claim.scope_kind, claim.scope_key, claim.normalized_key,
            effectivePolicy.candidate_ttl_days, targetBinding.membership_id,
          ])
          await client.query(`
            INSERT INTO memory_promotion_candidate_versions
              (candidate_revision_id, candidate_id, revision_number, statement,
               structured_content, content_hash, review_policy_version_id, created_by_membership_id)
            VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7)
          `, [
            candidateRevisionId, candidateId, claim.statement,
            JSON.stringify(claim.structured_content ?? {}), sourceHash,
            policyVersionId, targetBinding.membership_id,
          ])
          const evidence = await client.query<{
            evidence_kind: string
            excerpt: string
            excerpt_hash: string | Buffer
            occurred_at: Date | null
          }>(`
            SELECT evidence_kind, excerpt, excerpt_hash, occurred_at
            FROM knowledge_evidence WHERE installation_id = $1 AND version_id = $2
            ORDER BY ordinal ASC
          `, [input.sourceInstallationId, claim.version_id])
          let ordinal = 0
          for (const item of evidence.rows) {
            ordinal += 1
            if (ordinal > effectivePolicy.max_shared_evidence) break
            const sanitized = sanitizeText(item.excerpt, 4000)
            if (sanitized.text.length === 0) continue
            await client.query(`
              INSERT INTO memory_promotion_evidence
                (candidate_revision_id, ordinal, evidence_kind, excerpt, excerpt_hash,
                 sanitized_locator, source_evidence_hash, occurred_at)
              VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)
            `, [
              candidateRevisionId, ordinal, item.evidence_kind, sanitized.text,
              createHash('sha256').update(sanitized.text, 'utf8').digest('hex'),
              Buffer.isBuffer(item.excerpt_hash) ? item.excerpt_hash.toString('hex') : String(item.excerpt_hash),
              item.occurred_at,
            ])
          }
          if (ordinal === 0) {
            // Evidence-free candidates can never publish (policy floor), so
            // the transfer records the candidate without evidence and the
            // review queue shows the gap explicitly.
          }
          count++
        }

        await client.query(`
          UPDATE memory_transfer_runs SET state = 'completed', completed_at = NOW()
          WHERE transfer_id = $1
        `, [transferId])
        await client.query(`
          INSERT INTO memory_governance_events
            (event_id, installation_id, actor_membership_id, action, target_kind, target_id,
             next_state, metadata)
          VALUES ($1, $2, $3, 'transfer_completed', 'transfer_run', $4, 'completed', $5::jsonb)
        `, [
          randomUUID(), input.targetInstallationId, targetBinding.membership_id,
          transferId, JSON.stringify({ count }),
        ])
        await client.query('COMMIT')
        return { transferId, candidates: count }
      } catch (error) {
        await client.query('ROLLBACK')
        if ((error as { code?: string; constraint?: string }).code === '23505'
          && (error as { constraint?: string }).constraint === 'memory_transfer_runs_source_once_idx') {
          throw new TransferError('conflict', 'a transfer run already exists for this team')
        }
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export type TransferService = ReturnType<typeof createTransferService>
