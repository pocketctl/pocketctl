import {randomUUID} from 'node:crypto'
import type pg from 'pg'

export const maintenanceCounts = [
 'candidates_expired','inbox_body','inbox_metadata','inbox_metadata_blocked',
 'inbox_skipped_snapshot','inbox_skipped_inactive','inbox_skipped_unacknowledged',
 'source_events','source_artifacts','source_snapshots','source_candidates','source_episodes',
 'source_skipped','source_migration_protected',
] as const
export interface MaintenanceSummary {
 scheduled_at:string;state:'completed'|'partial';duration_seconds:number;counts:Record<string,number>
 pending_installations:number;failed_installations:number
}
export async function initMaintenanceSummarySchema(db:Pick<pg.Pool,'query'>){
 await db.query(`
  ALTER TABLE attention_notifications ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ DEFAULT NOW();
  ALTER TABLE attention_notifications ADD COLUMN IF NOT EXISTS maintenance_summary JSONB;
  CREATE TABLE IF NOT EXISTS maintenance_provider_results(
   installation_id UUID NOT NULL REFERENCES extension_installations(installation_id) ON DELETE CASCADE,
   scheduled_at TIMESTAMPTZ NOT NULL,revision BIGINT NOT NULL CHECK(revision>0),
   state TEXT NOT NULL CHECK(state IN('running','completed')),counts JSONB NOT NULL DEFAULT '{}',
   last_error_code VARCHAR(64),started_at TIMESTAMPTZ NOT NULL,completed_at TIMESTAMPTZ,
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,scheduled_at)
  );
  CREATE INDEX IF NOT EXISTS maintenance_provider_results_slot ON maintenance_provider_results(scheduled_at);
 `)
}

/** Durable drafts become visible once the whole day's work settles, or at
 * 05:00. Follow-up compensation changes the same notice without clearing read_at. */
