import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { ArchiveStorage } from '../session-archive/storage.js'
import { ArchiveObjectCollector } from '../session-archive/object-gc.js'
import { AttentionNotificationRepository } from '../attention-inbox/notification-repository.js'
import { inspectLifecycleEligibility } from './eligibility.js'
import { SessionLifecycleExecutor } from './executor.js'
import { SessionLifecycleScanner } from './scanner.js'
import type { SessionLifecycleConfig } from './types.js'

/** Single independent maintenance loop. Leases coordinate all workers; stop
 * drains current work and the next process can take expired durable claims. */
export function createSessionLifecycleWorker(pool:pg.Pool,config:SessionLifecycleConfig,storage:ArchiveStorage|undefined,secret:string,options:{workerId:string;deleteOptions?:Parameters<SessionLifecycleExecutor['execute']>[1];onReport?:(report:Record<string,unknown>)=>void}){
  let cursor=0,stopped=true,timer:ReturnType<typeof setTimeout>|undefined,current:Promise<void>|undefined
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
    const start=Date.now(),counts:Record<string,number>={},report:Record<string,unknown>={mode:config.mode,scanned:0,executed:0,bytes:0,blocked:counts}
    // Committed cleanup continues with the maintenance switch off.
    if(collector)report.objectsDeleted=await collector.runOnce(config.batchSessions)
    await reconcile()
    await notices.expire(Math.min(100,config.batchSessions));await notices.deliverPending(100)
    if(config.mode==='off'){options.onReport?.(report);return}
    if(config.mode==='observe'){
      const page=await new SessionLifecycleScanner(pool,config).scanPage({limit:Math.min(100,config.batchSessions),afterRowId:cursor})
      cursor=page.nextRowId??0;report.observe=page;options.onReport?.(report);return
    }
    if(process.env.NODE_ENV==='production'){report.blockedReadiness='production_release_not_ready';options.onReport?.(report);return}
    if(!executor||!config.effectiveAt||!config.transitionDeadline){report.blockedReadiness=!executor?'object_store_unconfigured':'policy_not_effective';options.onReport?.(report);return}
    const rows=(await pool.query(`SELECT id,session_id FROM sessions WHERE id>$1 AND (last_activity_at IS NULL OR last_activity_at<NOW()-interval '60 days') ORDER BY id LIMIT $2`,[cursor,config.batchSessions])).rows
    cursor=rows.length===config.batchSessions?rows.at(-1)!.id:0
    for(const row of rows){
      if(stopped||Date.now()-start>=config.runBudgetMs)break
      report.scanned=Number(report.scanned)+1
      const inspection=await inspectLifecycleEligibility(pool,row.session_id,config),root=inspection.root
      for(const reason of inspection.prediction.blockedReasons)counts[reason]=(counts[reason]??0)+1
      if(!root||!inspection.prediction.action)continue
      if(inspection.prediction.action==='purge'&&inspection.members.some(member=>Number(member.id)<row.id))continue
      await executor.jobs.enqueue({userId:root.user_id,sessionId:root.session_id,action:inspection.prediction.action,policyVersion:config.policyVersion,activityEpoch:root.epoch})
    }
    for(let index=0;index<config.batchSessions&&!stopped&&Date.now()-start<config.runBudgetMs;index++){
      const lease=await executor.jobs.claim(options.workerId,300000)
      if(!lease)break
      const state=await executor.execute(lease,options.deleteOptions)
      report.executed=Number(report.executed)+1;counts[state]=(counts[state]??0)+1
      const result=(await pool.query('SELECT result FROM session_lifecycle_jobs WHERE operation_id=$1',[lease.operationId])).rows[0]?.result
      report.bytes=Number(report.bytes)+Number(result?.bytes??0)
      if(Number(report.bytes)>=config.batchBytes)break
      // A transfer pass consumes the shared byte/time budget. Other queued
      // sessions stay durable for the next pass rather than multiplying it.
      if(lease.action==='archive'||lease.action==='cool')break
    }
    options.onReport?.(report)
  }
  const runOnce=async()=>{if(current)return current;current=pass();try{await current}finally{current=undefined}}
  const schedule=()=>{if(stopped)return;timer=setTimeout(()=>{timer=undefined;void runOnce().catch(error=>options.onReport?.({errorName:error instanceof Error?error.name:'unknown'})).finally(schedule)},config.scanIntervalMs);timer.unref?.()}
  return {start(){if(!stopped)return;stopped=false;void runOnce().catch(error=>options.onReport?.({errorName:error instanceof Error?error.name:'unknown'})).finally(schedule)},
    async stop(){stopped=true;if(timer)clearTimeout(timer);timer=undefined;await current},async runOnce(){const previous=stopped;stopped=false;try{await runOnce()}finally{stopped=previous}}}
}
