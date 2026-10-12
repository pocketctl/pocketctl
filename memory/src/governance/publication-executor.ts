import {delegationPolicyHash} from './publication-delegation.js'
import type {JobFence} from '../jobs/types.js'
import {assertJobFence} from '../generation/fence.js'
import type pg from 'pg'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import {automationHash} from './automation-policy.js'
import type {VerifiedExecutorGrant} from './automation-acceptance-service.js'
import {loadEffectiveReviewPolicySnapshot} from './review-policy.js'
import {requireCurrentScopePermission,type ValidatedV2Grant} from './authorization.js'
import {createPublicationService,PublicationError} from './publication-service.js'
import type {TombstoneHmacKey} from '../config.js'
export function createPublicationExecutor(deps:{pool:pg.Pool;mode:'off'|'enabled';executorGrant?:VerifiedExecutorGrant;fence?:JobFence;tombstoneHmacKeys?:readonly TombstoneHmacKey[]}){
 return {async execute(delegationId:string):Promise<{published:boolean;reason:string;versionId?:string;claimId?:string}>{
  if(deps.mode!=='enabled')return {published:false,reason:'delegated_publish_off'}
  const grant=deps.executorGrant
  if(!grant||!Number.isFinite(grant.expiresAt))return {published:false,reason:'executor_grant_unproven'}
  // Discover the tuple, then take lifecycle/authority locks before delegation.
  const observed=(await deps.pool.query('SELECT installation_id,principal_id FROM memory_publication_delegations WHERE delegation_id=$1',[delegationId])).rows[0]
  if(!observed||observed.installation_id!==grant.installationId)return {published:false,reason:'delegation_unavailable'}
  const c=await deps.pool.connect()
  try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[observed.installation_id])
   const scope=(await c.query(`SELECT s.*,i.config_version::text FROM memory_owner_scopes s JOIN memory_installations i USING(installation_id) WHERE s.installation_id=$1 AND s.state='active' AND i.local_status NOT IN('purging','purged','integrity_error') AND i.relay_status='active' FOR SHARE OF s,i`,[observed.installation_id])).rows[0]
   const principal=(await c.query(`SELECT * FROM memory_governance_executor_principals WHERE installation_id=$1 AND principal_id=$2 FOR SHARE`,[observed.installation_id,observed.principal_id])).rows[0]
   if(!scope||!principal||principal.state!=='active'||!principal.permissions.includes('publish_delegated')||principal.provider_client_id!==grant.providerClientId||String(principal.permission_revision)!==grant.permissionRevision||String(principal.authorization_epoch)!==grant.authorizationEpoch||String(scope.authorization_epoch)!==grant.authorizationEpoch)throw new Error('executor_not_authorized')
   const d=(await c.query('SELECT * FROM memory_publication_delegations WHERE delegation_id=$1 FOR UPDATE',[delegationId])).rows[0]
   if(!d||d.installation_id!==observed.installation_id||d.principal_id!==observed.principal_id||d.state==='revoked')throw new Error('delegation_revoked')
   const humanGrant:ValidatedV2Grant={primaryInstallationId:d.installation_id,configVersion:scope.config_version,scopeBindings:[{installation_id:d.installation_id,owner_scope_kind:scope.owner_scope_kind,owner_scope_id:scope.owner_scope_id,membership_id:d.delegated_by_membership_id,membership_revision:String(d.delegated_by_membership_revision),authorization_epoch:String(d.authorization_epoch),permissions:['read','publish']}]}
   await requireCurrentScopePermission({client:c,grant:humanGrant,targetInstallationId:d.installation_id,permission:'publish'})
   if(!(await c.query(`SELECT d.valid_until>clock_timestamp() AND p.valid_until>clock_timestamp() AND clock_timestamp()<to_timestamp($2) AS valid FROM memory_publication_delegations d JOIN memory_governance_executor_principals p USING(installation_id,principal_id) WHERE d.delegation_id=$1`,[delegationId,grant.expiresAt])).rows[0]?.valid)throw new Error('delegation_expired')
   const automation=(await c.query(`SELECT p.* FROM memory_review_automation_policy_heads h JOIN memory_review_automation_policies p USING(policy_id) WHERE h.installation_id=$1 FOR SHARE OF h`,[d.installation_id])).rows[0]
   if(!automation||automation.policy_id!==d.automation_policy_id||automation.document.delegatedPublish!==true||automation.document.mode==='off')throw new Error('delegation_policy_changed')
   const policyHash=await delegationPolicyHash(c,d.installation_id)
   if(policyHash!==d.policy_snapshot_hash)throw new Error('delegation_policy_changed')
   if(d.state==='consumed'){
    const v=(await c.query('SELECT v.claim_id,c.state,c.current_version_id FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id) WHERE v.installation_id=$1 AND v.version_id=$2',[d.installation_id,d.published_version_id])).rows[0]
    await c.query('COMMIT');return v?.state==='active'&&v.current_version_id===d.published_version_id?{published:true,reason:'replayed',versionId:d.published_version_id,claimId:v.claim_id}:{published:false,reason:'human_override'}
   }
   const candidate=(await c.query(`SELECT c.revision,v.candidate_revision_id,v.revision_bundle_hash FROM memory_promotion_candidates c JOIN memory_promotion_candidate_versions v ON v.candidate_id=c.candidate_id AND v.revision_number=c.revision WHERE c.target_installation_id=$1 AND c.candidate_id=$2 FOR UPDATE OF c`,[d.installation_id,d.candidate_id])).rows[0]
   if(!candidate||Number(candidate.revision)!==Number(d.candidate_revision)||candidate.candidate_revision_id!==d.candidate_revision_id||candidate.revision_bundle_hash!==d.bundle_hash)throw new Error('delegation_revision_conflict')
   if(deps.fence)await assertJobFence(c,deps.fence)
   await c.query("SELECT set_config('pocketctl.automation_actor',$1,true)",[JSON.stringify({principalId:d.principal_id,permissionRevision:grant.permissionRevision,grantExpiresAt:grant.expiresAt})])
   await c.query("SELECT set_config('pocketctl.publication_delegation',$1,true)",[JSON.stringify({delegationId})])
   const result=await createPublicationService(createTransactionBoundPool(c),{tombstoneHmacKeys:deps.tombstoneHmacKeys}).publish({grant:humanGrant,targetInstallationId:d.installation_id,candidateId:d.candidate_id,expectedCandidateRevision:Number(d.candidate_revision),resolution:'new',executorPrincipalId:d.principal_id,publicationDelegationId:delegationId})
   await c.query("UPDATE memory_publication_delegations SET state='consumed',published_version_id=$2 WHERE delegation_id=$1",[delegationId,result.versionId])
   await c.query('COMMIT');return {published:true,reason:'human_quorum_published',versionId:result.versionId,claimId:result.claimId}
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);const reason=e instanceof PublicationError?e.code:e instanceof Error?e.message:'';const known=['executor_not_authorized','delegation_revoked','delegation_expired','delegation_policy_changed','delegation_revision_conflict','publication_delegation_expired','automation_actor_expired','forbidden','quorum_failed','expired','state_conflict','revision_conflict','policy_head_changed'];return {published:false,reason:known.includes(reason)?reason:'delegated_publication_failed'}}finally{c.release()}
 }}
}