export async function publishMaintenanceSummaries(pool:pg.Pool,policyVersion:string,requireLifecycle:boolean,now=new Date()):Promise<number>{
 const users=(await pool.query(`SELECT DISTINCT n.user_id,to_char(n.maintenance_day,'YYYY-MM-DD') maintenance_day FROM attention_notifications n
   WHERE n.maintenance_day IS NOT NULL AND n.expires_at>NOW() AND (n.published_at IS NULL OR n.maintenance_summary IS NOT NULL)
   UNION SELECT DISTINCT i.owner_user_id,to_char(r.scheduled_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')
   FROM maintenance_provider_results r JOIN extension_installations i USING(installation_id)
   WHERE i.status IN('active','paused') AND i.owner_type='user' AND r.scheduled_at>=NOW()-INTERVAL '7 days'
    AND (r.counts<>'{}'::jsonb OR r.last_error_code IS NOT NULL)`)).rows
 let published=0
 for(const user of users){
  const db=await pool.connect()
  try{
   await db.query('BEGIN')
   const day=typeof user.maintenance_day==='string'?user.maintenance_day.slice(0,10):new Date(user.maintenance_day).toLocaleDateString('en-CA',{timeZone:'UTC'})
   const scheduledAt=new Date(day+'T03:00:00+08:00')
   await db.query("SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s'")
   const locked=(await db.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('maintenance-summary:'||$1||':'||$2,0)) locked`,[String(user.user_id),day])).rows[0].locked
   if(!locked){await db.query('ROLLBACK');continue}
   if(scheduledAt>now){await db.query('ROLLBACK');continue}
   const providers=(await db.query(`SELECT i.installation_id,r.state,r.counts,r.last_error_code,r.started_at,r.completed_at
    FROM extension_installations i LEFT JOIN maintenance_provider_results r ON r.installation_id=i.installation_id AND r.scheduled_at=$2
    WHERE i.owner_user_id=$1 AND i.provider_id='pocketctl-memory' AND i.owner_type='user'
     AND i.status IN('active','paused') AND i.created_at<=$2`,[user.user_id,scheduledAt])).rows
   const lifecycleTimes=(await db.query(`SELECT min(started_at) started,max(completed_at) finished FROM session_lifecycle_daily_runs
    WHERE policy_version=$1 AND scheduled_at=$2`,[policyVersion,scheduledAt])).rows[0]
   const lifecycleDone=!requireLifecycle||(await db.query(`SELECT count(*)::int n FROM session_lifecycle_daily_runs
    WHERE policy_version=$1 AND scheduled_at=$2 AND action IN('archive','purge') AND completed_at IS NOT NULL`,[policyVersion,scheduledAt])).rows[0].n===2
   const pending=providers.filter(r=>r.state!=='completed').length,failed=providers.filter(r=>r.last_error_code).length
   const critical=providers.some(r=>['inbox_retention_prefix_changed','42501','XX001'].includes(r.last_error_code))
   const deadline=critical||now.getTime()>=scheduledAt.getTime()+2*3_600_000
   if((!lifecycleDone||pending>0||failed>0)&&!deadline){await db.query('ROLLBACK');continue}
   const counts:Record<string,number>={}
   for(const row of providers)for(const [k,v] of Object.entries(row.counts??{}))counts[k]=(counts[k]??0)+Number(v)
   const meaningful=Object.entries(counts).some(([k,v])=>v>0&&!k.includes('protected')&&!k.includes('blocked')&&!k.includes('skipped'))||failed>0
   let notice=(await db.query(`SELECT * FROM attention_notifications WHERE user_id=$1 AND maintenance_day=$2 FOR UPDATE`,[user.user_id,day])).rows[0]
   if(!notice&&!meaningful){await db.query('ROLLBACK');continue}
   if(!notice)notice=(await db.query(`INSERT INTO attention_notifications(notification_id,user_id,maintenance_day,published_at,expires_at)
    VALUES($1,$2,$3,NULL,NOW()+INTERVAL '90 days') ON CONFLICT(user_id,maintenance_day) WHERE maintenance_day IS NOT NULL
    DO UPDATE SET maintenance_day=EXCLUDED.maintenance_day RETURNING *`,[randomUUID(),user.user_id,day])).rows[0]
   // Subject results include late object/Memory cleanup. Never label those successful prematurely.
   const subjects=(await db.query(`SELECT action,state,count(*)::int n,max(executed_at) latest FROM attention_notification_subjects WHERE notification_id=$1 GROUP BY action,state`,[notice.notification_id])).rows
   let unsettled=false
   for(const row of subjects){counts['session_'+row.action]=(counts['session_'+row.action]??0)+row.n;if(['running','partial','failed'].includes(row.state))unsettled=true}
   if(unsettled&&!deadline&&!notice.published_at){await db.query('ROLLBACK');continue}
   const completed=lifecycleDone&&pending===0&&failed===0&&!unsettled
   const starts=[...providers.map(p=>p.started_at),lifecycleTimes.started].filter(Boolean).map(t=>new Date(t).getTime())
   const finishes=[...providers.map(p=>p.completed_at),...subjects.map(s=>s.latest),lifecycleTimes.finished].filter(Boolean).map(t=>new Date(t).getTime())
   const duration=Math.max(0,Math.floor(((completed&&finishes.length?Math.max(...finishes):now.getTime())-(starts.length?Math.min(...starts):new Date(notice.created_at).getTime()))/1000))
   const summary:MaintenanceSummary={scheduled_at:scheduledAt.toISOString(),state:completed?'completed':'partial',
    duration_seconds:notice.published_at&&notice.maintenance_summary&&!completed?notice.maintenance_summary.duration_seconds:duration,
    counts,pending_installations:pending,failed_installations:failed}
   {
    const changed=(await db.query(`UPDATE attention_notifications SET maintenance_summary=$2,published_at=COALESCE(published_at,$3),
     completed_at=CASE WHEN $4 THEN $3 ELSE NULL END,revision=revision+1,updated_at=NOW()
     WHERE notification_id=$1 AND (maintenance_summary IS DISTINCT FROM $2::jsonb OR published_at IS NULL) RETURNING revision`,[notice.notification_id,JSON.stringify(summary),now,summary.state==='completed'])).rows[0]
    if(!changed){await db.query('COMMIT');continue}
    await db.query(`INSERT INTO notification_delivery_outbox(user_id,notification_id,revision,operation)
     VALUES($1,$2,$3,'changed') ON CONFLICT DO NOTHING`,[user.user_id,notice.notification_id,changed.revision])
    // Listener loads the latest snapshot. Delivery outbox is the durable fallback.
    await db.query(`SELECT pg_notify('pocketctl_attention',json_build_object('entity','notification','user_id',$1::int,
     'item_id',$2::text,'revision',$3::bigint,'operation','changed')::text)`,[user.user_id,notice.notification_id,changed.revision])
    published++
   }
   await db.query('COMMIT')
  }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
 return published
}
