import {classifyClaimConflict} from '../claims/conflict-classifier.js'
import {claimIdentityV2} from '../claims/identity.js'
import {findClaimTopicFamily} from '../claims/identity-lookup.js'
import {publicationApplicability,PublicationApplicabilityError} from './publication-applicability.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'
import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import type {
  PromotionCandidateRow,
  PromotionCandidateVersionRow,
  ReviewDecisionRow,
} from './types.js'
import {assertCurrentGrantClock,requireCurrentScopePermission,TargetBindingError,type ValidatedV2Grant} from './authorization.js'
import {restoreLegacyRevisionBundle} from './legacy-revision-bundle.js'
import {parseRevisionMetadataPatch,applyRevisionMetadata,lockRevisionSourceMetadata,type RevisionMetadataPatch} from './revision-metadata.js'
import {prepareRevisionEvidence,type RevisionEvidenceSelection} from './proposal-revision-evidence.js'
import {bundleEvidence,revisionBundleHash,verifyRevisionBundle,type RevisionBundle,type SharedRevisionEvidence} from './revision-bundle.js'
import {canonicalReviewPolicyHash, loadEffectiveReviewPolicySnapshot } from './review-policy.js'

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
          AND (state NOT IN('proposed','changes_requested','approved','conflict') OR expires_at>clock_timestamp())
        ORDER BY created_at ASC, candidate_id ASC
        LIMIT 100
      `, [targetInstallationId, states && states.length > 0 ? states : null])
      return result.rows.map(toCandidate)
    },

    async getRevision(candidateId: string, revisionId: string): Promise<PromotionCandidateVersionRow | null> {
      const result = await pool.query('SELECT * FROM memory_promotion_candidate_versions WHERE candidate_id=$1 AND candidate_revision_id=$2', [candidateId, revisionId])
      return result.rows[0] as PromotionCandidateVersionRow | undefined ?? null
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
    async listConflictClaims(targetInstallationId:string,candidate:Pick<PromotionCandidateRow,'candidate_id'|'target_claim_type'>):Promise<Array<{claim_id:string;statement:string;conflict_variant:number}>>{
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        const latest=(await client.query(`SELECT v.* FROM memory_promotion_candidate_versions v
          JOIN memory_promotion_candidates c ON c.candidate_id=v.candidate_id
          WHERE c.target_installation_id=$1 AND c.candidate_id=$2 ORDER BY v.revision_number DESC LIMIT 1`,[targetInstallationId,candidate.candidate_id])).rows[0]
        let rows:Array<{claim_id:string;statement:string;conflict_variant:number}>=[]
        if(latest){
          const evidence=(await client.query('SELECT * FROM memory_promotion_evidence WHERE candidate_revision_id=$1 ORDER BY ordinal',[latest.candidate_revision_id])).rows
          if(verifyRevisionBundle(latest,evidence)){
            const mapped=await publicationApplicability(client,latest.revision_bundle,targetInstallationId)
            const proposed={...mapped,claimType:candidate.target_claim_type,statement:latest.statement,structuredContent:latest.structured_content,validFrom:latest.revision_bundle.sourceValidFrom,validUntil:latest.revision_bundle.sourceValidUntil}
            const topic=await findClaimTopicFamily(client,{installationId:targetInstallationId,claimType:candidate.target_claim_type,applicability:mapped,statement:latest.statement})
            rows=topic.filter(row=>claimIdentityV2(row.facts).key===claimIdentityV2(proposed).key||classifyClaimConflict(proposed,row.facts).relation==='potential_conflict')
          }
        }
        await client.query('COMMIT')
        return rows.sort((a,b)=>a.conflict_variant-b.conflict_variant||a.claim_id.localeCompare(b.claim_id)).slice(0,100).map(row=>({claim_id:row.claim_id,statement:row.statement,conflict_variant:row.conflict_variant}))
      }catch(error){await client.query('ROLLBACK');if(error instanceof PublicationApplicabilityError)return[];throw error}
      finally{client.release()}
    },

    /** Append an immutable proposal revision (edit creates revision N+1). */
    async appendRevision(input: {
      targetInstallationId: string
      candidateId: string
      expectedRevision: number
      statement: string
      structuredContent: Record<string, unknown>
      /** Legacy callers may supply this; the server always recomputes. */
      contentHash?: string
      evidenceSelection: RevisionEvidenceSelection
      repairLegacyBundle?: boolean
      refreshSourceMetadata?: boolean
      metadataPatch?: RevisionMetadataPatch
      grant?: ValidatedV2Grant
      createdByMembershipId: string | null
    }): Promise<{ candidateRevisionId: string; revisionNumber: number; evidenceChanges: {retained:number;removed:number;added:number} }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if(input.refreshSourceMetadata!==undefined&&typeof input.refreshSourceMetadata!=='boolean')throw new Error('invalid revision metadata refresh')
        const metadataPatch=input.metadataPatch===undefined?undefined:parseRevisionMetadataPatch(input.metadataPatch)
        const needsMetadata=metadataPatch!==undefined||input.refreshSourceMetadata===true
        if(input.grant){
          const binding=input.grant.scopeBindings.find(b=>b.installation_id===input.targetInstallationId)
          await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:input.targetInstallationId,permission:binding?.permissions.includes('review')?'review':'contribute'})
        }
        // Copying new evidence or explicitly repairing a legacy bundle needs
        // the current source. Discover without locks, then acquire that source
        // before candidate/policy locks, matching propose and source purge.
        const observed=(await client.query<{source_installation_id:string;source_claim_id:string;source_version_id:string;legacy:boolean}>(`
          SELECT c.source_installation_id,c.source_claim_id,c.source_version_id,
            (r.revision_bundle IS NULL AND r.revision_bundle_hash IS NULL) AS legacy
          FROM memory_promotion_candidates c
          JOIN LATERAL(SELECT revision_bundle,revision_bundle_hash FROM memory_promotion_candidate_versions
            WHERE candidate_id=c.candidate_id ORDER BY revision_number DESC LIMIT 1) r ON true
          WHERE c.target_installation_id=$1 AND c.candidate_id=$2`,[input.targetInstallationId,input.candidateId])).rows[0]
        const needsSource=Boolean(needsMetadata||input.evidenceSelection?.newEvidenceIds?.length||(input.repairLegacyBundle&&observed?.legacy))
        let recheckMetadata:(()=>Promise<void>)|undefined
        if(needsSource&&observed){
          if(!input.grant)throw new Error('source authorization required')
          try{await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:observed.source_installation_id,permission:'read'})}
          catch(error){if(error instanceof TargetBindingError)throw new TargetBindingError('source authority is stale');throw error}
          if(needsMetadata)recheckMetadata=await lockRevisionSourceMetadata(client,observed.source_installation_id,observed.source_version_id)
          await client.query('SELECT claim_id FROM knowledge_claims WHERE installation_id=$1 AND claim_id=$2 FOR SHARE',
            [observed.source_installation_id,observed.source_claim_id])
          await recheckMetadata?.()
        }
        const locked = await client.query<{ state: string; revision: string | number;source_installation_id:string;source_version_id:string;source_claim_id:string;source_content_hash:string;scope_key:string;target_claim_type:string;created_by_membership_id:string|null }>(`
          SELECT state, revision,source_installation_id,source_version_id,source_claim_id,source_content_hash,scope_key,target_claim_type,created_by_membership_id FROM memory_promotion_candidates
          WHERE target_installation_id = $1 AND candidate_id = $2 FOR UPDATE
        `, [input.targetInstallationId, input.candidateId])
        const row = locked.rows[0]
        if (!row) throw new Error('candidate not found')
        if(needsSource&&(!observed||row.source_installation_id!==observed.source_installation_id
          ||row.source_claim_id!==observed.source_claim_id||row.source_version_id!==observed.source_version_id))throw new Error('candidate source revision changed')
        if (Number(row.revision) !== input.expectedRevision) throw new Error('candidate revision mismatch')
        if(input.grant){
          const binding=input.grant.scopeBindings.find(b=>b.installation_id===input.targetInstallationId)!
          if(binding.membership_id!==row.created_by_membership_id&&!binding.permissions.includes('review'))throw new Error('proposal revision forbidden')
        }
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
        const previous=(await client.query<{candidate_revision_id:string;revision_bundle:RevisionBundle|null;revision_bundle_hash:string|null;statement:string;structured_content:Record<string,unknown>}>(
          'SELECT candidate_revision_id,revision_bundle,revision_bundle_hash,statement,structured_content FROM memory_promotion_candidate_versions WHERE candidate_id=$1 ORDER BY revision_number DESC LIMIT 1 FOR SHARE',[input.candidateId])).rows[0]
        if(!previous)throw new Error('candidate revision not found')
        const legacy=previous.revision_bundle===null&&previous.revision_bundle_hash===null
        if(legacy&&!input.repairLegacyBundle)throw new Error('legacy revision evidence bundle requires explicit remediation')
        // A mixed legacy writer may advance the candidate while discovery
        // waits. Restart instead of acquiring a newly required source lock
        // after candidate/policy locks or omitting that source's final fence.
        if(legacy&&input.repairLegacyBundle&&!needsSource)throw new Error('candidate source revision changed')
        const previousEvidence=(await client.query<SharedRevisionEvidence>('SELECT ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,sanitized_locator FROM memory_promotion_evidence WHERE candidate_revision_id=$1 ORDER BY ordinal FOR SHARE',[previous.candidate_revision_id])).rows
        if(!verifyRevisionBundle(previous,previousEvidence))throw new Error('predecessor revision bundle integrity mismatch')
        const evidence=await prepareRevisionEvidence({client,candidateId:input.candidateId,sourceInstallationId:row.source_installation_id,sourceVersionId:row.source_version_id,
          previousRevisionId:previous.candidate_revision_id,selection:input.evidenceSelection,maxEvidence:policySnapshot.policy.max_shared_evidence,grant:input.grant})
        const inherited=legacy?await restoreLegacyRevisionBundle({client,grant:input.grant,sourceInstallationId:row.source_installation_id,sourceClaimId:row.source_claim_id,
          sourceVersionId:row.source_version_id,sourceContentHash:row.source_content_hash,retainedEvidence:previousEvidence.filter(e=>input.evidenceSelection.retainedOrdinals.includes(e.ordinal)),
          reviewPolicyHash:canonicalReviewPolicyHash(policySnapshot.policy)}):previous.revision_bundle!
        const sourceMetadata=needsMetadata?await restoreLegacyRevisionBundle({client,grant:input.grant,sourceInstallationId:row.source_installation_id,
          sourceClaimId:row.source_claim_id,sourceVersionId:row.source_version_id,sourceContentHash:row.source_content_hash,
          retainedEvidence:[],reviewPolicyHash:canonicalReviewPolicyHash(policySnapshot.policy)}):undefined
        const metadata=input.refreshSourceMetadata?sourceMetadata!:inherited
        const revisedMetadata=applyRevisionMetadata(metadata,metadataPatch,sourceMetadata)
        const bundle:RevisionBundle={...revisedMetadata,statement:input.statement,structuredContent:input.structuredContent,
          evidence:bundleEvidence(evidence),reviewPolicyHash:canonicalReviewPolicyHash(policySnapshot.policy)}
        delete bundle.relationships // New statement/conditions/Evidence require a fresh comparison; old hints are immutable history.
        const inserted = await client.query<{ candidate_revision_id: string }>(`
          INSERT INTO memory_promotion_candidate_versions
            (candidate_revision_id, candidate_id, revision_number, statement,
             structured_content, content_hash, review_policy_version_id,
             parent_review_policy_version_id, created_by_membership_id,revision_bundle,revision_bundle_hash)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,$10::jsonb,$11)
          RETURNING candidate_revision_id
        `, [
          randomUUID(), input.candidateId, Number(next.rows[0].next),
          input.statement, JSON.stringify(input.structuredContent), createHash('sha256').update(input.statement).digest('hex'),
          policySnapshot.activeVersionId, policySnapshot.parentActiveVersionId,
          input.createdByMembershipId,JSON.stringify(bundle),revisionBundleHash(bundle),
        ])
        for(const item of evidence)await client.query(`INSERT INTO memory_promotion_evidence(candidate_revision_id,ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at,sanitized_locator)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[inserted.rows[0].candidate_revision_id,item.ordinal,item.evidence_kind,item.excerpt,item.excerpt_hash,item.source_evidence_hash,item.occurred_at,JSON.stringify(item.sanitized_locator)])
        await client.query(`
          UPDATE memory_promotion_candidates
          SET revision = revision + 1,normalized_key=$4,
              state = CASE WHEN state IN('changes_requested','conflict') THEN 'proposed' ELSE state END,
              duplicate_of_claim_id=NULL,conflict_group_id=NULL,
              updated_at = NOW()
          WHERE target_installation_id = $1 AND candidate_id = $2 AND revision = $3
        `, [input.targetInstallationId,input.candidateId,input.expectedRevision,normalizedClaimKey({claimType:row.target_claim_type,scopeKey:row.scope_key,statement:input.statement})])
        if(input.grant)await assertCurrentGrantClock(client,input.grant,[input.targetInstallationId,...(needsSource?[row.source_installation_id]:[])])
        await client.query('COMMIT')
        return {
          candidateRevisionId: inserted.rows[0].candidate_revision_id,
          revisionNumber: Number(next.rows[0].next),
          evidenceChanges:{retained:input.evidenceSelection.retainedOrdinals.length,removed:input.evidenceSelection.removedOrdinals.length,added:input.evidenceSelection.newEvidenceIds.length},
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
