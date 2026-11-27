import {SourceUnavailableError} from '@pocketctl/session-source'
import {sourceFailureFields} from '../sources/diagnostics.js'
import {commitOutcomeUnknown} from '../sources/projection-diagnostics.js'
import {isKnownSourceUnavailableCode} from '../jobs/worker-diagnostics.js'
import {blockCurationBundle,expireCurationRun} from './reconcile-expired.js'
import {withTransaction} from '../db.js'
import {startCurationLeaseRenewal} from './run-lease.js'
import {prepareCurationSources,attachPreparedSources} from '../sources/prepared-sources.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {assertSourceProviderExecution,guardSourceExecutionCommit,SourceExecutionError} from '../sources/source-execution.js'
import pg from 'pg'
import {publishCurationItem} from './publish-item.js'
import {sanitizeText} from '../episodes/content-policy.js'
import {parseMemorySourceProvenance} from '../episodes/skill-provenance.js'
import type {TextGenerator} from '../ports/text-generator.js'
import {JobDeferredError,JobTerminalError,type JobClaim,type JobFence} from '../jobs/types.js'
import {assertJobFence,StaleJobFenceError} from '../generation/fence.js'
import {createWindowCheckpoints,checkpointDigest,type WindowWitness} from './call-checkpoints.js'
import type {PreparedSources} from '../sources/prepared-sources.js'
import type {ExtractionResult} from './dialogue-extraction.js'
import {lockCurationAuthority,readCurationPolicy} from './policy.js'
import type {CurationMode} from './contracts.js'
import {extractDialogueConclusions} from './dialogue-extraction.js'
import {extractConclusions,CONCLUSION_PROMPT_VERSION} from './conclusion-extractor.js'
import type {ConclusionEvidence} from './conclusion-validator.js'
import {loadCurrentLifecycleSources,refreshLifecycleProcessingReceipt} from './task-repository.js'
import {loadTaskCatalog} from './task-catalog.js'
const hash=checkpointDigest
class CurationCommitUnknown extends Error {
 constructor(cause:unknown){super('curation_commit_outcome_unknown',{cause})}
}

function publicationFailure(error:unknown):string{
 if(error instanceof StaleJobFenceError||error instanceof Error&&error.message==='stale_job_fence')return 'curation_lease_lost'
 const {source_stage,source_reason}=sourceFailureFields(error)
 if(error instanceof SourceUnavailableError||source_stage&&source_reason){
  const code=error instanceof SourceUnavailableError&&isKnownSourceUnavailableCode(error.code)?error.code:'source_unavailable'
  return source_stage&&source_reason?`${code}/${source_stage}/${source_reason}`:code
 }
 if(error instanceof SourceExecutionError)return error.code
 if(error instanceof Error&&['curation_source_changed','curation_source_unavailable','curation_lease_lost','scene_changed','task_binding_changed',
   'source_reference_changed','source_processing_pin_unavailable','source_execution_generation_changed','lease_expired'].includes(error.message))return error.message
 return 'curation_finalize_failed'
}

