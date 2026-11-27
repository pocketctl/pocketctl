import type pg from 'pg'
import {GrantLockDeferred} from '../jobs/types.js'
import {withTransaction} from '../db.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {lockCurationAuthority,readCurationPolicy} from './policy.js'

const processor='curation-checkpoint-v1'
const uuid=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
export interface CurationRecoveryEntry {
 runId:string
 disposition:'unavailable'|'source_changed'|'external_result_unconfirmed'|'binding_pending'|'live'|'settled'|'local_recovery'|'queued'|'unverified'|'retry_exhausted'|'lock_wait'|'timed_out'
 savedWindows:number|null
 uncertainWindows:number|null
}
type Input={installationId:string;runIds:string[];apply?:boolean}

/** Reconcile exactly the named installation/run pairs. Exposes no task prose, responses or prompts.
 * The production adapters have no response-and-billing-idempotent lookup/replay capability. */
export async function inspectCurationRecovery(pool:pg.Pool,input:Input):Promise<CurationRecoveryEntry[]>{
 if(!uuid.test(input.installationId)||!input.runIds.length||input.runIds.length>25||input.runIds.some(id=>!uuid.test(id))||
  new Set(input.runIds).size!==input.runIds.length)throw Error('invalid_curation_reconciliation_scope')
 const entries:CurationRecoveryEntry[]=[]
 for(const runId of input.runIds){
  const result=await withTransaction(pool,async c=>{
   await c.query("SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='3s'")
   const shared=sourcePoolContext(pool).namespace==='memory'
   if(shared)await lockCurationAuthority(c,input.installationId)
   const {rows:[row]}=await c.query(`SELECT r.bundle_id,r.bundle_revision,r.source_digest,r.policy_revision,r.authorization_epoch,r.mode,r.state,r.recovery_processor,r.recovery_attempts,
    r.recovery_started_at<=clock_timestamp()-interval '1 hour' AS elapsed,b.task_key,
    r.checkpoint_protocol,r.input_tokens,r.output_tokens,r.claimed_by,r.error_code,r.result IS NOT NULL AS has_result,b.revision AS current_revision,b.source_digest AS current_digest,b.body_state,
    r.claim_expires_at>clock_timestamp() AS live,b.session_id,b.state AS bundle_state,j.state AS job_state,
    r.stage_job_epoch,r.stage_run_epoch,r.claim_epoch,
    EXISTS(SELECT 1 FROM memory_curation_runs newer WHERE newer.installation_id=r.installation_id
      AND newer.bundle_id=b.bundle_id AND newer.bundle_revision=b.revision AND newer.run_id<>r.run_id
      AND (newer.state IN ('running','completed') OR (newer.started_at,newer.run_id)>(r.started_at,r.run_id))) AS superseded,
    EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=b.installation_id AND t.session_id=b.session_id) AS purged,
    EXISTS(SELECT 1 FROM memory_usage_outbox u WHERE u.installation_id=r.installation_id AND u.usage_id='curation:'||r.run_id) AS charged,
    counts.saved,counts.uncertain,counts.withdrawn,counts.all_count
    FROM memory_curation_runs r JOIN memory_task_bundles b USING(installation_id,bundle_id)
    JOIN memory_installations i USING(installation_id)
    LEFT JOIN memory_jobs j ON j.job_id::text=r.claimed_by AND j.installation_id=r.installation_id AND j.job_type='consolidate_task'
    CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE state='saved')::int saved,
      count(*) FILTER(WHERE state IN ('possible','unknown','conflict'))::int uncertain,
      count(*) FILTER(WHERE state='withdrawn')::int withdrawn,count(*)::int all_count FROM memory_curation_calls
      WHERE installation_id=r.installation_id AND run_id=r.run_id) counts
    WHERE r.installation_id=$1 AND r.run_id=$2 AND b.bundle_kind='intake' AND r.parent_run_id IS NULL
      AND ($3::boolean OR i.relay_status='active') AND i.local_status NOT IN('purging','purged','integrity_error')
    FOR UPDATE OF b,r`,[input.installationId,runId,shared])
   const entry=(disposition:CurationRecoveryEntry['disposition']):CurationRecoveryEntry=>({runId,disposition,
    savedWindows:row?.saved??null,uncertainWindows:row?.uncertain??null})
   if(!row||row.purged)return entry('unavailable')
   const policy=await readCurationPolicy(c,input.installationId,'enabled')
   if(!policy||policy==='source_denied'||row.authorization_epoch!==policy.authorizationEpoch||Number(row.policy_revision)!==policy.revision||
    (row.mode==='enabled'&&policy.mode!=='enabled')||row.body_state!=='present'||row.bundle_revision!==row.current_revision||
    !row.current_digest.equals(row.source_digest)||row.withdrawn)return entry('source_changed')
   if(row.state==='completed'||row.bundle_state==='completed')return entry('settled')
   if(row.superseded)return entry('source_changed')
   if(row.state==='running'&&row.live||row.job_state==='running')return entry('live')
   const isolatedExpiry=row.checkpoint_protocol===1&&row.state==='running'&&row.job_state==='completed'&&!row.live
   if(row.state==='running'&&row.job_state==='completed'){
    if(!isolatedExpiry||row.stage_run_epoch!==row.claim_epoch||!row.stage_job_epoch)return entry('unverified')
    const check=await c.query(`SELECT 1 FROM memory_jobs j JOIN memory_stage_dispositions d USING(installation_id,job_id,job_type,claim_epoch)
      WHERE j.installation_id=$1 AND j.job_id=$2 AND j.claim_epoch=$3 AND j.job_type='consolidate_task'
        AND j.state='completed' AND d.status='isolated' AND d.object_key=$4 AND j.payload->>'bundle_id'=$4
        AND j.payload->>'bundle_revision'=$5 FOR UPDATE OF j,d NOWAIT`,
     [input.installationId,row.claimed_by,row.stage_job_epoch,row.bundle_id,String(row.bundle_revision)])
    if(!check.rowCount)return entry('unverified')
   }
   const unsent=isolatedExpiry&&!row.charged&&row.input_tokens==='0'&&row.output_tokens==='0'
   const unknown=row.uncertain>0||!row.checkpoint_protocol&&!row.has_result&&(row.charged||row.input_tokens!=='0'||row.output_tokens!=='0'||row.state==='provider_result_unknown')
   if(unknown){
    if(input.apply){
     await c.query(`UPDATE memory_curation_runs SET reconciliation_code='external_result_unconfirmed',
      state=CASE WHEN $3 THEN 'provider_result_unknown' ELSE state END,
      completed_at=CASE WHEN $3 THEN clock_timestamp() ELSE completed_at END,
      reconciled_at=clock_timestamp(),recovery_at=NULL WHERE installation_id=$1 AND run_id=$2 AND reconciliation_code IS DISTINCT FROM 'external_result_unconfirmed'`,[input.installationId,runId,Boolean(isolatedExpiry)])
     await c.query(`UPDATE memory_task_bundles SET state='failed',reason_code='external_result_unconfirmed',updated_at=clock_timestamp()
       WHERE installation_id=$1 AND bundle_id=$2 AND revision=$3 AND source_digest=$4 AND body_state='present'
       AND state IN('running','blocked','failed') AND reason_code IS DISTINCT FROM 'external_result_unconfirmed'`,
       [input.installationId,row.bundle_id,row.bundle_revision,row.source_digest])
    }
    return entry('external_result_unconfirmed')
   }
   if(row.checkpoint_protocol!==1||!uuid.test(row.claimed_by)||(!row.saved&&!unsent&&row.state!=='failed'&&!['publication_interrupted','source_not_sent'].includes(row.error_code)))return entry('unverified')
   if(row.error_code==='task_binding_changed'){
    const dependency=await c.query(`SELECT 1 FROM memory_curation_items item
      LEFT JOIN memory_task_bundles t ON t.installation_id=item.installation_id AND t.bundle_id=item.task_id
      LEFT JOIN memory_spaces s ON s.installation_id=item.installation_id AND s.space_id=item.space_id
      WHERE item.installation_id=$1 AND item.run_id=$2 AND item.state='binding_pending' AND (
        t.revision IS DISTINCT FROM item.observed_revision OR s.state IS DISTINCT FROM item.observed_space_state
        OR t.updated_at>item.updated_at OR s.revision IS DISTINCT FROM item.observed_space_revision
        OR EXISTS(SELECT 1 FROM memory_candidates cand JOIN memory_curation_decisions d USING(installation_id,candidate_id)
          WHERE cand.installation_id=t.installation_id AND cand.bundle_id=t.bundle_id AND d.created_at>item.updated_at))
      LIMIT 1`,[input.installationId,runId])
    if(!dependency.rowCount)return entry('binding_pending')
   }
   // A due time alone cannot prove native source lock recovery. Probe the
   // same purge, source and processing-pin locks without waiting for them.
   if(shared && row.task_key.startsWith('dialogue:')){
    const {rows:[probe]}=await c.query(`WITH root AS MATERIALIZED (SELECT shared.memory_dialogue_context($1,$2) ctx)
     SELECT ctx IS NOT NULL AND shared.lock_memory_personal_source_commit(ctx->'scope','relay_event',ctx->>'root',ctx->'version',FALSE)
      AND pg_try_advisory_xact_lock(hashtextextended('processing-pin:installation:'||$1::text,0))
      AND pg_try_advisory_xact_lock(hashtextextended('processing-pin:root:'||(ctx->>'root'),0))
      AND pg_try_advisory_xact_lock(hashtextextended('turn-dialogue:'||$1::text||':'||$2||':'||$3,0)) AS ready FROM root`,
      [input.installationId,row.session_id,row.task_key.slice('dialogue:'.length)])
    if(!probe.ready)return entry('lock_wait')
   }
   if(row.error_code==='curation_finalize_failed' && row.recovery_processor===processor && (row.elapsed||row.recovery_attempts>=3)){
    if(input.apply){
     await c.query(`UPDATE memory_curation_runs SET reconciliation_code='local_recovery_exhausted',
      recovery_at=clock_timestamp()+interval '6 hours' WHERE installation_id=$1 AND run_id=$2`,[input.installationId,runId])
     await c.query(`UPDATE memory_task_bundles SET state='failed',reason_code='local_recovery_exhausted',updated_at=clock_timestamp()
      WHERE installation_id=$1 AND bundle_id=$2 AND revision=$3 AND state='blocked'`,[input.installationId,row.bundle_id,row.bundle_revision])
    }
    return entry('retry_exhausted')
   }
   if(!input.apply)return entry('local_recovery')
   if(row.job_state==='pending')return entry('queued')
   const idempotencyKey='consolidate:'+row.bundle_id+':'+row.bundle_revision
   const queued=await c.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
     VALUES($1,$2,'consolidate_task',$3,84,$4::jsonb)
     ON CONFLICT(job_id) DO UPDATE SET state='pending',available_at=clock_timestamp(),completed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,
      payload=memory_jobs.payload||'{"failure_recovery":true}'::jsonb
     WHERE memory_jobs.installation_id=EXCLUDED.installation_id AND memory_jobs.job_type=EXCLUDED.job_type
       AND memory_jobs.idempotency_key=EXCLUDED.idempotency_key AND memory_jobs.payload->>'bundle_id'=$5 AND memory_jobs.payload->>'bundle_revision'=$6
       AND memory_jobs.state IN ('completed','dead')`,[row.claimed_by,input.installationId,idempotencyKey,
      {bundle_id:row.bundle_id,bundle_revision:Number(row.bundle_revision),failure_recovery:true},row.bundle_id,String(row.bundle_revision)])
   if(!queued.rowCount)return entry('unverified')
   await c.query(`UPDATE memory_curation_runs SET recovery_attempts=CASE WHEN recovery_processor=$3 THEN recovery_attempts+1 ELSE 1 END,
     recovery_started_at=CASE WHEN recovery_processor=$3 THEN recovery_started_at ELSE clock_timestamp() END,
     recovery_processor=$3,recovery_at=clock_timestamp()+interval '5 minutes',
     reconciliation_code='local_recovery',reconciled_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2`,[input.installationId,runId,processor])
   return entry('queued')
  }).catch((error:unknown):CurationRecoveryEntry=>{
   const code=(error as {code?:string}|null)?.code
   if(code!=='55P03'&&code!=='40P01'&&code!=='57014'&&!(error instanceof GrantLockDeferred))throw error
   return {runId,disposition:code==='57014'?'timed_out':'lock_wait',savedWindows:null,uncertainWindows:null}
  })
  entries.push(result)
 }
 return entries
}

/** A bounded metadata probe also covers missed notifications. Advance the poll deadline
 * before leaving the transaction so an ineligible old item cannot monopolize the scan. */
export async function recoverDueCurationCheckpoints(pool:pg.Pool){
 const due=await withTransaction(pool,async c=>(await c.query(`WITH due AS MATERIALIZED (
   SELECT installation_id,run_id FROM memory_curation_runs WHERE recovery_at<=clock_timestamp()
    AND state<>'completed' AND (state<>'running' OR claim_expires_at<=clock_timestamp())
    ORDER BY recovery_at,run_id LIMIT 12 FOR UPDATE SKIP LOCKED)
   UPDATE memory_curation_runs r SET recovery_at=clock_timestamp()+interval '5 minutes'
   FROM due WHERE r.installation_id=due.installation_id AND r.run_id=due.run_id RETURNING r.installation_id,r.run_id,r.recovery_at::text AS poll_at`)).rows)
 let queued=0
 const failures:unknown[]=[]
 for(const row of due){
  try{
   const [checked]=await inspectCurationRecovery(pool,{installationId:row.installation_id,runIds:[row.run_id],apply:true})
   if(checked.disposition==='queued')queued++
   if(checked.disposition==='timed_out')failures.push(new Error('curation_recovery_timed_out'))
   if(checked.disposition==='source_changed'||checked.disposition==='unavailable')
    await pool.query(`UPDATE memory_curation_runs SET recovery_at=NULL WHERE installation_id=$1 AND run_id=$2
     AND state<>'running' AND recovery_at=$3::timestamptz`,[row.installation_id,row.run_id,row.poll_at])
  }catch(error){failures.push(error)}
 }
 if(failures.length)throw new AggregateError(failures,'curation_recovery_batch_errors:'+failures.length)
 return queued
}
