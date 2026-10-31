import {verifyRevisionBundle} from './revision-bundle.js'
import {loadEffectiveReviewPolicySnapshot} from './review-policy.js'
import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {automationHash,automationPolicySchema,type AutomationPolicy} from './automation-policy.js'
import {requireCurrentScopePermission,assertCurrentGrantClock,type ValidatedV2Grant} from './authorization.js'
import type {AutomationDecision} from './automation-evaluator.js'
import type {JobFence} from '../jobs/types.js'
import {assertJobFence} from '../generation/fence.js'
export interface AutomationSubject {installationId:string;candidateId:string;subjectKind:'personal'|'promotion'}
export interface PreparedAutomation extends AutomationSubject {runId:string;digest:string;policyId:string;policy:AutomationPolicy;snapshot:{revision:number;statement:string;evidence:unknown[];[key:string]:unknown};epoch:string}
export function createAutomationRepository(pool:pg.Pool){
 async function tx<T>(fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 async function capture(c:pg.PoolClient,input:AutomationSubject){
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))",[input.installationId])
  const owner=(await c.query(`SELECT s.authorization_epoch::text,s.state,i.config_version::text FROM memory_owner_scopes s JOIN memory_installations i USING(installation_id) WHERE s.installation_id=$1 AND s.state='active' AND i.local_status NOT IN('purging','purged','integrity_error') AND i.relay_status NOT IN('revoked','revoking') FOR SHARE OF s,i`,[input.installationId])).rows[0]
  if(!owner)return null
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('review-automation:' || $1,0))",[input.installationId])
  const policy=(await c.query(`SELECT p.* FROM memory_review_automation_policy_heads h JOIN memory_review_automation_policies p USING(policy_id) WHERE h.installation_id=$1 FOR SHARE OF h`,[input.installationId])).rows[0]
  if(!policy||policy.document.mode==='off')return null
  let snapshot:any
  if(input.subjectKind==='promotion'){
   const row=(await c.query(`SELECT c.revision::int,c.state,c.expires_at::text,v.candidate_revision_id,v.statement,v.structured_content,v.content_hash,v.revision_bundle,v.revision_bundle_hash,v.review_policy_version_id FROM memory_promotion_candidates c JOIN memory_promotion_candidate_versions v ON v.candidate_id=c.candidate_id AND v.revision_number=c.revision WHERE c.target_installation_id=$1 AND c.candidate_id=$2 AND c.state IN('proposed','changes_requested','conflict','approved') AND c.expires_at>clock_timestamp() FOR SHARE OF c,v`,[input.installationId,input.candidateId])).rows[0]
   if(!row)return null
   // Read only the sanitized target revision capsule, never the private source.
   const evidence=(await c.query(`SELECT ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,sanitized_locator,occurred_at FROM memory_promotion_evidence WHERE candidate_revision_id=$1 ORDER BY ordinal FOR SHARE`,[row.candidate_revision_id])).rows
   const reviewPolicy=await loadEffectiveReviewPolicySnapshot(c,input.installationId)
   snapshot={...row,evidence,reviewPolicy,bundleVerified:row.revision_bundle!==null&&verifyRevisionBundle(row,evidence)}
  }else{
   const row=(await c.query(`SELECT to_jsonb(c) AS candidate,e.source_digest,r.episode_source_digest FROM memory_candidates c JOIN work_episodes e ON e.installation_id=c.installation_id AND e.episode_id=c.episode_id JOIN memory_extraction_runs r ON r.run_id=c.run_id WHERE c.installation_id=$1 AND c.candidate_id=$2 AND c.status IN('validated','conflict','shadow') AND c.review_expires_at>clock_timestamp() AND e.source_digest=r.episode_source_digest AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp()) FOR SHARE OF c,e,r`,[input.installationId,input.candidateId])).rows[0]
   if(!row)return null
   snapshot={...row.candidate,revision:Number(row.candidate.revision),evidence:[],sourceDigest:row.source_digest}
  }
  const digest=automationHash({installationId:input.installationId,candidateId:input.candidateId,subjectKind:input.subjectKind,snapshot,policyHash:policy.policy_hash,policyId:policy.policy_id,policyRevision:String(policy.revision),epoch:owner.authorization_epoch,configVersion:owner.config_version})
  return {snapshot,policyId:policy.policy_id,policy:automationPolicySchema.parse(policy.document),digest,epoch:owner.authorization_epoch}
 }
 return {
  async setPolicy(input:{installationId:string;grant:ValidatedV2Grant;expectedRevision:number;document:unknown}){
   const document=automationPolicySchema.parse(input.document)
   return tx(async c=>{
    const binding=await requireCurrentScopePermission({client:c,grant:input.grant,targetInstallationId:input.installationId,permission:'policy_admin'})
    if(!binding.membership_id&&binding.owner_scope_kind!=='personal')throw new Error('human_policy_authorizer_required')
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('review-automation:' || $1,0))",[input.installationId])
    const head=(await c.query('SELECT revision::int FROM memory_review_automation_policy_heads WHERE installation_id=$1 FOR UPDATE',[input.installationId])).rows[0]
    if((head?.revision??0)!==input.expectedRevision)throw new Error('automation_policy_conflict')
    const policyId=randomUUID(),revision=input.expectedRevision+1
    await c.query('INSERT INTO memory_review_automation_policies(policy_id,installation_id,revision,policy_hash,document,authorized_by) VALUES($1,$2,$3,$4,$5,$6)',[policyId,input.installationId,revision,automationHash(document),document,binding.membership_id])
    await c.query('INSERT INTO memory_review_automation_policy_heads(installation_id,policy_id,revision) VALUES($1,$2,$3) ON CONFLICT(installation_id) DO UPDATE SET policy_id=$2,revision=$3',[input.installationId,policyId,revision])
    await assertCurrentGrantClock(c,input.grant,[input.installationId]);return {policyId,revision,document}
   })
  },
  async prepare(input:AutomationSubject,fence?:JobFence):Promise<PreparedAutomation|null>{return tx(async c=>{
   const p=await capture(c,input);if(!p)return null
   if(fence)await assertJobFence(c,fence)
   const run=(await c.query(`INSERT INTO memory_review_automation_runs(run_id,installation_id,subject_kind,candidate_id,candidate_revision,input_digest,policy_id,model,prompt_version,evaluator_version,authorization_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(installation_id,input_digest) DO NOTHING RETURNING run_id`,[randomUUID(),input.installationId,input.subjectKind,input.candidateId,p.snapshot.revision,p.digest,p.policyId,p.policy.model,p.policy.promptVersion,p.policy.evaluatorVersion,p.epoch])).rows[0]??(await c.query('SELECT run_id FROM memory_review_automation_runs WHERE installation_id=$1 AND input_digest=$2',[input.installationId,p.digest])).rows[0]
   return {...input,...p,runId:run.run_id}
  })},
  async finish(p:PreparedAutomation,d:AutomationDecision,fence?:JobFence){return tx(async c=>{
   const current=await capture(c,p);if(!current||current.digest!==p.digest)return false
   if(fence)await assertJobFence(c,fence)
   await c.query(`INSERT INTO memory_review_automation_decisions(run_id,recommendation,reason_code,input_tokens,output_tokens,cost_micros,budget_reservation_id,billing_uncertain) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id) DO NOTHING`,[p.runId,d.recommendation,d.reason,d.usage?.inputTokens??null,d.usage?.outputTokens??null,d.usage?.costMicros??null,d.budgetReservationId??null,d.billingUncertain??false]);return true
  })},
  async currentAdvice(input:AutomationSubject){return tx(async c=>{const p=await capture(c,input);if(!p)return null;return (await c.query(`SELECT d.recommendation,d.reason_code AS reason,r.input_digest,d.cost_micros,d.billing_uncertain FROM memory_review_automation_runs r JOIN memory_review_automation_decisions d USING(run_id) WHERE r.installation_id=$1 AND r.input_digest=$2`,[input.installationId,p.digest])).rows[0]??null})},
 }
}