export async function curationTransaction<T>(pool:pg.Pool,installationId:string,bundleId:string,fn:(client:pg.PoolClient,bundle:any)=>Promise<T>,options:{sourceCommit?:boolean;prepared?:PreparedSources|null;catalogIds?:readonly string[]}={}):Promise<T|null>{
 const shared=sourcePoolContext(pool).namespace==='memory'
 const prepared=options.prepared!==undefined?options.prepared:shared?await prepareCurationSources(pool,installationId,bundleId,options.catalogIds):null
 if(shared&&!prepared)return null
 const c=await pool.connect()
 let discard=false
 try{await c.query('BEGIN');await c.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'");const source=(await c.query('SELECT session_id FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2',[installationId,bundleId])).rows[0]
  if(!source){await c.query('COMMIT');return null}
  if(shared)await lockCurationAuthority(c,installationId)
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0)),pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))`,[installationId,source.session_id])
  if(prepared){await prepared.assertCurrent(c);attachPreparedSources(c,prepared)}
  const bundle=(await c.query(`SELECT b.* FROM memory_task_bundles b JOIN memory_installations i USING(installation_id)
   WHERE b.installation_id=$1 AND b.bundle_id=$2 AND b.body_state='present' AND ($3::boolean OR i.relay_status='active') AND i.local_status NOT IN('purging','purged','integrity_error')
   AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=b.installation_id AND t.session_id=b.session_id) FOR UPDATE OF b`,[installationId,bundleId,shared])).rows[0]
  if(!bundle){await c.query('COMMIT');return null}
  const result=await fn(c,bundle);if(prepared)await prepared.assertCurrent(c,{forCommit:true});if(options.sourceCommit!==false)await guardSourceExecutionCommit(c)
  try{await c.query('COMMIT')}
  catch(error){if(commitOutcomeUnknown(error)){discard=true;throw new CurationCommitUnknown(error)}throw error}
  return result
 }catch(e){if(!discard)await c.query('ROLLBACK').catch(()=>{discard=true});throw e}finally{c.release(discard)}
}
export function createCurationWorker(input:{pool:pg.Pool;mode:CurationMode;textGenerator?:TextGenerator;modelFingerprint:string}){
 const modelHash=hash({model:input.modelFingerprint,prompt:CONCLUSION_PROMPT_VERSION})
 return {async consolidate(job:JobClaim,signal:AbortSignal,fence?:JobFence){
  if(!job.installation_id||input.mode==='off')return
  const installationId=job.installation_id,bundleId=String(job.payload.bundle_id??'')
  if(!/^[0-9a-f-]{36}$/.test(bundleId))throw new Error('bundle_id_invalid')
  await assertSourceProviderExecution(sourcePoolContext(input.pool).namespace==='memory')
  const shared=sourcePoolContext(input.pool).namespace==='memory'
  const prepared=shared?await prepareCurationSources(input.pool,installationId,bundleId):null
  const receiptProof=prepared?.intake??prepared
  const reservation=await curationTransaction(input.pool,installationId,bundleId,async(c,bundle)=>{
   if(fence)await assertJobFence(c,fence)
   if(bundle.bundle_kind!=='intake'||Number(bundle.revision)!==Number(job.payload.bundle_revision))return null
   const policy=await readCurationPolicy(c,installationId,input.mode)
   if(!policy||policy==='source_denied')return null
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
    const text=sanitizeText(typeof s.payload.text==='string'?s.payload.text:'',bundle.dialogue_members?Infinity:4000).text
    return{id:s.source_event_id,text,role:proof.source_role,verified:proof.source_role==='tool'&&s.event_type==='test_result'&&s.payload.status==='passed'}
   }).filter(s=>s.text)
   if(!bundle.dialogue_members&&evidence.reduce((n,s)=>n+s.text.length,0)>64000)throw new Error('curation_input_limit')
   const spaces=(await c.query("SELECT space_id::text id,name,domain,destinations FROM memory_spaces WHERE installation_id=$1 AND state='active' ORDER BY space_id LIMIT 100",[installationId])).rows
   const tasks=await loadTaskCatalog(c,installationId,bundle.session_id)
   // The locked intake bundle serializes reservation. Keep the same queue
   // job bound to its paid/uncertain attempt across worker config changes.
   const old=(await c.query(`SELECT r.*,claim_expires_at<=clock_timestamp() AS lease_expired,
     EXISTS(SELECT 1 FROM memory_curation_calls mc WHERE mc.installation_id=r.installation_id AND mc.run_id=r.run_id AND mc.state='saved') AS saved,
     EXISTS(SELECT 1 FROM memory_curation_calls mc WHERE mc.installation_id=r.installation_id AND mc.run_id=r.run_id AND mc.state IN('unknown','possible','conflict','withdrawn')) AS unsafe
    FROM memory_curation_runs r WHERE installation_id=$1 AND bundle_id=$2 AND bundle_revision=$3 AND
     ((policy_hash=$4 AND model_config_hash=$5 AND mode=$6)
      OR state='provider_result_unknown' OR EXISTS(SELECT 1 FROM memory_curation_calls charged WHERE charged.installation_id=r.installation_id AND charged.run_id=r.run_id AND charged.state IN ('unknown','possible','conflict'))
      OR (claimed_by=$7 AND
       (state<>'blocked' OR error_code NOT IN('budget_exceeded','budget_unavailable') OR input_tokens>0 OR output_tokens>0 OR
        EXISTS(SELECT 1 FROM memory_usage_outbox u WHERE u.installation_id=r.installation_id AND u.usage_id='curation:'||r.run_id::text))))
    ORDER BY CASE WHEN state='blocked' AND error_code IN('budget_exceeded','budget_unavailable') THEN 1 ELSE 0 END,started_at DESC,run_id DESC
    LIMIT 1 FOR UPDATE OF r`,[installationId,bundleId,bundle.revision,policyHash,modelHash,policy.mode,job.job_id])).rows[0]
   let inserted
   if(!old){
    inserted=(await c.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,claimed_by,claim_expires_at,authorization_epoch,checkpoint_protocol)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,clock_timestamp()+interval '5 minutes',$10,1) RETURNING run_id::text,claim_epoch,started_at`,
     [installationId,bundleId,bundle.revision,bundle.source_digest,policy.revision,policyHash,modelHash,policy.mode,job.job_id,policy.authorizationEpoch])).rows[0]
   }else{
    if(old.state==='running'&&!old.lease_expired)throw new JobDeferredError('source_not_ready',new Date(old.claim_expires_at))
    const budgetWait=old.state==='blocked'&&['budget_exceeded','budget_unavailable','source_not_sent','provider_circuit_open'].includes(old.error_code)
    const resumable=old.checkpoint_protocol===1&&!old.unsafe&&old.policy_hash===policyHash&&old.authorization_epoch===policy.authorizationEpoch
      && (old.state==='running'||old.state==='failed'||old.error_code==='publication_interrupted'||old.saved && (['failed','provider_result_unknown'].includes(old.state)||old.error_code==='task_binding_changed'||budgetWait))
    if(resumable){
     if(budgetWait&&new Date(bundle.next_evaluate_at).getTime()>Date.now())throw new JobDeferredError('source_not_ready',new Date(bundle.next_evaluate_at))
     inserted=(await c.query(`UPDATE memory_curation_runs SET state='running',claimed_by=$3,claim_epoch=claim_epoch+1,
       claim_expires_at=clock_timestamp()+interval '5 minutes',error_code=NULL,completed_at=NULL
       WHERE installation_id=$1 AND run_id=$2 RETURNING run_id::text,claim_epoch,started_at`,[installationId,old.run_id,job.job_id])).rows[0]
    }else if(old.state==='running'){
     await expireCurationRun(c,installationId,bundleId,Number(bundle.revision),old.run_id);return null
    }else if(budgetWait&&!old.unsafe){
     if(new Date(bundle.next_evaluate_at).getTime()>Date.now())throw new JobDeferredError('source_not_ready',new Date(bundle.next_evaluate_at))
     // A definite budget refusal can take a new claim under current authority.
     // Prior usage and uncertain or running attempts cannot enter this retry.
     inserted=(await c.query(`UPDATE memory_curation_runs r
      SET state='running',error_code=NULL,completed_at=NULL,claimed_by=$3,claim_epoch=claim_epoch+1,
          claim_expires_at=clock_timestamp()+interval '5 minutes',authorization_epoch=$4
      WHERE r.installation_id=$1 AND r.run_id=$2 AND r.input_tokens=0 AND r.output_tokens=0
       AND NOT EXISTS(SELECT 1 FROM memory_usage_outbox u WHERE u.installation_id=r.installation_id AND u.usage_id='curation:'||r.run_id::text)
      RETURNING run_id::text,claim_epoch,started_at`,[installationId,old.run_id,job.job_id,policy.authorizationEpoch])).rows[0]
     if(!inserted)throw new JobTerminalError('curation_budget_usage_already_recorded')
    }else{
     if(bundle.state==='deferred_semantic')throw new JobDeferredError('source_not_ready',new Date(bundle.semantic_deadline))
     return null
    }
   }
   await c.query("UPDATE memory_task_bundles SET state='running',reason_code=NULL WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId])
   return{runId:inserted.run_id as string,referenceTime:new Date(inserted.started_at),modelHash:old?.model_config_hash??modelHash,claimEpoch:Number(inserted.claim_epoch),revision:Number(bundle.revision),digest:bundle.source_digest as Buffer,policy,policyHash,evidence,spaces,tasks,dialogue:Boolean(bundle.dialogue_members)}
  },{prepared})
  if(!reservation)return
  const stopRenewal=fence?startCurationLeaseRenewal(input.pool,installationId,reservation.runId,reservation.claimEpoch,fence,signal):undefined
  try{
   const witnesses:WindowWitness[]=[]
   const bindings={
    tasks:Object.fromEntries(reservation.tasks.map(task=>[task.id,task.bindingDigest])),
    spaces:Object.fromEntries(reservation.spaces.map(space=>[space.id,hash([space.name,space.domain,space.destinations])])),
   }
   async function authority(c:pg.PoolClient,bundle:any){
    const policy=await readCurationPolicy(c,installationId!,input.mode)
    if(!policy||policy==='source_denied'||policy.mode!==reservation!.policy.mode||policy.revision!==reservation!.policy.revision
      ||policy.authorizationEpoch!==reservation!.policy.authorizationEpoch||Number(bundle.revision)!==reservation!.revision
      ||!bundle.source_digest.equals(reservation!.digest))throw Error('curation_source_changed')
    await loadCurrentLifecycleSources(c,installationId!,bundle)
    return policy
   }
   const checkLease=async(c:pg.PoolClient)=>{
    if(fence)await assertJobFence(c,fence)
    const row=(await c.query(`SELECT claim_expires_at>clock_timestamp() AS live FROM memory_curation_runs
      WHERE installation_id=$1 AND run_id=$2 AND claimed_by=$3 AND state='running' AND claim_epoch=$4 FOR UPDATE`,
      [installationId,reservation.runId,job.job_id,reservation.claimEpoch])).rows[0]
    if(!row)throw Error('curation_lease_lost')
    if(!row.live)throw Error('lease_expired')
   }
   const protectedWork=async<T>(stage:'owned'|'dispatch'|'receipt',work:(client:pg.PoolClient)=>Promise<T>):Promise<T>=>{
    const result=await curationTransaction(input.pool,installationId,bundleId,async(c,b)=>{
     await authority(c,b)
     if(stage!=='receipt')await checkLease(c)
     if(stage==='dispatch'){
      const catalog=await loadTaskCatalog(c,installationId,b.session_id,new Set(reservation.tasks.map(t=>t.id)))
      if(catalog.length!==reservation.tasks.length||catalog.some(t=>bindings.tasks[t.id]!==t.bindingDigest))throw Error('curation_catalog_before_send_changed')
      const spaces=await c.query("SELECT space_id,name,domain,destinations FROM memory_spaces WHERE installation_id=$1 AND state='active' AND space_id=ANY($2::uuid[]) FOR SHARE",[installationId,Object.keys(bindings.spaces)])
      if(spaces.rows.length!==Object.keys(bindings.spaces).length||spaces.rows.some(t=>bindings.spaces[t.space_id]!==hash([t.name,t.domain,t.destinations])))throw Error('curation_catalog_before_send_changed')
     }
     return {value:await work(c)}
    },{prepared:stage==='dispatch'?prepared:receiptProof,sourceCommit:stage!=='receipt'})
    if(result===null)throw Error('curation_source_unavailable')
    return result.value
   }
   const extractWindow=createWindowCheckpoints({pool:input.pool,installation:installationId,run:reservation.runId,runEpoch:reservation.claimEpoch,modelHash:reservation.modelHash,generator:input.textGenerator,
    routeMatches:modelHash===reservation.modelHash,bindings,witnesses,
    owned:work=>protectedWork('owned',work),dispatch:work=>protectedWork('dispatch',work),receipt:work=>protectedWork('receipt',work)})
   const request={sources:reservation.evidence,spaces:reservation.spaces.map(({id,name,domain})=>({id,name,domain})),tasks:reservation.tasks,
    requestKey:'curation:'+reservation.runId,signal,now:reservation.referenceTime}
   const publish=async()=>{
   const origins=new Map<Extract<ExtractionResult,{ok:true}>['tasks'][number],number[]>()
   const result:ExtractionResult=reservation.dialogue
     ?await extractDialogueConclusions(input.textGenerator,request,extractWindow,origins):await extractWindow(request,0)
   if(!result.ok){
    const unknown=result.code==='provider_result_unknown',budget=['budget_exceeded','budget_unavailable','source_not_sent','provider_circuit_open'].includes(result.code)
    const retryAt='retryAt' in result&&result.retryAt&&Number.isFinite(Date.parse(result.retryAt))?new Date(result.retryAt):new Date(Date.now()+300000)
    await withTransaction(input.pool,async c=>{
     await c.query('SELECT 1 FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2 FOR UPDATE',[installationId,bundleId])
     await checkLease(c)
     await c.query('UPDATE memory_curation_runs SET state=$3,error_code=$4,completed_at=clock_timestamp(),recovery_at=NULL WHERE installation_id=$1 AND run_id=$2',
      [installationId,reservation.runId,unknown?'provider_result_unknown':'blocked',result.code])
     await c.query("UPDATE memory_task_bundles SET state=$6,reason_code=$3,next_evaluate_at=$4 WHERE installation_id=$1 AND bundle_id=$2 AND revision=$5",
      [installationId,bundleId,unknown?'external_result_unconfirmed':result.code,retryAt,reservation.revision,unknown?'failed':'blocked'])
    })
    return budget?retryAt:undefined
   }

   let hasBindingGap=false
   for(const task of result.tasks){
    if(!task.space_id)continue
    // Windows resuming the same stable task are a single semantic group.
    const contributors=(origins.get(task)??[0]).map(index=>witnesses[index])
    const calls=contributors.map(w=>w.callId)
    const itemKey=checkpointDigest([calls,task.task_id,task.spans])
    const published=await curationTransaction(input.pool,installationId,bundleId,async(c,bundle)=>{
     const policy=await authority(c,bundle);await checkLease(c)
     return publishCurationItem(c,{installationId,bundleId,itemKey,task,contributors,bundle,reservation,policy})
    },task.task_id?{catalogIds:[task.task_id]}:{prepared:receiptProof})
    if(published===null)throw Error('curation_source_unavailable')
    if(!published)hasBindingGap=true
   }
   return curationTransaction(input.pool,installationId,bundleId,async(c,bundle)=>{
    await authority(c,bundle);await checkLease(c)
    const unresolved=result.tasks.some(t=>!t.space_id||t.rejections.length>0)
    if(hasBindingGap){
     await c.query("UPDATE memory_curation_runs SET state='blocked',error_code='task_binding_changed',recovery_at=clock_timestamp()+interval '1 minute',completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2",[installationId,reservation.runId])
     await c.query(`UPDATE memory_task_bundles SET state='failed',reason_code='task_binding_changed',updated_at=clock_timestamp()
       WHERE installation_id=$1 AND bundle_id=$2 AND revision=$3`,[installationId,bundleId,reservation.revision])
    }else{
     await c.query("UPDATE memory_curation_runs SET state='completed',error_code=NULL,result=$3::jsonb,recovery_at=NULL,completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2",
      [installationId,reservation.runId,JSON.stringify(result.tasks)])
    }
    const ended=hasBindingGap?null:(await c.query(`UPDATE memory_task_bundles SET state=$3,reason_code=$4,semantic_deadline=CASE WHEN $3='deferred_semantic' THEN LEAST(COALESCE(semantic_deadline,clock_timestamp()+interval '7 days'),clock_timestamp()+interval '7 days') ELSE NULL END WHERE installation_id=$1 AND bundle_id=$2 RETURNING semantic_deadline`,[installationId,bundleId,unresolved?'deferred_semantic':'completed',unresolved?(result.tasks.some(task=>!task.space_id)?'scene_unknown':'conclusion_invalid'):null])).rows[0]
    await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:bundleId})
    return ended?.semantic_deadline?new Date(ended.semantic_deadline):undefined
   },{prepared:receiptProof})
   }
   const outcome=await publish().catch(async error=>{
    if(error instanceof CurationCommitUnknown)throw error
    const reason=publicationFailure(error)
    await withTransaction(input.pool,async c=>{
     await c.query('SELECT 1 FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2 FOR UPDATE',[installationId,bundleId])
     const failed=await c.query(`UPDATE memory_curation_runs SET state='failed',error_code=$5,completed_at=clock_timestamp(),
       recovery_at=CASE WHEN checkpoint_protocol=1 AND NOT EXISTS(SELECT 1 FROM memory_curation_calls mc
         WHERE mc.installation_id=$1 AND mc.run_id=$2 AND mc.state IN ('possible','unknown','conflict','withdrawn')) THEN clock_timestamp()+interval '1 minute' ELSE NULL END
       WHERE installation_id=$1 AND run_id=$2 AND claimed_by=$3 AND claim_epoch=$4 AND
       (state='running' OR (state='provider_result_unknown' AND error_code IN('lease_expired','provider_uncertain_at_expiry')) OR (state='failed' AND error_code='publication_interrupted'))`,
       [installationId,reservation.runId,job.job_id,reservation.claimEpoch,reason])
     if(failed.rowCount)await blockCurationBundle(c,installationId,bundleId,reservation.revision,reservation.runId,reason.split('/')[0])
    })
    if(reason==='lease_expired')return undefined
    throw error
   })
   if(outcome===null)throw Error('curation_source_unavailable')
   if(outcome)throw new JobDeferredError('source_not_ready',outcome)
  }finally{await stopRenewal?.()}
 }}
}
