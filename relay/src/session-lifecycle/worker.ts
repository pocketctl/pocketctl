import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { ArchiveStorage } from '../session-archive/storage.js'
import { ArchiveObjectCollector } from '../session-archive/object-gc.js'
import { AttentionNotificationRepository } from '../attention-inbox/notification-repository.js'
import { inspectLifecycleEligibility } from './eligibility.js'
import { SessionLifecycleExecutor } from './executor.js'
import { SessionLifecycleScanner } from './scanner.js'
import type { SessionLifecycleConfig } from './types.js'
import { sessionLifecycleReadiness } from './readiness.js'
import { nextMaintenanceAt } from './schedule.js'
import { DailyMaintenanceSchedule } from './schedule.js'

/** Single independent maintenance loop. Leases coordinate all workers; stop
 * drains current work and the next process can take expired durable claims. */
export function createSessionLifecycleWorker(pool:pg.Pool,config:SessionLifecycleConfig,storage:ArchiveStorage|undefined,secret:string,options:{workerId:string;deleteOptions?:Parameters<SessionLifecycleExecutor['execute']>[1];onReport?:(report:Record<string,unknown>)=>void}){
  let cursor=0,stopped=true,timer:ReturnType<typeof setTimeout>|undefined,current:Promise<void>|undefined
  let nextDelayMs=60_000
  const continuationDelayMs=Math.min(config.continuationDelayMs,config.scanIntervalMs)
  const scheduleRuns=new DailyMaintenanceSchedule(pool)
  const executor=storage?new SessionLifecycleExecutor(pool,config,storage,secret):undefined
  const collector=storage?new ArchiveObjectCollector(pool,storage):undefined
  const notices=new AttentionNotificationRepository(pool,secret)
  async function reconcile(){
    const rows=(await pool.query(`SELECT r.*,d.objects_completed_at,d.extensions_completed_at FROM session_lifecycle_deletions d
      JOIN session_lifecycle_results r ON r.operation_id=d.operation_id WHERE r.action='purge' AND r.state='partial' ORDER BY d.database_deleted_at LIMIT 100`)).rows
    for(const row of rows){
      const stages={database:'succeeded',objects:row.objects_completed_at?'succeeded':'pending',memory:row.extensions_completed_at?'succeeded':'pending'} as const
      const state=row.objects_completed_at&&row.extensions_completed_at?'succeeded':'partial'
      const db=await pool.connect()
      try{
        await db.query('BEGIN')
        const visible=(await db.query(`SELECT 1 FROM daemons WHERE daemon_id=$1 AND user_id=$2 AND EXISTS(
          SELECT 1 FROM attention_notifications WHERE notification_id=$3 AND user_id=$2 AND expires_at>NOW())`,[row.daemon_id,row.user_id,row.notification_id])).rows[0]
        if(visible){
          await notices.recordResultInTransaction(db,{operationId:row.operation_id,notificationId:row.notification_id??randomUUID(),userId:row.user_id,sessionId:row.session_id,
            daemonId:row.daemon_id,titleSnapshot:row.title_snapshot,daemonNameSnapshot:row.daemon_name_snapshot,action:'purge',state,
            activityAt:new Date(row.activity_at).toISOString(),effectivePurgeAt:row.effective_purge_at?new Date(row.effective_purge_at).toISOString():null,
            reasonCode:state==='succeeded'?'cloud_cleanup_completed':'external_cleanup_pending',retentionDays:config.notificationRetentionDays,stages})
        }else await db.query(`UPDATE session_lifecycle_results SET state=$2,stages=$3::jsonb,executed_at=NOW(),updated_at=NOW(),
          title_snapshot='',daemon_name_snapshot='' WHERE operation_id=$1 AND state='partial'`,[row.operation_id,state,JSON.stringify(stages)])
        if(state==='succeeded')await db.query(`UPDATE session_lifecycle_jobs SET state='succeeded',result='{"reason":"cloud_cleanup_completed"}'::jsonb,updated_at=NOW() WHERE operation_id=$1 AND state='partial'`,[row.operation_id])
        await db.query('COMMIT')
      }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
    }
  }
  async function pass(){
    nextDelayMs=60_000
    const start=Date.now(),counts:Record<string,number>={},report:Record<string,unknown>={mode:config.mode,scanned:0,executed:0,bytes:0,blocked:counts}
    const emit=()=>{const now=new Date();nextDelayMs=Math.max(1,Math.min(nextDelayMs,...(['archive','purge'] as const).map(action=>nextMaintenanceAt(action,now).getTime()-now.getTime())));options.onReport?.({...report,nextDelayMs})}
    // Committed cleanup continues with the maintenance switch off.
    if(collector)report.objectsDeleted=await collector.runOnce(config.batchSessions)
    await reconcile()
    await notices.expire(Math.min(100,config.batchSessions));await notices.deliverPending(100)
    if(config.mode==='off'){emit();return}
    if(config.mode==='observe'){
      const page=await new SessionLifecycleScanner(pool,config).scanPage({limit:Math.min(100,config.batchSessions),afterRowId:cursor})
      cursor=page.nextRowId??0;report.observe=page
      if(page.nextRowId!==null)nextDelayMs=continuationDelayMs
      emit();return
    }
    const readiness = sessionLifecycleReadiness(config, storage ?? false)
    if (!readiness.execution_ready || !executor) {
      report.blockedReadiness = readiness.blockers[0] ?? 'object_reader_not_configured'
      report.readinessBlockers = readiness.blockers
      report.releaseBlockers = readiness.release_blockers
      emit()
      return
    }
    const run=await scheduleRuns.claim(config)
    if(!run){emit();return}
    report.scheduledAction=run.action;report.scheduledAt=run.scheduledAt
    let afterRowId=run.afterRowId,scanComplete=run.scanComplete,completed=false,continuationWakeAt:number|null=null
    try{
      if(!scanComplete){
        const rows=(await pool.query(`SELECT id,session_id FROM sessions WHERE id>$1
          AND (last_activity_at IS NULL OR last_activity_at<NOW()-($2::int*interval '1 day'))
          ORDER BY id LIMIT $3`,[afterRowId,run.action==='purge'?config.purgeDays:config.archiveDays,config.batchSessions+1])).rows
        let inspected=0
        for(const row of rows.slice(0,config.batchSessions)){
          if(stopped||Date.now()-start>=config.runBudgetMs)break
          const inspection=await inspectLifecycleEligibility(pool,row.session_id,config),root=inspection.root
          for(const reason of inspection.prediction.blockedReasons)counts[reason]=(counts[reason]??0)+1
          const action=inspection.prediction.action
          const matching=run.action==='purge'?action==='purge':action==='archive'||action==='cool'
          if(root&&action&&matching&&!(action==='purge'&&inspection.members.some(member=>Number(member.id)<row.id)))
            await executor.jobs.enqueue({userId:root.user_id,sessionId:root.session_id,action,policyVersion:config.policyVersion,activityEpoch:root.epoch})
          afterRowId=Number(row.id);inspected++;report.scanned=inspected
        }
        scanComplete=inspected===rows.length
      }
      for(let index=0;index<config.batchSessions&&!stopped&&Date.now()-start<config.runBudgetMs;index++){
        const lease=await executor.jobs.claim(options.workerId,300000,{policyVersion:config.policyVersion,action:run.action})
        if(!lease)break
        const state=await executor.execute(lease,options.deleteOptions)
        report.executed=Number(report.executed)+1;counts[state]=(counts[state]??0)+1
        const result=(await pool.query('SELECT result FROM session_lifecycle_jobs WHERE operation_id=$1',[lease.operationId])).rows[0]?.result
        report.bytes=Number(report.bytes)+Number(result?.bytes??0)
        if(Number(report.bytes)>=config.batchBytes||lease.action==='archive'||lease.action==='cool')break
      }
      // Published budget-limited transfers continue in the same batch after
      // their retry delay. Actual failures retain the existing daily retry.
      // Active leases must also finish before this run can be declared complete.
      const pending=(await pool.query(`SELECT min(CASE WHEN state='running' THEN lease_until ELSE next_attempt_at END) AS wake_at
        FROM session_lifecycle_jobs j WHERE policy_version=$1 AND action=ANY($2::text[])
          AND ((state IN ('queued','failed','partial') AND next_attempt_at<=NOW()) OR state='running'
            OR (state='partial' AND result->>'reason'='transfer_budget_reached'))
          AND NOT EXISTS(SELECT 1 FROM session_lifecycle_deletions d WHERE d.operation_id=j.operation_id)`,
        [config.policyVersion,run.action==='purge'?['purge']:['archive','cool']])).rows[0]
      continuationWakeAt=pending.wake_at?new Date(pending.wake_at).getTime():null
      completed=scanComplete&&continuationWakeAt===null
    }finally{
      report.scanCursor=afterRowId;report.scanComplete=scanComplete;report.dailyRunComplete=completed
      report.scanCheckpointSaved=await scheduleRuns.finish(run,afterRowId,scanComplete,completed)
      nextDelayMs=completed?60_000:scanComplete&&continuationWakeAt!==null&&continuationWakeAt>Date.now()
        ?Math.min(60_000,Math.max(1,continuationWakeAt-Date.now())):continuationDelayMs
    }
    emit()
  }
  const runOnce=async()=>{if(current)return current;current=pass();try{await current}finally{current=undefined}}
  const schedule=()=>{if(stopped)return;timer=setTimeout(()=>{timer=undefined;void runOnce().catch(error=>options.onReport?.({errorName:error instanceof Error?error.name:'unknown'})).finally(schedule)},nextDelayMs);timer.unref?.()}
  return {start(){if(!stopped)return;stopped=false;void runOnce().catch(error=>options.onReport?.({errorName:error instanceof Error?error.name:'unknown'})).finally(schedule)},
    // One-shot maintenance honors the same daily schedule and durable leases.
    async stop(){stopped=true;if(timer)clearTimeout(timer);timer=undefined;await current},async runOnce(){const previous=stopped;stopped=false;try{await runOnce()}finally{stopped=previous}}}
}
