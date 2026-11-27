import {currentIndexOutput} from './index-output-proof.js'
import {createHash} from 'node:crypto'
import type pg from 'pg'
import {canonicalJsonString} from '@pocketctl/session-source'
import {currentClaimVersionSql} from '../claims/version-selection.js'
import type {JobType} from './types.js'

const processor='native-stage-v1'
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x)
const digest=(x:unknown)=>createHash('sha256').update(canonicalJsonString(x)).digest('hex')
type Db=Pick<pg.Pool,'query'>
type Job={job_id:string;claim_epoch:string|number;installation_id:string;job_type:JobType;payload:Record<string,unknown>;idempotency_key:string}
type Observation={known:boolean;eligible:boolean;resolved:boolean;digest:string;session?:string;runId?:string;runEpoch?:string;reason?:string}
const observation=(values:object,eligible=false,resolved=false,extra:Partial<Observation>={}):Observation=>({
 known:true,eligible,resolved,digest:digest(values),...extra,
})
const noInput=()=>observation({},false,false,{known:false})
const supported=new Set<JobType>(['curate_conclusions','consolidate_task','index_claim_version','index_shared_claim','rebuild_claim_index','project_shared_source'])
export const canIsolateStage=(type:JobType)=>supported.has(type)
function inputIdentity(j:Job){
 const p=j.payload
 if(j.job_type==='project_shared_source'){
  const root=p.root as {kind?:string;key?:string}|undefined
  if(!root||!['team_delivery','team_collaboration'].includes(root.kind??'')||typeof root.key!=='string'||root.key.length>1024||
    !uuid(p.distribution_scan)||typeof p.target_cursor!=='string'||p.target_cursor.length>2048||
    j.idempotency_key!=='shared-source:'+p.distribution_scan+':'+createHash('sha256').update(p.target_cursor).digest('hex'))return
 }
 // Scheduling counters and repair flags may change between claims. Only
 // business input identifies a replay of the same obligation.
 const {failure_recovery,source_wait_count,budget_wait_count,projection_budget_step,...business}=p
 return digest([j.installation_id,j.job_type,j.idempotency_key,business])
}
async function observe(db:Db,j:Job):Promise<Observation>{
 const p=j.payload,i=j.installation_id
 if(j.job_type==='project_shared_source'){
  const root=p.root as {kind:string;key:string}
  const {rows:[r]}=await db.query(`SELECT shared.current_memory_source_distribution($1,$2,$3) AS seal,shared.memory_team_stage_result($3,$4) AS result`,
   [root.kind,root.key,i,j.job_id])
  const seal=r?.seal
  if(r?.result)return observation([r.result],false,true)
  if(!seal)return noInput()
  const {rows:[auth]}=await db.query("SELECT * FROM shared.memory_team_source_authority($1,$2,$3)",[p.scope,root.kind,root.key])
  const eligible=seal.scanId===p.distribution_scan && seal.contentPending!==true && auth?.state==='current'
  return observation([seal,auth?.state??null,auth?.authorization_revision??null],eligible,false,{reason:seal.scanId!==p.distribution_scan?'source_superseded':undefined})
 }
 if(j.job_type==='consolidate_task'){
  if(!uuid(p.bundle_id)||!Number.isSafeInteger(p.bundle_revision))return noInput()
  const {rows:[r]}=await db.query(`SELECT b.session_id,b.revision::text,b.body_state,b.state,b.source_digest,
     r.run_id,r.claimed_by,r.claim_epoch::text AS run_epoch,r.state AS run_state,r.checkpoint_protocol,r.reconciliation_code,r.result IS NOT NULL AS has_result,
     EXISTS(SELECT 1 FROM memory_curation_calls k WHERE k.installation_id=b.installation_id AND k.run_id=r.run_id
       AND k.state IN('possible','unknown','conflict','withdrawn')) AS external_unknown,
     EXISTS(SELECT 1 FROM memory_source_processing_receipts receipt WHERE receipt.installation_id=b.installation_id
      AND receipt.session_id=b.session_id AND receipt.source_digest=b.source_digest
      AND receipt.turn_id=substr(b.task_key,10) AND b.task_key LIKE 'dialogue:%' AND receipt.complete) AS receipt
    FROM memory_task_bundles b LEFT JOIN LATERAL(SELECT r.* FROM memory_curation_runs r
      WHERE r.installation_id=b.installation_id AND r.bundle_id=b.bundle_id AND r.bundle_revision=$3
      ORDER BY r.started_at DESC,r.run_id DESC LIMIT 1) r ON true
    WHERE b.installation_id=$1 AND b.bundle_id=$2`,[i,p.bundle_id,p.bundle_revision])
  if(!r)return noInput()
  if(r.run_id&&r.claimed_by!==j.job_id)return observation([r.run_id,r.run_state],false,false,{session:r.session_id,reason:'original_run_unproven'})
  const live=r.body_state==='present'&&r.revision===String(p.bundle_revision)
  return observation([r.revision,r.state,r.run_id,r.run_state,r.reconciliation_code,r.external_unknown,Buffer.from(r.source_digest).toString('hex')],live,
   live&&r.run_state==='completed'&&r.receipt,{session:r.session_id,runId:r.run_id??undefined,runEpoch:r.run_epoch??undefined,
    reason:r.external_unknown||r.run_id&&!r.checkpoint_protocol&&!r.has_result?'external_result_unconfirmed':undefined})
 }
 const grantLock=(await db.query('SELECT shared.lock_memory_grant_authority(ARRAY[$1::uuid],ARRAY[]::uuid[]) AS held',[i])).rows[0]?.held===true
 const privacy=(await db.query("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1::text,0)) AS held",[i])).rows[0]?.held===true
 const grant=(await db.query('SELECT state FROM shared.memory_current_grant_states(ARRAY[$1::uuid],ARRAY[]::uuid[])',[i])).rows[0]?.state
 const authorized=grantLock&&privacy&&grant?.status==='active'&&grant.provider_enabled===true&&grant.owner_exists===true
 if(j.job_type==='curate_conclusions'){
  if(!uuid(p.candidate_id)||!uuid(p.bundle_id)||!uuid(p.run_id))return noInput()
  const {rows:[r]}=await db.query(`SELECT b.session_id,b.revision,encode(b.source_digest,'hex') AS source_digest,b.parent_revision,parent.revision AS parent_now,b.body_state,
     c.status,c.bundle_revision,r.state AS run_state,r.policy_revision,pol.revision AS policy_now,pol.mode,
     r.authorization_epoch::text,s.state AS space_state,
     (SELECT d.action FROM memory_curation_decisions d WHERE d.installation_id=c.installation_id
       AND d.candidate_id=c.candidate_id AND d.run_id=c.curation_run_id AND d.state IN('committed','skipped') ORDER BY d.created_at DESC LIMIT 1) AS decision
    FROM memory_candidates c JOIN memory_task_bundles b USING(installation_id,bundle_id)
    JOIN memory_curation_runs r ON r.installation_id=c.installation_id AND r.run_id=c.curation_run_id
    LEFT JOIN memory_task_bundles parent ON parent.installation_id=b.installation_id AND parent.bundle_id=b.parent_bundle_id
    LEFT JOIN memory_spaces s ON s.installation_id=b.installation_id AND s.space_id=b.space_id
    LEFT JOIN memory_curation_policies pol ON pol.installation_id=c.installation_id
    WHERE c.installation_id=$1 AND c.candidate_id=$2 AND c.bundle_id=$3 AND c.curation_run_id=$4 AND c.source_kind='task_bundle'`,
   [i,p.candidate_id,p.bundle_id,p.run_id])
  if(!r)return noInput()
  const sessionReady=(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:session:'||$1::text||':'||$2,0)) AS held",[i,r.session_id])).rows[0]?.held===true
  const eligible=sessionReady&&authorized&&r.status==='validated'&&r.bundle_revision===r.revision&&r.parent_revision===r.parent_now&&
   r.space_state==='active'&&r.mode==='enabled'&&r.policy_revision===r.policy_now&&r.run_state==='completed'&&r.authorization_epoch===String(grant.authorization_epoch)
  const resolved=!!r.decision&&!(r.decision==='defer'&&j.idempotency_key.startsWith('curate-deadline:'))
  return observation([r,grantLock,privacy,sessionReady,grant?.authorization_epoch??null],eligible,resolved,{session:r.session_id})
 }
 const feature=(await db.query('SELECT revision,embedding_mode,embedding_consent_fingerprint FROM memory_feature_settings WHERE installation_id=$1',[i])).rows[0]??null
 if(j.job_type==='rebuild_claim_index'){
  const hit=await db.query('SELECT 1 FROM memory_index_rebuild_page_receipts WHERE installation_id=$1 AND job_id=$2 AND input_digest=$3',[i,j.job_id,rebuildDigest(j)])
  return observation([feature,grantLock,privacy,grant?.authorization_epoch??null],authorized,!!hit.rowCount)
 }
 if(!uuid(p.version_id))return noInput()
 const {rows:[r]}=await db.query(`SELECT v.version_id,c.state,c.consumption_hold_reason,(${currentClaimVersionSql()}) AS current_version,
    d.embedding_status FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
    LEFT JOIN claim_search_documents d ON d.installation_id=v.installation_id AND d.version_id=v.version_id
    WHERE v.installation_id=$1 AND v.version_id=$2`,[i,p.version_id])
 if(!r)return noInput()
 const valid=authorized&&r.current_version&&r.state==='active'&&!r.consumption_hold_reason
 let complete=false,callState:string|null=null
 if(valid){
  // The live installation grant is locked above. Recheck the current, active
  // ledger version and its retained body in the statement which reads text.
  const proof=(await db.query(`SELECT c.claim_type AS "claimType",v.statement,v.structured_content AS "structuredContent",
    repo.repository_key AS "repositoryKey",v.branch,d.document,d.embedding_status AS status,d.embedding_provider AS provider,
    d.embedding_model AS model,d.embedding_dimensions AS dimensions,d.embedding_fingerprint AS fingerprint
    FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
    JOIN claim_search_documents d ON d.installation_id=v.installation_id AND d.version_id=v.version_id
    LEFT JOIN repositories repo ON repo.installation_id=v.installation_id AND repo.repository_id=v.repository_id
    WHERE v.installation_id=$1 AND v.version_id=$2 AND c.state='active' AND c.consumption_hold_reason IS NULL
      AND ${currentClaimVersionSql()} FOR SHARE OF c,v,d NOWAIT`,[i,p.version_id])).rows[0]
  if(proof){
   const expected=currentIndexOutput(proof,feature?.embedding_mode,feature?.embedding_consent_fingerprint,p.adapter_fingerprint)
   if(expected?.lexical)complete=true
   if(expected?.call){
    callState=(await db.query('SELECT state FROM memory_index_calls WHERE installation_id=$1 AND version_id=$2 AND input_digest=$3',
      [i,p.version_id,expected.call])).rows[0]?.state??null
    complete=callState==='published'
   }
  }
 }
 return observation([r,feature,privacy,grantLock,grant?.authorization_epoch??null,callState],valid,complete)
}

/** Called with the live queue row locked and its exact epoch verified. No
 * provider is contacted by failure settlement or by the due-work sweep. */
export async function settleNativeStage(db:Db,j:Job,errorCode:string,terminal=false,availableAt?:Date){
 if(!canIsolateStage(j.job_type)||!j.installation_id)return false
 const input=inputIdentity(j)
 if(!input)return false
 const prior=(await db.query(`SELECT attempts,first_failed_at<clock_timestamp()-interval '2 minutes' AS elapsed,
   status,claim_epoch FROM memory_stage_dispositions WHERE job_id=$1 AND input_digest=$2`,[j.job_id,input])).rows[0]
 const attempts=Number(prior?.attempts??0)+1
 await db.query('SAVEPOINT stage_observation')
 let check:Observation
 try{check=await observe(db,j)}catch{
  await db.query('ROLLBACK TO SAVEPOINT stage_observation')
  check=noInput()
 }
 await db.query('RELEASE SAVEPOINT stage_observation')
 const retry=!terminal&&attempts<=3&&!prior?.elapsed&&!check.resolved&&!(j.job_type==='consolidate_task'&&(check.runId||check.reason==='original_run_unproven'||!check.known))
 const status=check.resolved?'resolved':retry?'retrying':'isolated'
 const reason=check.resolved?'business_receipt':check.reason??errorCode
 const object=j.job_type==='project_shared_source'?j.payload.distribution_scan:
    j.payload.candidate_id??j.payload.bundle_id??j.payload.version_id
 const key=uuid(object)?object:digest(j.idempotency_key)
 await db.query(`INSERT INTO memory_stage_dispositions(job_id,claim_epoch,installation_id,job_type,object_key,input_digest,session_id,
    status,reason,attempts,dependency_digest,processor_revision,closed_at,next_probe_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $8<>'retrying' THEN clock_timestamp() END,
     CASE WHEN $8='isolated' THEN clock_timestamp()+interval '1 minute' END)
   ON CONFLICT(job_id) DO UPDATE SET claim_epoch=excluded.claim_epoch,object_key=excluded.object_key,input_digest=excluded.input_digest,
    status=excluded.status,reason=excluded.reason,attempts=excluded.attempts,dependency_digest=excluded.dependency_digest,
    processor_revision=excluded.processor_revision,updated_at=clock_timestamp(),closed_at=excluded.closed_at,next_probe_at=excluded.next_probe_at`,
    [j.job_id,j.claim_epoch,j.installation_id,j.job_type,key,input,check.session??null,status,reason,attempts,check.digest,processor])
 if(j.job_type==='consolidate_task'&&check.runId&&!retry&&!check.resolved){
  // The curation reconciler alone decides whether any local continuation is
  // allowed. It checks original paid usage and every window before requeue.
  await db.query(`UPDATE memory_curation_runs SET recovery_at=COALESCE(recovery_at,clock_timestamp()+interval '1 minute'),
    stage_job_epoch=$3,stage_run_epoch=$4 WHERE installation_id=$1 AND run_id=$2 AND claim_epoch=$4 AND claimed_by=$5
    AND state<>'completed'`,[j.installation_id,check.runId,j.claim_epoch,check.runEpoch,j.job_id])
 }
 const delay=[1000,5000,20000][attempts-1]??0
 const released=await db.query(`UPDATE memory_jobs SET state=$2,claimed_by=NULL,claim_expires_at=NULL,last_error_code=$3,
    completed_at=CASE WHEN $2='completed' THEN clock_timestamp() END,
    available_at=GREATEST(clock_timestamp()+$4*interval '1 millisecond',COALESCE($5,clock_timestamp()))
    WHERE job_id=$1 AND claim_epoch=$6 AND state='running' AND claim_expires_at>clock_timestamp()`,
    [j.job_id,retry?'pending':'completed',check.resolved?null:reason,delay+Math.floor(Math.random()*400),availableAt??null,j.claim_epoch])
 if(!released.rowCount)throw Error('stage_claim_expired')
 return true
}

export async function recordRebuildPage(c:Db,j:{job_id:string;installation_id:string|null;idempotency_key:string;payload:Record<string,unknown>},
 fence:{jobId:string;claimEpoch:number},examined:number,dispatched:number){
 if(!j.installation_id||j.job_id!==fence.jobId)return
 await c.query(`INSERT INTO memory_index_rebuild_page_receipts(job_id,installation_id,input_digest,claim_epoch,examined_count,dispatched_count)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[j.job_id,j.installation_id,rebuildDigest(j),fence.claimEpoch,examined,dispatched])
}
const rebuildDigest=(j:{installation_id:string|null;idempotency_key:string;payload:Record<string,unknown>})=>
 digest([j.installation_id,j.idempotency_key,j.payload.adapter_fingerprint??'default',j.payload.after_version_id??null])

/** First rotate candidate deadlines in a short transaction, then obtain each
 * queue lock in its own transaction. An unavailable object/lock cannot pin the
 * next entry. Recovery requires new evidence or a processor revision change. */
export async function recoverDueStageJobs(pool:pg.Pool){
 const due=(await pool.query(`WITH batch AS MATERIALIZED(SELECT job_id FROM memory_stage_dispositions
   WHERE next_probe_at<=clock_timestamp() ORDER BY next_probe_at,job_id LIMIT 12 FOR UPDATE SKIP LOCKED)
   UPDATE memory_stage_dispositions d SET probes=probes+1,next_probe_at=clock_timestamp()+interval '1 minute'*LEAST(60,probes+1)
    FROM batch WHERE d.job_id=batch.job_id RETURNING d.job_id`)).rows
 let queued=0,resolved=0
 const failed:string[]=[]
 for(const {job_id:id} of due){
  const c=await pool.connect()
  try{
   await c.query('BEGIN')
   await c.query("SET LOCAL lock_timeout='250ms';SET LOCAL statement_timeout='2s'")
   const j=(await c.query(`SELECT * FROM memory_jobs WHERE job_id=$1 AND state='completed' FOR UPDATE SKIP LOCKED`,[id])).rows[0]
   const d=(await c.query(`SELECT * FROM memory_stage_dispositions WHERE job_id=$1 AND status IN('isolated','repair_queued','retrying')
     FOR UPDATE SKIP LOCKED`,[id])).rows[0]
   if(j&&d&&j.installation_id===d.installation_id&&inputIdentity(j)===d.input_digest){
    const check=await observe(c,j)
    if(check.resolved){
     await c.query("UPDATE memory_stage_dispositions SET status='resolved',reason='business_receipt',closed_at=clock_timestamp(),next_probe_at=NULL,updated_at=clock_timestamp() WHERE job_id=$1",[id])
     await c.query('COMMIT');resolved++;continue
    }
    if(j.job_type==='consolidate_task'&&check.runId){
     // Changes to saved/uncertain windows only wake the original run. The
     // independent reconciler checks source, budget and exact request id.
     if(d.dependency_digest!==check.digest)await c.query(`UPDATE memory_curation_runs SET recovery_at=clock_timestamp()
       WHERE installation_id=$1 AND run_id=$2 AND state<>'completed'`,[j.installation_id,check.runId])
    }else if(check.eligible&&(d.processor_revision!==processor||d.repair_attempts<3&&(
      d.dependency_digest!==check.digest||d.reason==='grant_lock_conflict'&&j.job_type==='curate_conclusions'))){
     await c.query(`UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL,completed_at=NULL,
       available_at=clock_timestamp(),payload=payload||'{"failure_recovery":true}'::jsonb WHERE job_id=$1`,[id])
     await c.query(`UPDATE memory_stage_dispositions SET status='repair_queued',dependency_digest=$2,processor_revision=$3,
       repair_attempts=CASE WHEN processor_revision<>$3 THEN 1 ELSE repair_attempts+1 END,
       updated_at=clock_timestamp() WHERE job_id=$1`,[id,check.digest,processor])
     await c.query('COMMIT');queued++;continue
    }
    await c.query(`UPDATE memory_stage_dispositions SET dependency_digest=$2,updated_at=clock_timestamp(),status='isolated',
       closed_at=COALESCE(closed_at,clock_timestamp()) WHERE job_id=$1`,[id,check.digest])
   }
   await c.query('COMMIT')
  }catch(error){
   await c.query('ROLLBACK').catch(()=>undefined)
   failed.push(id)
  }finally{c.release()}
 }
 return {probed:due.length,queued,resolved,failed:failed.length}
}
