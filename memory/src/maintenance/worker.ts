import type pg from 'pg'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import {expirePendingCandidates} from '../claims/candidate-expiry.js'
import {retainInboxInstallation,type InboxRetentionSettings} from '../inbox/retention.js'
import {previewSourceRetention,reclaimSourceTurn,type SourceRetentionSettings,type RetentionPreviewCursor} from '../retention/source.js'
import {retainMigrationChanges,retainMigrationHistory} from '../retention/migrations.js'
import {retainInventoryReports} from '../retention/reports.js'
import {dailyMaintenanceSchedule,dailyMaintenanceSlot,nextDailyMaintenanceAt} from './daily.js'

type Counts = Record<string,number>
const add = (counts:Counts, delta:Counts) => {for(const [key,n] of Object.entries(delta)) counts[key]=(counts[key]??0)+n}
/** Each committed batch and its counters/checkpoint share one transaction.
 * Slow/locked installations yield to others. Provider delivery is a durable,
 * revisioned snapshot, retried independently of destructive work. */
export function createDailyMaintenanceWorker(options:{
 pool:pg.Pool;signal:AbortSignal;inbox:InboxRetentionSettings;data:SourceRetentionSettings
 report(input:Record<string,unknown>):Promise<void>
 onResult?(input:Record<string,unknown>):void;onError?(error:unknown):void
}) {
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<boolean>|undefined
 async function reportPending() {
  const rows=await options.pool.query(`SELECT r.*,g.state global_state,g.last_error_code global_error,g.completed_at global_completed_at FROM memory_maintenance_runs r
    JOIN memory_maintenance_runs g ON g.scheduled_at=r.scheduled_at AND g.scope_key='global' WHERE r.installation_id IS NOT NULL AND r.report_retry_at<=NOW() AND r.scheduled_at>NOW()-INTERVAL '90 days'
    AND EXISTS(SELECT 1 FROM memory_installations i WHERE i.installation_id=r.installation_id AND i.relay_status IN('active','paused'))
    AND NOT EXISTS(SELECT 1 FROM memory_owner_scopes s WHERE s.installation_id=r.installation_id AND s.owner_scope_kind<>'personal')
    AND r.revision>r.reported_revision AND (r.state='completed' OR r.reported_at IS NULL OR r.reported_at<NOW()-INTERVAL '1 minute') ORDER BY r.scheduled_at,r.scope_key LIMIT 20`)
  for(const row of rows.rows){
   if(stopped||options.signal.aborted)break
   try{await options.report({installation_id:row.installation_id,scheduled_at:new Date(row.scheduled_at).toISOString(),
    revision:Number(row.revision),state:row.state==='completed'&&row.global_state==='completed'?'completed':'running',last_error_code:row.last_error_code??row.global_error,
    counts:row.counts,started_at:new Date(row.started_at).toISOString(),
    completed_at:row.state==='completed'&&row.global_state==='completed'?new Date(Math.max(new Date(row.completed_at).getTime(),new Date(row.global_completed_at).getTime())).toISOString():null})
   await options.pool.query(`UPDATE memory_maintenance_runs SET reported_revision=GREATEST(reported_revision,$3),reported_at=NOW()
    WHERE scheduled_at=$1 AND scope_key=$2`,[row.scheduled_at,row.scope_key,row.revision])
   }catch(error){
    await options.pool.query(`UPDATE memory_maintenance_runs SET report_retry_at=clock_timestamp()+INTERVAL '1 minute' WHERE scheduled_at=$1 AND scope_key=$2`,[row.scheduled_at,row.scope_key])
    options.onError?.(error)
   }
  }
 }
 async function pass():Promise<boolean>{
  if(stopped||options.signal.aborted)return false
  const passStarted=Date.now()
  const slot=dailyMaintenanceSlot()
  if(slot){
   await options.pool.query(`INSERT INTO memory_maintenance_runs(scheduled_at,scope_key,installation_id)
    SELECT $1::timestamptz,'global',NULL::uuid UNION ALL
    SELECT $1::timestamptz,installation_id::text,installation_id FROM memory_installations
    WHERE local_status IN('ready','degraded') AND relay_status IN('active','paused') AND created_at<=$1
    ON CONFLICT DO NOTHING`,[slot])
  }
  // Query planning is read-only and happens outside the mutation transaction.
  const candidate=(await options.pool.query(`SELECT * FROM memory_maintenance_runs
   WHERE state='running' AND next_attempt_at<=NOW() ORDER BY scheduled_at,next_attempt_at,scope_key LIMIT 1`)).rows[0]
  let preview:Awaited<ReturnType<typeof previewSourceRetention>>|undefined
  if(candidate?.installation_id&&candidate.stage===2&&options.data.mode==='enabled') {
   try{preview=await previewSourceRetention(options.pool,options.data.bodyDays,1,{...candidate.cursor,installationId:candidate.installation_id})}
   catch(error){await options.pool.query(`UPDATE memory_maintenance_runs SET last_error_code='source_preview_failed',revision=revision+1,next_attempt_at=NOW()+INTERVAL '1 minute' WHERE scheduled_at=$1 AND scope_key=$2 AND state='running' AND stage=2`,[candidate.scheduled_at,candidate.scope_key]);options.onError?.(error);await reportPending().catch(e=>options.onError?.(e));return false}
  }
  if(candidate){
   const client=await options.pool.connect()
   try{
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'")
    const locked=(await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('memory:daily-maintenance',0)) locked`)).rows[0].locked
    const row=locked?(await client.query(`SELECT * FROM memory_maintenance_runs WHERE scheduled_at=$1 AND scope_key=$2
     AND state='running' AND next_attempt_at<=NOW() FOR UPDATE SKIP LOCKED`,[candidate.scheduled_at,candidate.scope_key])).rows[0]:undefined
    if(row&&row.stage===candidate.stage&&JSON.stringify(row.cursor)===JSON.stringify(candidate.cursor)){
     const bound=createTransactionBoundPool(client),delta:Counts={},counts:Counts={...row.counts}
     let more=false,busy=false,cursor:RetentionPreviewCursor={...row.cursor}
     if(row.installation_id){
      if(row.stage===0){delta.candidates_expired=await expirePendingCandidates(bound,500,row.installation_id);more=delta.candidates_expired===500}
      else if(row.stage===1){
       const r=await retainInboxInstallation(bound,row.installation_id,options.inbox)
       add(delta,{inbox_body:r.reclaimed,inbox_metadata:r.deleted})
       more=r.reclaimed>0||r.deleted>0;busy=r.skipped==='busy'
       if(r.skipped&&r.skipped!=='busy')delta['inbox_skipped_'+r.skipped]=1
       if(r.metadataBlocked)delta.inbox_metadata_blocked=1
      }else if(row.stage===2&&options.data.mode==='enabled'){
       const key=preview?.reclaiming[0]??preview?.eligible[0]
       if(key){
        const r=await reclaimSourceTurn(bound,{installationId:key.installation_id,sessionId:key.session_id,turnId:key.turn_id,episodeId:key.episode_id},options.data)
        for(const k of ['events','artifacts','snapshots','candidates','episodes'] as const)delta['source_'+k]=r[k]
        busy=r.skipped==='busy';more=true
        if(r.skipped&&!busy){delta.source_skipped=1;cursor={eligibleEpisodeId:key.episode_id,receiptInstallationId:key.installation_id,receiptTurnId:key.turn_id}}
       }else{
        const protectedRun=(await client.query(`SELECT EXISTS(SELECT 1 FROM memory_governance_migration_runs
         WHERE sealed_at IS NULL AND abandoned_at IS NULL AND details_reclaimed_at IS NULL
          AND (cardinality(scope_ids)=0 OR $1::uuid=ANY(scope_ids))) protected`,[row.installation_id])).rows[0].protected
        if(protectedRun)delta.source_migration_protected=1
       }
      }
     }else{
      if(row.stage===0&&options.data.mode==='enabled'){const r=await retainMigrationHistory(bound,options.data.batchSize);add(delta,r);more=Object.values(r).some(n=>n>0)}
      else if(row.stage===1&&options.data.mode==='enabled'){const r=await retainMigrationChanges(bound,options.data.batchSize);add(delta,r);more=r.changes>0}
      else if(row.stage===2&&options.data.mode==='enabled'&&options.data.reportDirectory){
       const r=await retainInventoryReports(bound,options.data.reportDirectory,options.data.batchSize);add(delta,{reports:r.reports,partials:r.partials});more=r.reports>0||r.partials>0;busy=r.busy
      }else if(row.stage===3){
       // Persistent expiry truth remains checked by readers/writers at use time.
       for(const [name,sql] of Object.entries({
        jobs:`DELETE FROM memory_jobs WHERE job_id IN(SELECT job_id FROM memory_jobs WHERE (state='completed' AND completed_at<NOW()-INTERVAL '24 hours') OR (state='dead' AND completed_at<NOW()-INTERVAL '7 days') LIMIT 500)`,
        extraction_runs:`DELETE FROM memory_extraction_runs WHERE run_id IN(SELECT run_id FROM memory_extraction_runs WHERE state IN('failed','quarantined') AND completed_at<NOW()-INTERVAL '7 days' LIMIT 500)`,
        feedback:`UPDATE memory_feedback SET details='{}',reason_code=NULL WHERE ctid IN(SELECT ctid FROM memory_feedback WHERE created_at<NOW()-INTERVAL '30 days' AND (details<>'{}'::jsonb OR reason_code IS NOT NULL) LIMIT 500)`,
        maintenance_history:`DELETE FROM memory_maintenance_runs WHERE (scheduled_at,scope_key) IN(SELECT scheduled_at,scope_key FROM memory_maintenance_runs WHERE state='completed' AND scheduled_at<NOW()-INTERVAL '90 days' LIMIT 500)`,
        idempotency:`DELETE FROM memory_idempotency_keys WHERE ctid IN(SELECT ctid FROM memory_idempotency_keys WHERE expires_at<=NOW() LIMIT 500)`
       }))delta[name]=(await client.query(sql)).rowCount??0
       more=Object.values(delta).some(n=>n===500)
      }
     }
     add(counts,delta)
     const stage=row.stage+(more||busy?0:1),completed=stage>=(row.installation_id?3:4)
     await client.query(`UPDATE memory_maintenance_runs SET stage=$3,state=$4,counts=$5,cursor=$6,
      revision=revision+1,last_error_code=NULL,next_attempt_at=clock_timestamp()+($7::int*INTERVAL '1 second'),
      completed_at=CASE WHEN $4='completed' THEN NOW() ELSE NULL END WHERE scheduled_at=$1 AND scope_key=$2`,
      [row.scheduled_at,row.scope_key,stage,completed?'completed':'running',JSON.stringify(counts),JSON.stringify(cursor),busy?60:1])
     if(!row.installation_id&&completed)await client.query(`UPDATE memory_maintenance_runs SET revision=revision+1 WHERE scheduled_at=$1 AND installation_id IS NOT NULL`,[row.scheduled_at])
     await client.query('COMMIT')
     options.onResult?.({scheduledAt:new Date(row.scheduled_at).toISOString(),scope:row.installation_id?'installation':'global',stage:row.stage,completed,counts:delta,durationMs:Date.now()-passStarted})
    }else await client.query('ROLLBACK')
   }catch(error){
    await client.query('ROLLBACK').catch(()=>undefined)
    const code=String((error as {code?:string}).code??((error instanceof Error&&error.message==='inbox_retention_prefix_changed')?error.message:'maintenance_failed')).replace(/[^a-zA-Z0-9_]/g,'').slice(0,64)
    await client.query(`UPDATE memory_maintenance_runs SET last_error_code=$3,revision=revision+1,next_attempt_at=NOW()+INTERVAL '1 minute'
     WHERE scheduled_at=$1 AND scope_key=$2 AND state='running'`,[candidate.scheduled_at,candidate.scope_key,code])
    if(candidate.scope_key==='global')await client.query(`UPDATE memory_maintenance_runs SET revision=revision+1
     WHERE scheduled_at=$1 AND installation_id IS NOT NULL`,[candidate.scheduled_at])
    options.onError?.(error)
   }finally{client.release()}
  }
  try{await reportPending()}catch(error){options.onError?.(error)}
  return Boolean(candidate)
 }
 function runOnce():Promise<boolean>{
  if(inFlight)return inFlight
  inFlight=pass().finally(()=>{inFlight=undefined});return inFlight
 }
 function schedule(delay:number){if(stopped||options.signal.aborted)return;timer=setTimeout(()=>{timer=undefined;void runOnce().then(more=>schedule(more?dailyMaintenanceSchedule.continuationMs:Math.min(60_000,nextDailyMaintenanceAt().getTime()-Date.now()))).catch(error=>{options.onError?.(error);schedule(60_000)})},Math.max(1,delay));timer.unref?.()}
 return {runOnce,start(){if(!timer&&!stopped&&!options.signal.aborted)schedule(1)},async stop(){stopped=true;if(timer)clearTimeout(timer);await inFlight}}
}
