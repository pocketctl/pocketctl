import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { SessionLifecycleConfig } from './types.js'
import { configuredArchiveStorage } from '../session-history/runtime.js'
import { timestampMicros } from './time.js'
import { readArchiveObject } from '../session-archive/storage.js'
import { lifecycleReleaseBlockers, lifecycleReleaseGates } from './release.js'

/** Shared by diagnostics and both execution boundaries. Evidence is recorded
 * by the release operator; installed storage and dates are checked here. */
export function sessionLifecycleReadiness(config: SessionLifecycleConfig, reader: boolean | { namespace?: string } = false, now: string | Date = new Date()) {
  const blockers:string[]=[]
  if(config.mode!=='enforce')blockers.push('enforcement_disabled')
  if(!reader)blockers.push('object_reader_not_configured')
  if(!config.effectiveAt||timestampMicros(config.effectiveAt)>timestampMicros(now))blockers.push('policy_not_effective')
  if(!config.transitionDeadline)blockers.push('historical_transition_not_configured')
  const releaseBlockers = lifecycleReleaseBlockers(config, typeof reader === 'object' ? reader.namespace : undefined, now)
  if(process.env.NODE_ENV==='production' && releaseBlockers.length)blockers.push('production_release_not_ready')
  return {
    configured_mode: config.mode,
    enabled: config.mode !== 'off',
    execution_ready: blockers.length===0,
    policy_version: config.policyVersion,
    archive_days: config.archiveDays,
    purge_days: config.purgeDays,
    schedule: { timezone: 'Asia/Shanghai', archive: '01:00', purge: '03:00', daily_notification: true },
    policy_published_at: config.release?.publishedAt ?? null,
    policy_effective_at: config.effectiveAt,
    historical_transition_deadline: config.transitionDeadline,
    storage_driver: config.storageDriver,
    blockers,
    production_release_ready: releaseBlockers.length === 0 && Boolean(reader) && !blockers.includes('policy_not_effective') && !blockers.includes('historical_transition_not_configured'),
    release_gates: lifecycleReleaseGates,
    release_blockers: releaseBlockers,
    release_gate_status: lifecycleReleaseGates.map(gate => ({ gate, evidence_recorded: Boolean(config.release?.evidence[gate]) })),
  }
}

export function registerSessionLifecycleStatusRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool
    config: SessionLifecycleConfig
    verifyAccessToken(
      token: string,
      pool: pg.Pool,
    ): Promise<{ userId: number } | null>
  },
): void {
  app.get('/api/session-lifecycle/deletions',async(req,reply)=>{
    reply.header('Cache-Control','no-store, private')
    const authorization=req.headers.authorization
    const user=authorization?.startsWith('Bearer ')?await deps.verifyAccessToken(authorization.slice(7),deps.pool):null
    if(!user)return reply.code(401).send({error:{code:'unauthorized'}})
    const cursor=(req.query as {cursor?:unknown}).cursor
    if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>128))return reply.code(400).send({error:{code:'invalid_cursor'}})
    const rows=(await deps.pool.query(`SELECT session_id FROM session_lifecycle_deletions WHERE user_id=$1 AND session_id>$2 ORDER BY session_id LIMIT 101`,[user.userId,cursor??''])).rows
    const page=rows.slice(0,100)
    return {session_ids:page.map(row=>row.session_id),next_cursor:rows.length>100?page.at(-1)!.session_id:null}
  })
  app.get('/api/session-lifecycle/status', async (req, reply) => {
    reply.header('Cache-Control', 'no-store, private')
    const authorization = req.headers.authorization
    const user = authorization?.startsWith('Bearer ')
      ? await deps.verifyAccessToken(authorization.slice(7), deps.pool)
      : null
    if (!user) return reply.code(401).send({ error: { code: 'unauthorized' } })
    const storage=configuredArchiveStorage(deps.pool)
    const base=sessionLifecycleReadiness(deps.config,storage??false)
    const backlog=(await deps.pool.query(`SELECT count(*)::int AS pending,
      EXTRACT(EPOCH FROM (NOW()-min(database_deleted_at)))::int AS oldest_age_seconds
      FROM session_lifecycle_deletions WHERE user_id=$1 AND (objects_completed_at IS NULL OR extensions_completed_at IS NULL)`,[user.userId])).rows[0]
    const chunks=(await deps.pool.query(`SELECT c.object_key FROM session_archive_chunks c JOIN session_archive_manifests m USING(manifest_id)
      WHERE m.user_id=$1 AND m.state='published' ORDER BY m.published_at DESC,c.ordinal LIMIT 3`,[user.userId])).rows
    let readable=0,readError=false
    for(const row of chunks){try{if(!storage)throw new Error('reader unavailable');await readArchiveObject(storage,row.object_key,deps.config.maxCompressedBytes);readable++}catch{readError=true}}
    return {...base,operational:{deletion_backlog:backlog,storage_read_sample:{checked:chunks.length,readable,failed:readError},
      healthy:!readError&&Number(backlog?.oldest_age_seconds??0)<86400}}

  })
}
