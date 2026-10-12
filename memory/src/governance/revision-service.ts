import {activateRevisionInterval} from '../claims/version-selection.js'
import type {TombstoneHmacKey} from '../config.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'
import {resolveClaimApplicability,projectClaimIdentity,assertIdentityNotTombstoned,assertClaimIdentityAvailable,assertCurrentIdentityProjection} from '../claims/identity-writer.js'
import {claimIdentityV2} from '../claims/identity.js'
import {requireCurrentScopePermission} from './authorization.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { V2GrantFacts } from './authorization.js'
import {assertCurrentGrantClock,TargetBindingError, createScopeAuthorization } from './authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import type { ClaimAsset, RuleAsset } from '../git-sync/types.js'
import { assertImportApproval, type GovernedImport } from '../git-sync/governance-adapter.js'

type ClaimRevisionInput={grant:V2GrantFacts;installationId:string;governed:GovernedImport;tombstoneHmacKeys?:readonly TombstoneHmacKey[]}
interface PreparedClaimRevision {versionId:string;revision:string;outcome:'published'|'revoked';activate():Promise<void>}

/** Internal same-transaction preparation. The capability is a one-use closure,
 * not a request flag or serialized proof. The importer records its exact outcome
 * before activation can invalidate a dependent Skill and the Git projection. */
export async function prepareClaimRevision(client:pg.PoolClient,input:ClaimRevisionInput):Promise<PreparedClaimRevision> {
  const result=input.governed?.proposal?.proposed_document.result
  if(!['claim','rule'].includes(input.governed?.current?.asset.key.kind)||!result||result.kind==='conflict'||result.asset.deleted)throw new Error('git_governance_required')
  return prepareRevision(client,input)
}

