import {randomUUID} from 'node:crypto'
import type pg from 'pg'

export const STAGING_RETENTION_DAYS = 7
export function deliveryStagingCleanupEnabled(env: Record<string,string|undefined>, teamIds: string[]): boolean {
  const mode=env.TEAM_DELIVERY_STAGING_CLEANUP?.trim()||'off'
  if(!['off','on'].includes(mode))throw Error('TEAM_DELIVERY_STAGING_CLEANUP must be off or on')
  if(mode==='on'&&!teamIds.length)throw Error('staging cleanup requires explicit TEAM_TASK_DELIVERY_TEAMS')
  return mode==='on'
}

// Preserve metadata, receipts and all published/referenced/revoked evidence.
// A resumed publisher re-uploads its original immutable bytes using the same
// preparation ID; cleanup never creates a new execution or changes a decision.
const eligible = `s.state='preparing'
  AND EXISTS(SELECT 1 FROM team_submission_artifacts a WHERE a.submission_id=s.submission_id)
  AND GREATEST(s.created_at,COALESCE(activity.last_activity_at,s.created_at),
    (SELECT MAX(a.created_at) FROM team_submission_artifacts a WHERE a.submission_id=s.submission_id)) < NOW()-interval '${STAGING_RETENTION_DAYS} days'
  AND NOT EXISTS(SELECT 1 FROM team_acceptance_decisions d WHERE d.submission_id=s.submission_id)
  AND NOT EXISTS(SELECT 1 FROM team_task_delivery_heads h WHERE h.latest_submission_id=s.submission_id)
  AND NOT EXISTS(SELECT 1 FROM team_artifact_revocations r WHERE r.submission_id=s.submission_id)
  AND NOT EXISTS(SELECT 1 FROM team_task_submissions ref WHERE ref.contribution_ids ? s.submission_id::text)`

export class TeamDeliveryStagingCleanup {
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<{submissions:number; artifacts:number; bytes:number}>
  private stopped=true
  private readonly teamIds: string[]
  constructor(private readonly pool: pg.Pool, teamIds: string[], private readonly intervalMs=60*60*1000) {
    if(teamIds.some(id=>!/^[a-zA-Z0-9_-]{1,128}$/.test(id))||!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw Error('invalid staging cleanup configuration')
    this.teamIds=[...new Set(teamIds)]
  }
  async runOnce(limit=20): Promise<{submissions:number; artifacts:number; bytes:number}> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('invalid staging cleanup batch size')
    const result={submissions:0,artifacts:0,bytes:0}
    if(!this.teamIds.length)return result
    const client=await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout='15s'")
      const tasks=(await client.query(`SELECT t.task_id FROM team_tasks t
        WHERE t.team_id=ANY($1::text[]) AND EXISTS(SELECT 1 FROM team_task_submissions s
          LEFT JOIN team_delivery_staging_activity activity USING(submission_id) WHERE s.task_id=t.task_id AND ${eligible})
        ORDER BY t.task_id LIMIT $2 FOR UPDATE OF t SKIP LOCKED`,[this.teamIds,limit])).rows
      for(const {task_id:task} of tasks) {
        // The task lock is the same serialization boundary as upload/publish.
        // Recheck after acquiring it; a concurrent publication must win whole.
        const drafts=(await client.query(`SELECT s.submission_id FROM team_task_submissions s
          LEFT JOIN team_delivery_staging_activity activity USING(submission_id)
          WHERE s.task_id=$1 AND ${eligible} ORDER BY s.submission_id LIMIT 100`,[task])).rows
        for(const {submission_id:id} of drafts) {
          const removed=(await client.query(`WITH gone AS (DELETE FROM team_submission_artifacts WHERE submission_id=$1 RETURNING byte_size)
            SELECT COUNT(*)::int AS artifacts,COALESCE(SUM(byte_size),0)::bigint AS bytes FROM gone`,[id])).rows[0]
          if(!removed.artifacts)continue
          await client.query(`INSERT INTO team_delivery_staging_reclaims(reclaim_id,submission_id,artifact_count,byte_count,policy_version)
            VALUES($1,$2,$3,$4,'staging-bytes-v1')`,[randomUUID(),id,removed.artifacts,removed.bytes])
          result.submissions++;result.artifacts+=removed.artifacts;result.bytes+=Number(removed.bytes)
        }
      }
      await client.query('COMMIT');return result
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
    finally{client.release()}
  }
  start():void {if(!this.stopped)return;this.stopped=false;this.schedule(0)}
  private schedule(delay:number):void {
    if(this.stopped)return
    this.timer=setTimeout(()=>{
      this.timer=undefined;this.running=this.runOnce()
      void this.running.then(result=>{if(result.submissions)console.info('[team-delivery-staging-cleanup]',result)})
        .catch(error=>console.error('[team-delivery-staging-cleanup] failed',{name:error instanceof Error?error.name:'unknown'}))
        .finally(()=>{this.running=undefined;this.schedule(this.intervalMs)})
    },delay);this.timer.unref?.()
  }
  async stop():Promise<void> {this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;await this.running}
}
