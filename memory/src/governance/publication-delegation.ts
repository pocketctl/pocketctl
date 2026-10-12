import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {automationHash} from './automation-policy.js'
import {requireCurrentScopePermission,assertCurrentGrantClock,type ValidatedV2Grant} from './authorization.js'
import {loadEffectiveReviewPolicySnapshot} from './review-policy.js'
export async function delegationPolicyHash(c:Pick<pg.PoolClient,'query'>,installationId:string){
 const policy=await loadEffectiveReviewPolicySnapshot(c,installationId)
 const heads=(await c.query(`SELECT s.installation_id,h.active_version_id,h.revision::text FROM memory_review_policy_sets s JOIN memory_review_policy_heads h USING(policy_id) WHERE s.installation_id=$1 OR s.installation_id IN(SELECT parent.installation_id FROM memory_owner_scopes child JOIN memory_owner_scopes parent ON parent.owner_scope_kind='organization' AND parent.owner_scope_id=child.parent_organization_id WHERE child.installation_id=$1) ORDER BY s.installation_id`,[installationId])).rows
 return automationHash({policy,heads})
}
export function createPublicationDelegation(pool:pg.Pool){
 async function tx<T>(fn:(c:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}}
 function human(grant:ValidatedV2Grant&{callerType?:string}){if(!['web','ios'].includes(grant.callerType??''))throw new Error('human_delegation_authorizer_required')}
 return {
 async create(input:{grant:ValidatedV2Grant&{callerType?:string};installationId:string;candidateId:string;expectedRevision:number;expectedHash:string;principalId:string;expiresAt:string}){
  human(input.grant)
  return tx(async c=>{
   const binding=await requireCurrentScopePermission({client:c,grant:input.grant,targetInstallationId:input.installationId,permission:'publish'})
   if(!binding.membership_id||binding.owner_scope_kind==='personal')throw new Error('shared_human_authorizer_required')
   const automation=(await c.query(`SELECT p.* FROM memory_review_automation_policy_heads h JOIN memory_review_automation_policies p USING(policy_id) WHERE h.installation_id=$1 FOR SHARE OF h`,[input.installationId])).rows[0]
   if(!automation||automation.document.delegatedPublish!==true||automation.document.mode==='off')throw new Error('delegated_policy_off')
   const principal=(await c.query(`SELECT 1 FROM memory_governance_executor_principals WHERE installation_id=$1 AND principal_id=$2 AND state='active' AND 'publish_delegated'=ANY(permissions) AND valid_until>clock_timestamp() FOR SHARE`,[input.installationId,input.principalId])).rows[0]
   if(!principal)throw new Error('executor_not_authorized')
   const candidate=(await c.query(`SELECT c.revision,v.candidate_revision_id,v.revision_bundle_hash FROM memory_promotion_candidates c JOIN memory_promotion_candidate_versions v ON v.candidate_id=c.candidate_id AND v.revision_number=c.revision WHERE c.target_installation_id=$1 AND c.candidate_id=$2 AND c.state IN('proposed','approved','conflict','changes_requested') AND c.expires_at>clock_timestamp() FOR SHARE OF c,v`,[input.installationId,input.candidateId])).rows[0]
   if(!candidate||Number(candidate.revision)!==input.expectedRevision||candidate.revision_bundle_hash!==input.expectedHash||!/^[a-f0-9]{64}$/.test(input.expectedHash))throw new Error('delegation_revision_conflict')
   const policyHash=await delegationPolicyHash(c,input.installationId)
   if(!(await c.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '1 day' AS valid",[input.expiresAt])).rows[0].valid)throw new Error('delegation_expiry_invalid')
   const delegationId=randomUUID()
   await c.query(`INSERT INTO memory_publication_delegations(delegation_id,installation_id,candidate_id,candidate_revision_id,candidate_revision,bundle_hash,policy_snapshot_hash,principal_id,delegated_by_membership_id,delegated_by_membership_revision,authorization_epoch,valid_until,automation_policy_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[delegationId,input.installationId,input.candidateId,candidate.candidate_revision_id,input.expectedRevision,input.expectedHash,policyHash,input.principalId,binding.membership_id,binding.membership_revision,binding.authorization_epoch,input.expiresAt,automation.policy_id])
   await assertCurrentGrantClock(c,input.grant,[input.installationId]);return {delegationId}
  })
 },
 async revoke(input:{grant:ValidatedV2Grant&{callerType?:string};installationId:string;delegationId:string}){
  human(input.grant);return tx(async c=>{await requireCurrentScopePermission({client:c,grant:input.grant,targetInstallationId:input.installationId,permission:'publish'});await c.query("UPDATE memory_publication_delegations SET state='revoked' WHERE installation_id=$1 AND delegation_id=$2 AND state='active'",[input.installationId,input.delegationId]);await assertCurrentGrantClock(c,input.grant,[input.installationId]);return {revoked:true}})
 },
 }
}
