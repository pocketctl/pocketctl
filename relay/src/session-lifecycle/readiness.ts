import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { SessionLifecycleConfig } from './types.js'
import { configuredArchiveStorage } from '../session-history/runtime.js'
import { timestampMicros } from './time.js'
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
    return sessionLifecycleReadiness(deps.config, configuredArchiveStorage(deps.pool) ?? false)
  })
}
