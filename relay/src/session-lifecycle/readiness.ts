import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { SessionLifecycleConfig } from './types.js'
import { configuredArchiveStorage } from '../session-history/runtime.js'
import { timestampMicros } from './time.js'

/** These are code/integration facts, not flags callers can attest via env. */
export function sessionLifecycleReadiness(config: SessionLifecycleConfig,readerInstalled=false) {
  const blockers:string[]=[]
  if(config.mode!=='enforce')blockers.push('enforcement_disabled')
  if(!readerInstalled)blockers.push('object_reader_not_configured')
  if(!config.effectiveAt||timestampMicros(config.effectiveAt)>timestampMicros(new Date()))blockers.push('policy_not_effective')
  if(!config.transitionDeadline)blockers.push('historical_transition_not_configured')
  if(process.env.NODE_ENV==='production')blockers.push('production_release_not_ready')
  return {
    configured_mode: config.mode,
    enabled: config.mode !== 'off',
    execution_ready: blockers.length===0,
    policy_version: config.policyVersion,
    blockers,
    production_release_ready:false,
    release_gates:['production_provider_and_backup_policy','legal_publication','production_client_release','capacity_and_fault_acceptance'],
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
    return sessionLifecycleReadiness(deps.config,Boolean(configuredArchiveStorage(deps.pool)))
  })
}