async function prepareRevision(client:pg.PoolClient,input:ClaimRevisionInput):Promise<PreparedClaimRevision> {
  await assertImportApproval(client,input.governed)
  const auth=createScopeAuthorization(createTransactionBoundPool(client)),grant=await auth.validateV2Grant(input.grant)
  const binding=grant?.scopeBindings.find(b=>b.installation_id===input.installationId)
  if(!grant||!binding||!auth.hasPermission(grant,input.installationId,'publish')||binding.owner_scope_kind==='personal')throw new Error('git_forbidden')
  await requireCurrentScopePermission({client,grant,targetInstallationId:input.installationId,permission:'publish'})
  await assertImportApproval(client,input.governed,binding.membership_id)
  const g=input.governed,current=g.current.asset as ClaimAsset|RuleAsset,result=g.proposal.proposed_document.result
  if(result.kind==='conflict'||!g.revisionId||!g.author||!g.countedDecisionIds.length)throw new Error('git_quorum_failed')
  const next=result.asset.asset as ClaimAsset|RuleAsset
  const row=(await client.query(`SELECT c.*,v.version_number,to_jsonb(v) AS source_version_metadata FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
    WHERE c.installation_id=$1 AND c.claim_id=$2 AND c.owner_scope_kind=$3 AND c.owner_scope_id=$4 FOR UPDATE OF c`,
  [input.installationId,current.key.id,binding.owner_scope_kind,binding.owner_scope_id])).rows[0]
  if(!row||row.state!=='active'||row.current_version_id!==current.baseVersionId||row.revision!==current.baseRevision)throw new Error('git_revision_conflict')
  const evidence=(await client.query(`SELECT evidence_id,encode(excerpt_hash,'hex') AS hash FROM knowledge_evidence
    WHERE installation_id=$1 AND version_id=$2 AND visibility='shared' ORDER BY ordinal FOR SHARE`,[input.installationId,current.baseVersionId])).rows
  if(!evidence.length||evidence.length>g.policy.policy.max_shared_evidence||evidence.length!==current.immutable.evidence.length
    ||evidence.some(e=>!current.immutable.evidence.some(ref=>ref.evidenceId===e.evidence_id&&ref.hash===e.hash)))throw new Error('git_source_stale')
  const revision=(BigInt(current.baseRevision)+1n).toString()
  const deleting=result.asset.deleted,versionId=deleting?current.baseVersionId:randomUUID()
  const hasV2=Object.hasOwn(row,'topic_key_v2')
  const applicability=deleting?null:await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind:row.scope_kind,scopeKey:row.scope_key,
    canonicalRepositoryKey:row.canonical_repository_key,repositoryId:row.source_version_metadata.repository_id,snapshotId:row.source_version_metadata.repo_snapshot_id,
    branch:row.source_version_metadata.branch,applicability:row.source_version_metadata.applicability,consumptionHoldReason:row.consumption_hold_reason})
  if(!deleting&&hasV2){
    const prior=await projectClaimIdentity(client,{installationId:input.installationId,claimType:row.claim_type,statement:row.source_version_metadata.statement,
      structuredContent:row.source_version_metadata.structured_content??{},applicability:applicability!,validFrom:row.source_version_metadata.valid_from,validUntil:row.source_version_metadata.valid_until})
    assertCurrentIdentityProjection(row,prior)
  }
  const projection=deleting?null:hasV2?await projectClaimIdentity(client,{installationId:input.installationId,claimType:row.claim_type,statement:next.editable.statement,
    structuredContent:next.editable.structuredContent,applicability:applicability!,validFrom:row.source_version_metadata.valid_from,validUntil:row.source_version_metadata.valid_until})
    :{generation:1 as const,legacyKey:normalizedClaimKey({claimType:row.claim_type,scopeKey:row.scope_key,statement:next.editable.statement}),keyV2:null,topicKeyV2:null,duplicateDigestV2:null}
  if(projection){
    await assertIdentityNotTombstoned(client,{installationId:input.installationId,projection,keys:input.tombstoneHmacKeys??[]})
    if(hasV2)await assertClaimIdentityAvailable(client,{installationId:input.installationId,claimType:row.claim_type,scopeKey:row.scope_key,projection,excludeClaimId:current.key.id,variant:row.conflict_variant})
  }
  if(!deleting){
  // Pre-expand upgrade fixtures have no applicability column. Detect actual source schema;
  // current-schema null/explicit values are both copied, never discarded on content revision.
  const applicabilityColumn=Object.hasOwn(row.source_version_metadata,'applicability')?',applicability':''
  await client.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,
    repository_id,repo_snapshot_id,branch,valid_from,valid_until,source_candidate_id,freshness_at,source_promotion_candidate_id${applicabilityColumn})
    SELECT $1,installation_id,claim_id,version_number+1,$3,$4,authority,confidence,repository_id,repo_snapshot_id,branch,valid_from,valid_until,
    source_candidate_id,freshness_at,source_promotion_candidate_id${applicabilityColumn} FROM knowledge_versions WHERE installation_id=$5 AND version_id=$2`,
  [versionId,current.baseVersionId,next.editable.statement,next.editable.structuredContent,input.installationId])
  await client.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,source_event_id,artifact_id,evidence_kind,locator,
    excerpt,excerpt_hash,occurred_at,ordinal,visibility,source_evidence_hash,contributor_membership_id)
    SELECT gen_random_uuid(),installation_id,$1,episode_id,source_event_id,artifact_id,evidence_kind,locator,excerpt,excerpt_hash,occurred_at,ordinal,
    visibility,source_evidence_hash,contributor_membership_id FROM knowledge_evidence WHERE installation_id=$2 AND version_id=$3`,[versionId,input.installationId,current.baseVersionId])
  await client.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,parent_review_policy_version_id,
    counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [randomUUID(),input.installationId,versionId,g.revisionId,g.policy.activeVersionId,g.policy.parentActiveVersionId,g.countedDecisionIds,binding.membership_id,binding.owner_scope_kind,g.current.contentHash])
  await client.query(`INSERT INTO memory_git_claim_authority(installation_id,claim_id,version_id,revision_id,publisher_membership_id,publisher_membership_revision,publisher_authorization_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.installationId,current.key.id,versionId,g.revisionId,binding.membership_id,binding.membership_revision,binding.authorization_epoch])
  if(hasV2)await client.query('UPDATE knowledge_versions SET applicability=$3::jsonb WHERE installation_id=$1 AND version_id=$2',[input.installationId,versionId,JSON.stringify(applicability)])
  for(const id of g.countedDecisionIds)await client.query('INSERT INTO memory_git_claim_authority_decisions(installation_id,version_id,decision_id) VALUES($1,$2,$3)',[input.installationId,versionId,id])
  }
  let activated=false
  return {versionId,revision,outcome:deleting?'revoked':'published',async activate(){
    if(activated)throw new Error('git_governance_required')
    await assertImportApproval(client,g,binding.membership_id)
    const fresh=await auth.validateV2Grant(input.grant)
    if(!fresh||!auth.hasPermission(fresh,input.installationId,'publish'))throw new Error('git_forbidden')
    if(!deleting && Object.hasOwn(row.source_version_metadata,'effective_from'))await activateRevisionInterval(client,{installationId:input.installationId,claimId:current.key.id,previousVersionId:current.baseVersionId,versionId})
    activated=true
    const changed=await client.query(`UPDATE knowledge_claims SET current_version_id=$3,revision=revision+1,
      state=$6,updated_at=NOW() WHERE installation_id=$1 AND claim_id=$2 AND current_version_id=$4 AND revision=$5 AND state='active'`,
    [input.installationId,current.key.id,versionId,current.baseVersionId,current.baseRevision,deleting?'revoked':'active'])
    if(changed.rowCount!==1)throw new Error('git_revision_conflict')
    if(projection)await client.query(hasV2?`UPDATE knowledge_claims SET normalized_key=$3,normalized_key_v2=$4,topic_key_v2=$5,duplicate_digest_v2=$6,
      canonical_repository_key=$7,identity_generation=GREATEST(identity_generation,$8),consumption_hold_reason=CASE WHEN $9 THEN COALESCE(consumption_hold_reason,'identity_requires_review') ELSE consumption_hold_reason END WHERE installation_id=$1 AND claim_id=$2`
      :'UPDATE knowledge_claims SET normalized_key=$3 WHERE installation_id=$1 AND claim_id=$2',
      hasV2?[input.installationId,current.key.id,projection.legacyKey,projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2,applicability!.canonicalRepositoryKey,projection.generation,applicability!.status!=='verified']
        :[input.installationId,current.key.id,projection.legacyKey])
    if(deleting)await client.query(`INSERT INTO memory_governance_events(event_id,installation_id,actor_membership_id,action,target_kind,target_id,previous_state,next_state)
      VALUES($1,$2,$3,'shared_claim_revoked','knowledge_claim',$4,'active','revoked')`,[randomUUID(),input.installationId,binding.membership_id,current.key.id])
    else await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
      VALUES($1,$2,'index_shared_claim',$3,60,$4) ON CONFLICT DO NOTHING`,[randomUUID(),input.installationId,`index_shared_claim:${current.key.id}:${versionId}`,{claim_id:current.key.id,version_id:versionId}])
  }}
}

/** Same-Scope revision preserves metadata/Evidence. Promotion remains a separate
 * operation; existing immediate callers still activate inside their transaction. */
export function createClaimRevisionService(pool:pg.Pool) {
  return {
    async append(input:ClaimRevisionInput):Promise<{versionId:string;revision:string;outcome:'published'|'revoked'}> {
      const client=await pool.connect()
      try {
        await client.query('BEGIN')
        const prepared=await prepareRevision(client,input)
        await prepared.activate()
        try{await assertCurrentGrantClock(client,input.grant)}catch(error){if(error instanceof TargetBindingError)throw new Error('git_forbidden');throw error}
        await client.query('COMMIT')
        return {versionId:prepared.versionId,revision:prepared.revision,outcome:prepared.outcome}
      } catch(error){await client.query('ROLLBACK');throw error} finally{client.release()}
    },
  }
}
