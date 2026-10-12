import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import { sanitizeText } from '../episodes/content-policy.js'
import {
  loadEffectiveReviewPolicySnapshot,
  canonicalReviewPolicyHash,
} from './review-policy.js'
import {assertCurrentGrantClock,requireCurrentScopePermission,TargetBindingError,type ValidatedV2Grant } from './authorization.js'
import {captureSourceApplicability} from './applicability.js'
import {canonicalRepositoryRemotes} from './publication-applicability.js'
import {bundleEvidence,revisionBundleHash,type RevisionBundle,type SharedRevisionEvidence} from './revision-bundle.js'
import {lockRevisionSourceMetadata} from './revision-metadata.js'

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
        // Discovery grants no authority. Take every source session before the
        // installation mirrors, then prove the source set again under Claims.
        const sourceSessions=async()=> (await client.query<{session_id:string}>(`
          SELECT DISTINCT w.session_id FROM knowledge_claims c
          JOIN knowledge_evidence e ON e.installation_id=c.installation_id AND e.version_id=c.current_version_id
          JOIN work_episodes w ON w.installation_id=e.installation_id AND w.episode_id=e.episode_id
          WHERE c.installation_id=$1 AND c.state='active' ORDER BY w.session_id
        `,[input.sourceInstallationId])).rows.map(row=>row.session_id)
        const sessions=await sourceSessions()
        for(const session of sessions)await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2,0))`,[input.sourceInstallationId,session])
        await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:input.sourceInstallationId,permission:'scope_admin',allowedSharedStates:['active','dissolving']})
        await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:input.targetInstallationId,permission:'scope_admin',allowedPrimarySharedStates:input.grant.primaryInstallationId===input.targetInstallationId?['active']:['active','dissolving']})
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

        const observedVersions=(await client.query<{claim_id:string;version_id:string}>(`SELECT c.claim_id::text,c.current_version_id::text AS version_id
          FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
          WHERE c.installation_id=$1 AND c.state='active'
          ORDER BY v.repository_id NULLS FIRST,v.repo_snapshot_id NULLS FIRST,c.claim_id`,[input.sourceInstallationId])).rows
        const metadataChecks=[]
        for(const version of observedVersions)metadataChecks.push(await lockRevisionSourceMetadata(client,input.sourceInstallationId,version.version_id))
        // Active team claims become organization candidates.
        const claims = await client.query<{
          claim_id: string
          version_id: string
          statement: string
          structured_content: Record<string, unknown>
          claim_type: string
          scope_kind: RevisionBundle['applicability']['scopeKind']
          scope_key: string
          normalized_key: string
          conflict_group_id: string | null
          conflict_variant: string | number
          canonical_repository_key:string|null;consumption_hold_reason:string|null
          repository_id:string|null;repo_snapshot_id:string|null;branch:string|null;applicability:unknown
          valid_from:Date|null;valid_until:Date|null;freshness_at:Date|null
          source_repository_key:string|null;source_canonical_remote:string|null;source_snapshot_commit_sha:string|null
          source_metadata_owned:boolean;source_origin_policy_hash:string|null
        }>(`
          SELECT c.claim_id::text, v.version_id::text, v.statement, v.structured_content,
                 c.claim_type, c.scope_kind, c.scope_key, c.normalized_key,
                 c.conflict_group_id::text, c.conflict_variant,c.canonical_repository_key,c.consumption_hold_reason,
                 v.repository_id,v.repo_snapshot_id,v.branch,v.applicability,v.valid_from,v.valid_until,v.freshness_at,
                 r.repository_key AS source_repository_key,r.canonical_remote AS source_canonical_remote,s.commit_sha AS source_snapshot_commit_sha,
                 ((v.repository_id IS NULL OR r.repository_id IS NOT NULL) AND (v.repo_snapshot_id IS NULL OR s.repo_snapshot_id IS NOT NULL)) AS source_metadata_owned,
                 COALESCE(pr.revision_bundle->>'originPolicyHash',pr.revision_bundle->>'reviewPolicyHash',gr.policy_hash) AS source_origin_policy_hash
          FROM knowledge_claims c
          JOIN knowledge_versions v ON v.version_id = c.current_version_id AND v.installation_id = c.installation_id
          LEFT JOIN repositories r ON r.installation_id=v.installation_id AND r.repository_id=v.repository_id
          LEFT JOIN repo_snapshots s ON s.installation_id=v.installation_id AND s.repository_id=v.repository_id AND s.repo_snapshot_id=v.repo_snapshot_id
          LEFT JOIN memory_authority_records ar ON ar.installation_id=v.installation_id AND ar.version_id=v.version_id
          LEFT JOIN memory_promotion_candidate_versions pr ON pr.candidate_revision_id=ar.candidate_revision_id
          LEFT JOIN memory_git_claim_authority ga ON ga.installation_id=v.installation_id AND ga.version_id=v.version_id AND ga.claim_id=c.claim_id AND ga.revision_id=ar.candidate_revision_id
          LEFT JOIN memory_git_governed_revisions gr ON gr.installation_id=ga.installation_id AND gr.revision_id=ga.revision_id AND gr.claim_id=c.claim_id AND gr.review_policy_version_id=ar.review_policy_version_id
          WHERE c.installation_id = $1 AND c.state = 'active'
          ORDER BY c.claim_id FOR SHARE OF c,v
        `, [input.sourceInstallationId])

        if((await sourceSessions()).some(session=>!sessions.includes(session))) {
          throw new TransferError('conflict','source lifecycle changed; retry with current sources')
        }
        if(claims.rows.some(claim=>!observedVersions.some(v=>v.claim_id===claim.claim_id&&v.version_id===claim.version_id)))throw new TransferError('conflict','source metadata changed; retry with current sources')
        for(const recheck of metadataChecks)await recheck()
        // Own all copied evidence before target policy/bootstrap or destination
        // writes; a retry rediscovers rather than locking a new source late.
        const sourceEvidence=(await client.query<{
          version_id:string;evidence_kind:string;excerpt:string;excerpt_hash:string|Buffer;occurred_at:Date|null;locator:Record<string,unknown>|null
        }>(`SELECT version_id::text,evidence_kind,excerpt,excerpt_hash,occurred_at,locator
          FROM knowledge_evidence WHERE installation_id=$1 AND version_id=ANY($2::uuid[])
          ORDER BY version_id,ordinal,evidence_id FOR SHARE`,[input.sourceInstallationId,claims.rows.map(row=>row.version_id)])).rows
        const policy=await loadEffectiveReviewPolicySnapshot(client,input.targetInstallationId,{ensure:true})
        const policyVersionId=policy.activeVersionId,effectivePolicy=policy.policy
        const transferId = randomUUID()
        await client.query(`
          INSERT INTO memory_transfer_runs
            (transfer_id, source_installation_id, target_installation_id, state,
             source_revision, created_by_membership_id)
          VALUES ($1, $2, $3, 'running', $4, $5)
        `, [transferId,input.sourceInstallationId,input.targetInstallationId,
          input.expectedAuthorizationEpoch,targetBinding.membership_id])

        let count = 0
        for (const claim of claims.rows) {
          const sourceHash = contentHashOf(claim.statement)
          const sanitizedEvidence:SharedRevisionEvidence[]=[]
          for(const item of sourceEvidence.filter(item=>item.version_id===claim.version_id)){
            const hash=Buffer.isBuffer(item.excerpt_hash)?item.excerpt_hash.toString('hex'):String(item.excerpt_hash)
            if(contentHashOf(item.excerpt)!==hash)throw new TransferError('conflict','source evidence integrity mismatch')
            const excerpt=sanitizeText(item.excerpt,4000).text
            if(!excerpt||sanitizedEvidence.length>=Math.min(8,effectivePolicy.max_shared_evidence))continue
            const provenance=item.locator?.source_provenance as Record<string,unknown>|undefined
            sanitizedEvidence.push({ordinal:sanitizedEvidence.length+1,evidence_kind:item.evidence_kind,excerpt,excerpt_hash:contentHashOf(excerpt),
              source_evidence_hash:hash,occurred_at:item.occurred_at,sanitized_locator:provenance?.source_kind==='team_session'?{source_provenance:provenance}:null})
          }
          const bundle:RevisionBundle={schemaVersion:2,statement:claim.statement,structuredContent:claim.structured_content??{},
            applicability:captureSourceApplicability({scopeKind:claim.scope_kind,scopeKey:claim.scope_key,canonicalRepositoryKey:claim.canonical_repository_key,
              repositoryId:claim.repository_id,snapshotId:claim.repo_snapshot_id,branch:claim.branch,applicability:claim.applicability,
              consumptionHoldReason:claim.consumption_hold_reason??(!claim.source_metadata_owned||(claim.canonical_repository_key&&!canonicalRepositoryRemotes(claim.canonical_repository_key).includes(claim.source_canonical_remote??''))?'source_metadata_requires_review':null)}),
            sourceSnapshotCommitSha:claim.source_snapshot_commit_sha,sourceRepositoryKey:claim.source_repository_key,sourceContentHash:sourceHash,
            sourceValidFrom:claim.valid_from?.toISOString()??null,sourceValidUntil:claim.valid_until?.toISOString()??null,sourceFreshnessAt:claim.freshness_at?.toISOString()??null,
            evidence:bundleEvidence(sanitizedEvidence),originPolicyHash:claim.source_origin_policy_hash,reviewPolicyHash:canonicalReviewPolicyHash(effectivePolicy)}
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
               structured_content, content_hash, review_policy_version_id, created_by_membership_id,parent_review_policy_version_id,revision_bundle,revision_bundle_hash)
            VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6, $7,$8,$9::jsonb,$10)
          `, [
            candidateRevisionId, candidateId, claim.statement,
            JSON.stringify(claim.structured_content ?? {}), sourceHash,
            policyVersionId, targetBinding.membership_id,policy.parentActiveVersionId,JSON.stringify(bundle),revisionBundleHash(bundle),
          ])
          // Exact retained transfer basis, written with the candidate and run.
          // Fresh Organization votes remain mandatory; ordinary proposals never emit it.
          await client.query(`INSERT INTO memory_governance_events(event_id,installation_id,actor_membership_id,action,target_kind,target_id,next_state,metadata)
            VALUES($1,$2,$3,'transfer_candidate_created','promotion_candidate',$4,'proposed',$5::jsonb)`,
            [randomUUID(),input.targetInstallationId,targetBinding.membership_id,candidateId,JSON.stringify({transfer_id:transferId,bundle_hash:revisionBundleHash(bundle)})])
          for (const item of sanitizedEvidence) {
            await client.query(`
              INSERT INTO memory_promotion_evidence
                (candidate_revision_id, ordinal, evidence_kind, excerpt, excerpt_hash,
                 sanitized_locator, source_evidence_hash, occurred_at)
              VALUES ($1, $2, $3, $4, $5, $8::jsonb, $6, $7)
            `, [
              candidateRevisionId, item.ordinal, item.evidence_kind, item.excerpt,item.excerpt_hash,item.source_evidence_hash,
              item.occurred_at,JSON.stringify(item.sanitized_locator),
            ])
          }
          if (sanitizedEvidence.length === 0) {
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
        await assertCurrentGrantClock(client,input.grant,[input.sourceInstallationId,input.targetInstallationId])
        await client.query('COMMIT')
        return { transferId, candidates: count }
      } catch (error) {
        await client.query('ROLLBACK')
        if(error instanceof TargetBindingError)throw new TransferError('forbidden','current authority required on both installations')
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
