import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { V2GrantFacts } from './authorization.js'
import { createScopeAuthorization } from './authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import type { ClaimAsset, RuleAsset } from '../git-sync/types.js'
import { assertImportApproval, type GovernedImport } from '../git-sync/governance-adapter.js'

type ClaimRevisionInput={grant:V2GrantFacts;installationId:string;governed:GovernedImport}
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
  await assertImportApproval(client,input.governed,binding.membership_id)
  const g=input.governed,current=g.current.asset as ClaimAsset|RuleAsset,result=g.proposal.proposed_document.result
  if(result.kind==='conflict'||!g.revisionId||!g.author||!g.countedDecisionIds.length)throw new Error('git_quorum_failed')
  const next=result.asset.asset as ClaimAsset|RuleAsset
  const row=(await client.query(`SELECT c.*,v.version_number FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
    WHERE c.installation_id=$1 AND c.claim_id=$2 AND c.owner_scope_kind=$3 AND c.owner_scope_id=$4 FOR UPDATE OF c`,
  [input.installationId,current.key.id,binding.owner_scope_kind,binding.owner_scope_id])).rows[0]
  if(!row||row.state!=='active'||row.current_version_id!==current.baseVersionId||row.revision!==current.baseRevision)throw new Error('git_revision_conflict')
  const evidence=(await client.query(`SELECT evidence_id,encode(excerpt_hash,'hex') AS hash FROM knowledge_evidence
    WHERE installation_id=$1 AND version_id=$2 AND visibility='shared' ORDER BY ordinal FOR SHARE`,[input.installationId,current.baseVersionId])).rows
  if(!evidence.length||evidence.length>g.policy.policy.max_shared_evidence||evidence.length!==current.immutable.evidence.length
    ||evidence.some(e=>!current.immutable.evidence.some(ref=>ref.evidenceId===e.evidence_id&&ref.hash===e.hash)))throw new Error('git_source_stale')
  const revision=(BigInt(current.baseRevision)+1n).toString()
  const deleting=result.asset.deleted,versionId=deleting?current.baseVersionId:randomUUID()
  if(!deleting){
  await client.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,
    repository_id,repo_snapshot_id,branch,valid_from,valid_until,source_candidate_id,freshness_at,source_promotion_candidate_id)
    SELECT $1,installation_id,claim_id,version_number+1,$3,$4,authority,confidence,repository_id,repo_snapshot_id,branch,valid_from,valid_until,
    source_candidate_id,freshness_at,source_promotion_candidate_id FROM knowledge_versions WHERE installation_id=$5 AND version_id=$2`,
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
  for(const id of g.countedDecisionIds)await client.query('INSERT INTO memory_git_claim_authority_decisions(installation_id,version_id,decision_id) VALUES($1,$2,$3)',[input.installationId,versionId,id])
  }
  let activated=false
  return {versionId,revision,outcome:deleting?'revoked':'published',async activate(){
    if(activated)throw new Error('git_governance_required')
    await assertImportApproval(client,g,binding.membership_id)
    const fresh=await auth.validateV2Grant(input.grant)
    if(!fresh||!auth.hasPermission(fresh,input.installationId,'publish'))throw new Error('git_forbidden')
    activated=true
    const changed=await client.query(`UPDATE knowledge_claims SET current_version_id=$3,revision=revision+1,
      state=$6,updated_at=NOW() WHERE installation_id=$1 AND claim_id=$2 AND current_version_id=$4 AND revision=$5 AND state='active'`,
    [input.installationId,current.key.id,versionId,current.baseVersionId,current.baseRevision,deleting?'revoked':'active'])
    if(changed.rowCount!==1)throw new Error('git_revision_conflict')
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
        await client.query('COMMIT')
        return {versionId:prepared.versionId,revision:prepared.revision,outcome:prepared.outcome}
      } catch(error){await client.query('ROLLBACK');throw error} finally{client.release()}
    },
  }
}
