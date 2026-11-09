import {prepareCurationSources,attachPreparedSources} from '../sources/prepared-sources.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {assertSourceProviderExecution,guardSourceExecutionCommit} from '../sources/source-execution.js'
import pg from 'pg'
import {createHash,randomUUID} from 'node:crypto'
import {canonicalPacketJson} from '../episodes/packet.js'
import {sanitizeText} from '../episodes/content-policy.js'
import {parseMemorySourceProvenance} from '../episodes/skill-provenance.js'
import type {TextGenerator} from '../ports/text-generator.js'
import {JobDeferredError,type JobClaim,type JobFence} from '../jobs/types.js'
import {assertJobFence,StaleJobFenceError} from '../generation/fence.js'
import {recordCurationProviderUsage} from '../generation/provider-effect.js'
import {readCurationPolicy} from './policy.js'
import type {CurationMode} from './contracts.js'
import {extractConclusions,CONCLUSION_PROMPT_VERSION} from './conclusion-extractor.js'
import type {ConclusionEvidence} from './conclusion-validator.js'
import {loadCurrentLifecycleSources,refreshLifecycleProcessingReceipt} from './task-repository.js'
import {loadTaskCatalog,taskTopicDescriptor} from './task-catalog.js'
const hash=(v:unknown)=>createHash('sha256').update(canonicalPacketJson(v)).digest('hex')
export async function curationTransaction<T>(pool:pg.Pool,installationId:string,bundleId:string,fn:(client:pg.PoolClient,bundle:any)=>Promise<T>,options:{sourceCommit?:boolean}={}):Promise<T|null>{
 const shared=sourcePoolContext(pool).namespace==='memory'
 const prepared=shared?await prepareCurationSources(pool,installationId,bundleId):null
 if(shared&&!prepared)return null
 const c=await pool.connect()
 try{await c.query('BEGIN');await c.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'");const source=(await c.query('SELECT session_id FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2',[installationId,bundleId])).rows[0]
  if(!source){await c.query('COMMIT');return null}
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0)),pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`,[installationId,source.session_id])
  if(prepared){await prepared.assertCurrent(c);attachPreparedSources(c,prepared)}
  const bundle=(await c.query(`SELECT b.* FROM memory_task_bundles b JOIN memory_installations i USING(installation_id)
   WHERE b.installation_id=$1 AND b.bundle_id=$2 AND b.body_state='present' AND i.relay_status='active' AND i.local_status NOT IN('purging','purged','integrity_error')
   AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=b.installation_id AND t.session_id=b.session_id) FOR UPDATE OF b`,[installationId,bundleId])).rows[0]
  if(!bundle){await c.query('COMMIT');return null}
  const result=await fn(c,bundle);if(prepared)await prepared.assertCurrent(c,{forCommit:true});if(options.sourceCommit!==false)await guardSourceExecutionCommit(c);await c.query('COMMIT');return result
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export function createCurationWorker(input:{pool:pg.Pool;mode:CurationMode;textGenerator?:TextGenerator;modelFingerprint:string}){
 const modelHash=hash({model:input.modelFingerprint,prompt:CONCLUSION_PROMPT_VERSION})
 return {async consolidate(job:JobClaim,signal:AbortSignal,fence?:JobFence){
  if(!job.installation_id||input.mode==='off')return
  const installationId=job.installation_id,bundleId=String(job.payload.bundle_id??'')
  if(!/^[0-9a-f-]{36}$/.test(bundleId))throw new Error('bundle_id_invalid')
  await assertSourceProviderExecution(sourcePoolContext(input.pool).namespace==='memory')
  const reservation=await curationTransaction(input.pool,installationId,bundleId,async(c,bundle)=>{
   if(fence)await assertJobFence(c,fence)
   if(bundle.bundle_kind!=='intake'||Number(bundle.revision)!==Number(job.payload.bundle_revision))return null
   const policy=await readCurationPolicy(c,installationId,input.mode)
   if(!policy)return null
   const source=await loadCurrentLifecycleSources(c,installationId,bundle)
   if(bundle.state==='deferred_semantic'&&bundle.semantic_deadline&&new Date(bundle.semantic_deadline).getTime()<=Date.now()){
    await c.query("UPDATE memory_task_bundles SET state='skipped_unresolved',reason_code='semantic_deadline_elapsed' WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId])
    await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:bundleId});return null
   }
   const policyHash=hash({version:policy.version,revision:policy.revision,mode:policy.mode})
   const sources=source.admitted
   const evidence:ConclusionEvidence[]=sources.map(s=>{
    const proof=parseMemorySourceProvenance(s.source_provenance?.memory)
    if(!proof||proof.skill_state!=='non_skill'||!proof.lineage_complete)throw new Error('curation_source_unavailable')
    const text=sanitizeText(typeof s.payload.text==='string'?s.payload.text:'',4000).text
    return{id:s.source_event_id,text,role:proof.source_role,verified:proof.source_role==='tool'&&s.event_type==='test_result'&&s.payload.status==='passed'}
   }).filter(s=>s.text)
   if(evidence.reduce((n,s)=>n+s.text.length,0)>64000)throw new Error('curation_input_limit')
   const spaces=(await c.query("SELECT space_id::text id,name,domain FROM memory_spaces WHERE installation_id=$1 AND state='active' ORDER BY space_id LIMIT 100",[installationId])).rows
   const tasks=await loadTaskCatalog(c,installationId,bundle.session_id)
   let inserted=(await c.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,claimed_by,claim_expires_at,authorization_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,clock_timestamp()+interval '5 minutes',$10) ON CONFLICT DO NOTHING RETURNING run_id::text,claim_epoch`,
    [installationId,bundleId,bundle.revision,bundle.source_digest,policy.revision,policyHash,modelHash,policy.mode,job.job_id,policy.authorizationEpoch])).rows[0]
   if(!inserted){
    const old=(await c.query(`SELECT *,claim_expires_at<=clock_timestamp() AS lease_expired FROM memory_curation_runs WHERE installation_id=$1 AND bundle_id=$2 AND bundle_revision=$3 AND policy_hash=$4 AND model_config_hash=$5 AND mode=$6 FOR UPDATE`,[installationId,bundleId,bundle.revision,policyHash,modelHash,policy.mode])).rows[0]
    if(old?.state==='running'){
     if(!old.lease_expired)throw new JobDeferredError('source_not_ready',new Date(Date.now()+300000))
     await c.query("UPDATE memory_curation_runs SET state='provider_result_unknown',error_code='lease_expired',completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2",[installationId,old.run_id])
     await c.query("UPDATE memory_task_bundles SET state='blocked',reason_code='provider_result_unknown' WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId]);return null
    }
    if(old?.state==='blocked'&&['budget_exceeded','budget_unavailable'].includes(old.error_code)){
     if(new Date(bundle.next_evaluate_at).getTime()>Date.now())throw new JobDeferredError('source_not_ready',new Date(bundle.next_evaluate_at))
     inserted=(await c.query(`UPDATE memory_curation_runs SET state='running',error_code=NULL,completed_at=NULL,claimed_by=$3,claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE installation_id=$1 AND run_id=$2 RETURNING run_id::text,claim_epoch`,[installationId,old.run_id,job.job_id])).rows[0]
    }else{
     if(bundle.state==='deferred_semantic')throw new JobDeferredError('source_not_ready',new Date(bundle.semantic_deadline))
     return null
    }
   }
   await c.query("UPDATE memory_task_bundles SET state='running',reason_code=NULL WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId])
   return{runId:inserted.run_id,claimEpoch:Number(inserted.claim_epoch),revision:Number(bundle.revision),digest:bundle.source_digest as Buffer,policy,policyHash,evidence,spaces,tasks}
  })
  if(!reservation)return
  let result:Awaited<ReturnType<typeof extractConclusions>>
  try{result=input.textGenerator?await extractConclusions(input.textGenerator,{sources:reservation.evidence,spaces:reservation.spaces,tasks:reservation.tasks,requestKey:`curation:${reservation.runId}:${reservation.claimEpoch}`,signal,now:new Date()}):{ok:false as const,code:'budget_unavailable' as const,retryable:false}}
  catch{result={ok:false,code:'provider_result_unknown',retryable:false}}
  if('usage' in result&&result.usage)await recordCurationProviderUsage(input.pool,{installationId,runId:reservation.runId,
   inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,model:result.usage.model,costMicros:result.usage.costMicros})
  const outcome=await curationTransaction(input.pool,installationId,bundleId,async(c,bundle)=>{
   if(fence)await assertJobFence(c,fence)
   const policy=await readCurationPolicy(c,installationId,input.mode)
   if(!policy||policy.mode!==reservation.policy.mode||policy.revision!==reservation.policy.revision||policy.authorizationEpoch!==reservation.policy.authorizationEpoch||Number(bundle.revision)!==reservation.revision||!bundle.source_digest.equals(reservation.digest))throw new Error('curation_source_changed')
   await loadCurrentLifecycleSources(c,installationId,bundle)
   const lease=(await c.query(`SELECT claim_expires_at>clock_timestamp() AS live FROM memory_curation_runs WHERE installation_id=$1 AND run_id=$2 AND claimed_by=$3 AND state='running' AND claim_epoch=$4 FOR UPDATE`,[installationId,reservation.runId,job.job_id,reservation.claimEpoch])).rows[0]
   if(!lease)throw new Error('curation_lease_lost')
   if(!lease.live){
    await c.query("UPDATE memory_curation_runs SET state='provider_result_unknown',error_code='lease_expired',completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2",[installationId,reservation.runId])
    await c.query("UPDATE memory_task_bundles SET state='blocked',reason_code='provider_result_unknown' WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId]);return
   }
   if(!result.ok){
    const uncertain=('billingUncertain' in result&&result.billingUncertain)||Boolean('timeoutFallback' in result&&result.timeoutFallback&&(result.code==='budget_exceeded'||result.code==='budget_unavailable'))
    const code=uncertain?'provider_result_unknown':result.code
    const unknown=code==='provider_result_unknown'||code==='http_error'||code==='aborted'
    await c.query('UPDATE memory_curation_runs SET state=$3,error_code=$4,completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2',[installationId,reservation.runId,unknown?'provider_result_unknown':'blocked',code])
    const retryAt='retryAt' in result&&result.retryAt&&Number.isFinite(Date.parse(result.retryAt))?new Date(result.retryAt):new Date(Date.now()+300000)
    await c.query("UPDATE memory_task_bundles SET state='blocked',reason_code=$3,next_evaluate_at=$4 WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId,code,retryAt]);return ['budget_exceeded','budget_unavailable'].includes(code)?retryAt:undefined
   }
   await c.query(`UPDATE memory_curation_runs SET state='completed',result=$3::jsonb,input_tokens=$4,output_tokens=$5,completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2`,[installationId,reservation.runId,JSON.stringify(result.tasks),result.usage.inputTokens,result.usage.outputTokens])
   const currentTasks=result.tasks.some(task=>task.task_id)?await loadTaskCatalog(c,installationId,bundle.session_id):[]
   let unresolved=result.tasks.some(task=>task.rejections.length>0)
   for(const task of result.tasks){
    if(!task.space_id){unresolved=true;continue}
    if(!(await c.query("SELECT 1 FROM memory_spaces WHERE installation_id=$1 AND space_id=$2 AND state='active' FOR SHARE",[installationId,task.space_id])).rowCount)throw new Error('scene_changed')
    const previous=task.task_id?reservation.tasks.find(t=>t.id===task.task_id):undefined
    if(task.task_id&&(!previous||!currentTasks.some(t=>t.id===previous.id&&t.revision===previous.revision&&t.space_id===task.space_id)))throw new Error('task_binding_changed')
    const childId=task.task_id??randomUUID(),childDigest=Buffer.from(hash({source:reservation.digest.toString('hex'),spans:task.spans,space:task.space_id}),'hex')
    const child=(await c.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,space_id,source_digest,watermark,bundle_kind,parent_bundle_id,parent_revision,spans,state,topic_descriptor)
     VALUES($1,$2,$3,$4,$5,$6,$7,'task',$8,$9,$10::jsonb,'completed',$11)
     ON CONFLICT(installation_id,bundle_id) DO UPDATE SET revision=memory_task_bundles.revision+1,source_digest=EXCLUDED.source_digest,parent_bundle_id=EXCLUDED.parent_bundle_id,parent_revision=EXCLUDED.parent_revision,spans=EXCLUDED.spans,topic_descriptor=EXCLUDED.topic_descriptor,state='completed',updated_at=clock_timestamp()
     WHERE memory_task_bundles.session_id=EXCLUDED.session_id AND memory_task_bundles.space_id=EXCLUDED.space_id AND memory_task_bundles.body_state='present' AND memory_task_bundles.revision=$12 RETURNING revision`,
     [installationId,childId,bundle.session_id,`task:${childId}`,task.space_id,childDigest,bundle.watermark,bundleId,reservation.revision,JSON.stringify(task.spans),taskTopicDescriptor(task.spans,reservation.evidence),previous?.revision??0])).rows[0]
    if(!child)throw new Error('task_binding_changed')
    await c.query('DELETE FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2',[installationId,childId])
    await c.query(`INSERT INTO memory_task_bundle_sources SELECT installation_id,$3,source_event_id,source_digest,source_sequence FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2 AND source_event_id=ANY($4::uuid[])`,[installationId,bundleId,childId,[...new Set(task.spans.map(s=>s.event_id))]])
    const childRun=(await c.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,authorization_epoch,parent_run_id,completed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10,clock_timestamp()) RETURNING run_id::text`,[installationId,childId,child.revision,childDigest,policy.revision,reservation.policyHash,modelHash,policy.mode,policy.authorizationEpoch,reservation.runId])).rows[0].run_id
    for(const [ordinal,conclusion]of task.conclusions.entries()){
     const candidate=(await c.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision)
      VALUES(gen_random_uuid(),$1,$2,'work_method',$3,$4::jsonb,$5,'task',$6,1,clock_timestamp(),$7,'task_bundle',$8,$9,$10) RETURNING candidate_id::text`,
      [installationId,ordinal,conclusion.statement,JSON.stringify(conclusion),hash(conclusion),task.space_id,policy.mode==='enabled'?'validated':'shadow',childId,childRun,child.revision])).rows[0]
     if(policy.mode==='enabled')await c.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload) VALUES(gen_random_uuid(),$1,'curate_conclusions',$2,86,$3::jsonb) ON CONFLICT DO NOTHING`,[installationId,`curate:${candidate.candidate_id}`,JSON.stringify({candidate_id:candidate.candidate_id,bundle_id:childId,run_id:childRun})])
    }
   }
   const ended=(await c.query(`UPDATE memory_task_bundles SET state=$3,reason_code=$4,semantic_deadline=CASE WHEN $3='deferred_semantic' THEN LEAST(COALESCE(semantic_deadline,clock_timestamp()+interval '7 days'),clock_timestamp()+interval '7 days') ELSE NULL END WHERE installation_id=$1 AND bundle_id=$2 RETURNING semantic_deadline`,[installationId,bundleId,unresolved?'deferred_semantic':'completed',unresolved?(result.tasks.some(task=>!task.space_id)?'scene_unknown':'conclusion_invalid'):null])).rows[0]
   await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:bundleId})
   return unresolved?new Date(ended.semantic_deadline):undefined
  },{sourceCommit:result.ok}).then(outcome=>{
   if(outcome===null)throw new Error('curation_source_unavailable')
   return outcome
  }).catch(async(error)=>{
   // A known provider response that loses its input/fence must not leave a
   // permanent running lease or a success receipt. No response prose survives.
   const reason=error instanceof StaleJobFenceError?'curation_lease_lost':error instanceof Error&&['curation_source_changed','curation_source_unavailable','curation_lease_lost','scene_changed','task_binding_changed'].includes(error.message)?error.message:null
   // A transport/commit error may have an unknown database outcome. Only an
   // explicit rejected fence proves this known response was not applied.
   if(!reason)throw error
   await input.pool.query(`UPDATE memory_curation_runs SET state='failed',error_code=$5,completed_at=clock_timestamp()
    WHERE installation_id=$1 AND run_id=$2 AND claimed_by=$3 AND claim_epoch=$4 AND state='running'`,[installationId,reservation.runId,job.job_id,reservation.claimEpoch,reason])
   await input.pool.query(`UPDATE memory_task_bundles SET state='blocked',reason_code=$4
    WHERE installation_id=$1 AND bundle_id=$2 AND revision=$3 AND state='running'`,[installationId,bundleId,reservation.revision,reason])
   throw error
  })
  if(outcome)throw new JobDeferredError('source_not_ready',outcome)
 }}
}
