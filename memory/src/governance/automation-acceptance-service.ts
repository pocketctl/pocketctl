import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type pg from 'pg'
import {automationHash} from './automation-policy.js'
import {candidateReviewHash} from '../claims/review-hash.js'
import {createClaimRepository} from '../claims/repository.js'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import type {TombstoneHmacKey} from '../config.js'
import {resolvePacketEvidence} from '../claims/evidence-resolver.js'
const factSchema=z.object({fact_kind:z.literal('file_digest'),path:z.string().min(1).max(1024).regex(/^[a-zA-Z0-9_./-]+$/),blob_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export function validatePersonalFact(input:{claimType:string;scopeKind:string;statement:string;structured:unknown;snapshot:{commitSha:string;path:string;blobHash:string};origin:string}){
 const fact=factSchema.safeParse(input.structured)
 if(input.origin!=='native_personal'||input.claimType!=='implementation_map'||input.scopeKind!=='snapshot'||!fact.success)return {eligible:false,reason:'outside_exact_whitelist'}
 if(fact.data.path.split('/').some(p=>!p||p==='.'||p==='..')||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.snapshot.commitSha)||fact.data.path!==input.snapshot.path||fact.data.blob_hash!==input.snapshot.blobHash)return {eligible:false,reason:'snapshot_mismatch'}
 const statement=`Snapshot ${input.snapshot.commitSha} contains file ${JSON.stringify(fact.data.path)} with SHA-256 ${fact.data.blob_hash}.`
 return input.statement===statement?{eligible:true,reason:'exact_file_digest'}:{eligible:false,reason:'statement_not_exact_fact'}
}
export interface AcceptanceCanaryProof {approved:boolean;reason:string;proofHash?:string}
export interface VerifiedExecutorGrant {providerClientId:string;installationId:string;authorizationEpoch:string;permissionRevision:string;expiresAt:number}
export function personalAcceptanceDigest(input:{candidate:Record<string,any>;sourceDigest:string;policyHash:string;snapshot:{commit_sha:string;path:string;blob_hash:string};authorizationEpoch:string}){return automationHash({candidateHash:candidateReviewHash(input.candidate),revision:String(input.candidate.revision),sourceDigest:input.sourceDigest,policyHash:input.policyHash,snapshot:input.snapshot,authorizationEpoch:input.authorizationEpoch,ruleVersion:'file-digest-v1'})}
export interface AutoAcceptInput {installationId:string;candidateId:string;expectedRevision:number;expectedDigest:string;principalId:string}
export function createAutomationAcceptanceService(deps:{pool:pg.Pool;mode:'off'|'assist'|'canary';executorGrant?:VerifiedExecutorGrant;tombstoneHmacKeys?:readonly TombstoneHmacKey[];canaryGate?:(input:AutoAcceptInput)=>Promise<AcceptanceCanaryProof>}){
 return {
 async accept(input:AutoAcceptInput):Promise<{accepted:boolean;reason:string;claimId?:string;versionId?:string}>{
  if(deps.mode!=='canary')return {accepted:false,reason:'automatic_gate_closed'}
  const proof=await deps.canaryGate?.(input)
  if(!proof?.approved||!proof.proofHash||!/^[a-f0-9]{64}$/.test(proof.proofHash))return {accepted:false,reason:proof?.reason??'human_calibration_required'}
  const c=await deps.pool.connect()
  try{await c.query('BEGIN')
   const source=(await c.query('SELECT t.episode_id,e.session_id FROM memory_candidates t JOIN work_episodes e USING(installation_id,episode_id) WHERE t.installation_id=$1 AND t.candidate_id=$2',[input.installationId,input.candidateId])).rows[0]
   if(!source)throw new Error('candidate_changed')
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))",[input.installationId,source.session_id])
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
   const currentSource=(await c.query('SELECT t.episode_id,e.session_id FROM memory_candidates t JOIN work_episodes e USING(installation_id,episode_id) WHERE t.installation_id=$1 AND t.candidate_id=$2',[input.installationId,input.candidateId])).rows[0]
   if(!currentSource||currentSource.episode_id!==source.episode_id||currentSource.session_id!==source.session_id)throw new Error('candidate_changed')
   const principal=(await c.query(`SELECT p.*,s.owner_scope_id,s.owner_scope_kind,s.state AS scope_state,s.authorization_epoch AS scope_epoch FROM memory_governance_executor_principals p JOIN memory_owner_scopes s USING(installation_id) JOIN memory_installations i USING(installation_id) WHERE p.installation_id=$1 AND p.principal_id=$2 AND i.local_status NOT IN('purging','purged','integrity_error') AND i.relay_status='active' FOR SHARE OF p,s,i`,[input.installationId,input.principalId])).rows[0]
   const grant=deps.executorGrant
   if(!grant||grant.installationId!==input.installationId||grant.providerClientId!==principal?.provider_client_id||grant.permissionRevision!==String(principal?.permission_revision)||grant.authorizationEpoch!==String(principal?.scope_epoch)||!Number.isFinite(grant.expiresAt))throw new Error('executor_grant_unproven')
   if(!(await c.query('SELECT clock_timestamp()<to_timestamp($1) AS live',[grant.expiresAt])).rows[0].live)throw new Error('executor_grant_expired')
   if(!principal||principal.owner_scope_kind!=='personal'||principal.authorized_by_owner_id!==principal.owner_scope_id||principal.scope_state!=='active'||principal.state!=='active'||String(principal.authorization_epoch)!==String(principal.scope_epoch)||!principal.permissions.includes('auto_accept_personal'))throw new Error('executor_not_authorized')
   if(!(await c.query('SELECT 1 FROM memory_governance_executor_principals WHERE principal_id=$1 AND valid_until>clock_timestamp()',[input.principalId])).rowCount)throw new Error('executor_expired')
   const policy=(await c.query(`SELECT p.*,h.policy_id AS active_id FROM memory_review_automation_policy_heads h JOIN memory_review_automation_policies p USING(policy_id) WHERE h.installation_id=$1 FOR SHARE OF h`,[input.installationId])).rows[0]
   if(!policy||policy.document.mode!=='assist'||policy.document.personalAutoAccept!==true)throw new Error('policy_not_authorized')
   const control=(await c.query('SELECT identity_generation,phase FROM memory_governance_v2_states WHERE installation_id=$1 FOR SHARE',[input.installationId])).rows[0]
   if(control?.identity_generation!==2||control.phase!=='active')throw new Error('migration_gate_closed')
   const existing=(await c.query(`SELECT a.version_id,v.claim_id,c.state,c.current_version_id FROM memory_automation_authority_records a JOIN knowledge_versions v USING(installation_id,version_id) JOIN knowledge_claims c USING(installation_id,claim_id) WHERE a.installation_id=$1 AND a.candidate_id=$2`,[input.installationId,input.candidateId])).rows[0]
   if(existing){await c.query('COMMIT');return existing.state==='active'&&existing.current_version_id===existing.version_id?{accepted:true,reason:'replayed',claimId:existing.claim_id,versionId:existing.version_id}:{accepted:false,reason:'human_override'}}
   const row=(await c.query(`SELECT to_jsonb(t) candidate,e.session_id,e.document,e.evidence_manifest,encode(e.source_digest,'hex') source_digest,encode(r.episode_source_digest,'hex') run_source_digest FROM memory_candidates t JOIN work_episodes e USING(installation_id,episode_id) JOIN memory_extraction_runs r ON r.run_id=t.run_id WHERE t.installation_id=$1 AND t.candidate_id=$2 FOR UPDATE OF t FOR SHARE OF e,r`,[input.installationId,input.candidateId])).rows[0]
   if(!row||row.candidate.episode_id!==source.episode_id||row.session_id!==source.session_id||row.candidate.revision!==input.expectedRevision||row.candidate.status!=='validated'||row.source_digest!==row.run_source_digest)throw new Error('candidate_changed')
   const candidate=row.candidate,handles=candidate.evidence_handles as string[],evidence=resolvePacketEvidence(row.document,row.evidence_manifest,handles)
   if(!handles.length||evidence.length!==handles.length)throw new Error('evidence_unproven')
   for(const e of evidence){
    // Only explicit current native-personal origin proof can enter the write path.
    if(e.manifest.kind!=='event'||!e.manifest.source_event_id)throw new Error('native_origin_unproven')
    const event=(await c.query(`SELECT origin,source_provenance FROM source_events WHERE installation_id=$1 AND source_event_id=$2 FOR SHARE`,[input.installationId,e.manifest.source_event_id])).rows[0]
    if(event?.origin!=='feed'||!z.object({source_class:z.literal('native_personal')}).strict().safeParse(event.source_provenance).success)throw new Error('native_origin_unproven')
   }
   const fact=factSchema.safeParse(candidate.structured_content);if(!fact.success)throw new Error('outside_exact_whitelist')
   const snapshot=(await c.query(`SELECT s.commit_sha,e.path,e.blob_hash,encode(sha256(convert_to(b.utf8_content,'UTF8')),'hex') verified_blob_hash FROM memory_source_snapshots s JOIN memory_source_snapshot_entries e USING(installation_id,snapshot_id) JOIN memory_source_blobs b ON b.installation_id=e.installation_id AND b.blob_hash=e.blob_hash JOIN repo_snapshots r ON r.installation_id=s.installation_id AND r.repository_id=s.repository_id AND r.commit_sha=s.commit_sha WHERE s.installation_id=$1 AND s.repository_id=$2 AND r.repo_snapshot_id=$3 AND e.path=$4 AND s.state='active' AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha) FOR SHARE OF s,e,r,b`,[input.installationId,candidate.repository_id,candidate.repo_snapshot_id,fact.data.path])).rows[0]
   if(!snapshot||snapshot.verified_blob_hash!==snapshot.blob_hash||!validatePersonalFact({claimType:candidate.claim_type,scopeKind:candidate.scope_kind,statement:candidate.statement,structured:candidate.structured_content,snapshot:{commitSha:snapshot.commit_sha,path:snapshot.path,blobHash:snapshot.blob_hash},origin:'native_personal'}).eligible)throw new Error('snapshot_mismatch')
   const digest=personalAcceptanceDigest({candidate,sourceDigest:row.source_digest,policyHash:policy.policy_hash,snapshot:{commit_sha:snapshot.commit_sha,path:snapshot.path,blob_hash:snapshot.blob_hash},authorizationEpoch:String(principal.scope_epoch)})
   if(digest!==input.expectedDigest)throw new Error('input_digest_changed')
   const spent=Number((await c.query(`SELECT COUNT(*)::int n FROM memory_automation_authority_records WHERE installation_id=$1 AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,[input.installationId])).rows[0].n)
   if(spent>=principal.max_accepts_per_day)throw new Error('acceptance_budget_exceeded')
   await c.query("SELECT set_config('pocketctl.automation_actor',$1,true)",[JSON.stringify({principalId:input.principalId,permissionRevision:String(principal.permission_revision),grantExpiresAt:grant.expiresAt})])
   const accepted=await createClaimRepository(createTransactionBoundPool(c),{tombstoneHmacKeys:deps.tombstoneHmacKeys}).acceptCandidate({installationId:input.installationId,candidateId:input.candidateId,expectedRevision:input.expectedRevision,expectedHash:candidateReviewHash(candidate),automationAuthority:true})
   if(!accepted.ok)throw new Error(accepted.error.code)
   await c.query(`INSERT INTO memory_automation_authority_records(authority_id,installation_id,version_id,candidate_id,candidate_revision,principal_id,permission_revision,policy_id,input_digest,source_digest,canary_proof_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),input.installationId,accepted.versionId,input.candidateId,input.expectedRevision,input.principalId,principal.permission_revision,policy.policy_id,digest,row.source_digest,proof.proofHash])
   await c.query('COMMIT');return {accepted:true,reason:'exact_file_digest',claimId:accepted.claimId,versionId:accepted.versionId}
  }catch(error){await c.query('ROLLBACK').catch(()=>undefined);const reason=error instanceof Error?error.message:'';const allowed=['executor_grant_unproven','executor_grant_expired','executor_not_authorized','executor_expired','policy_not_authorized','migration_gate_closed','candidate_changed','candidate_expired','evidence_unproven','native_origin_unproven','outside_exact_whitelist','snapshot_mismatch','input_digest_changed','acceptance_budget_exceeded','automation_actor_expired','evidence_required','identity_requires_review','revision_conflict','tombstoned_identity'];return {accepted:false,reason:allowed.includes(reason)?reason:'automatic_acceptance_failed'}}finally{c.release()}
 },
 }
}
