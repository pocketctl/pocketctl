import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify'
import type pg from 'pg'
import {z} from 'zod'
import {MemoryApiError, errorBody} from '../api/errors.js'
import {assertCurrentGrantClock, requireCurrentInstallationAuthority, TargetBindingError} from '../governance/authorization.js'
import {claimLifecycle, lifecycleStatus, lifecycleCatalog} from './status.js'

interface Grant {installationId: string; callerType?: string; configVersion?: string; expiresAt?: number}
type Result = {ok: true; metadata: Record<string, unknown>} | {ok: false; error: unknown}
export interface LifecycleManageDeps {
  pool: pg.Pool
  lifecycleMode?: 'off' | 'shadow' | 'enabled'
  guard(request: FastifyRequest, reply: FastifyReply): Promise<Grant | undefined>
  mutation(request: FastifyRequest, reply: FastifyReply, operation: string,
    run: (grant: Grant, pool: pg.Pool, client: pg.PoolClient) => Promise<Result>): Promise<unknown>
}
const idSchema = z.uuid()
export function registerLifecycleManageRoutes(app: FastifyInstance, deps: LifecycleManageDeps) {
  async function read(request: FastifyRequest, reply: FastifyReply, query: (client: pg.PoolClient, id: string) => Promise<unknown>) {
    const grant = await deps.guard(request, reply)
    if (!grant) return
    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      await requireCurrentInstallationAuthority(client, grant)
      const result = await query(client, grant.installationId)
      await assertCurrentGrantClock(client, grant)
      await client.query('COMMIT')
      reply.header('cache-control', 'no-store')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      if (error instanceof TargetBindingError) return reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'current authorization required')))
      throw error
    } finally { client.release() }
  }
  app.post('/api/v1/memory/scenes',{bodyLimit:2048},async(request,reply)=>{
    const parsed=z.strictObject({expected_revision:z.literal(0),name:z.string().trim().min(1).max(200),domain:z.literal('personal_project')}).safeParse(request.body)
    if(!parsed.success)return reply.code(400).send(errorBody(new MemoryApiError('invalid_request','invalid personal scene')))
    return deps.mutation(request,reply,'create_personal_scene',async(grant,_pool,client)=>{
      const row=(await client.query(`INSERT INTO memory_spaces(installation_id,name,domain,destinations) VALUES($1,$2,$3,ARRAY['personal']) RETURNING space_id::text,name,domain,destinations,revision`,[grant.installationId,parsed.data.name,parsed.data.domain])).rows[0]
      return {ok:true,metadata:{...row,revision:Number(row.revision)}}
    })
  })
  app.get('/api/v1/memory/lifecycle/status', (request, reply) => read(request, reply, (client, id) => lifecycleStatus(client, id, deps.lifecycleMode)))
  app.get('/api/v1/memory/lifecycle/claims', async(request,reply)=>{
    const parsed=z.strictObject({view:z.enum(['cold','history']),cursor:z.uuid().optional()}).safeParse(request.query)
    if(!parsed.success)return reply.code(400).send(errorBody(new MemoryApiError('invalid_request','invalid lifecycle catalog query')))
    return read(request,reply,(client,id)=>lifecycleCatalog(client,id,parsed.data.view,parsed.data.cursor??null))
  })
  app.get<{Params: {id: string}}>('/api/v1/memory/claims/:id/lifecycle', async (request, reply) => {
    if (!idSchema.safeParse(request.params.id).success) return reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid claim id')))
    return read(request, reply, async (client, installationId) => {
      const result = await claimLifecycle(client, installationId, request.params.id)
      if (!result) { reply.code(404); return errorBody(new MemoryApiError('not_found', 'resource not found')) }
      return result
    })
  })
  app.post<{Params: {id: string}}>('/api/v1/memory/claims/:id/protection', {bodyLimit: 1024}, async (request, reply) => {
    const parsed = z.strictObject({expected_revision: z.number().int().positive(), protection: z.enum(['none', 'pinned'])}).safeParse(request.body)
    if (!idSchema.safeParse(request.params.id).success || !parsed.success) return reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid protection request')))
    return deps.mutation(request, reply, 'protect_claim', async (grant, _pool, client) => {
      if (grant.callerType !== 'web') throw new TargetBindingError('explicit web user required')
      const scope = await client.query(`SELECT 1 FROM memory_owner_scopes WHERE installation_id=$1 AND owner_scope_kind='personal' AND state='active' FOR SHARE`, [grant.installationId])
      if (!scope.rowCount) throw new TargetBindingError('personal scope required')
      const claim = (await client.query(`SELECT c.revision,c.state FROM knowledge_claims c WHERE installation_id=$1 AND claim_id=$2 FOR UPDATE`, [grant.installationId, request.params.id])).rows[0]
      if (!claim) return {ok: false, error: {code: 'claim_not_found'}}
      if (Number(claim.revision) !== parsed.data.expected_revision) return {ok: false, error: {code: 'revision_conflict', currentRevision: Number(claim.revision), state: claim.state}}
      if (claim.state !== 'active') return {ok: false, error: {code: 'claim_not_active'}}
      const current = (await client.query(`SELECT protection FROM memory_claim_lifecycle WHERE installation_id=$1 AND claim_id=$2 FOR UPDATE`, [grant.installationId, request.params.id])).rows[0]
      if (!current) return {ok: false, error: {code: 'lifecycle_metadata_required'}}
      // Unpin cannot remove a stronger correction/critical safeguard.
      if (current && !['none', 'pinned'].includes(current.protection)) return {ok: false, error: {code: 'revision_conflict', currentRevision: Number(claim.revision), state: 'protected'}}
      await client.query(`UPDATE memory_claim_lifecycle SET protection=$3,revision=revision+1 WHERE installation_id=$1 AND claim_id=$2`, [grant.installationId, request.params.id, parsed.data.protection])
      const updated = (await client.query(`UPDATE knowledge_claims SET revision=revision+1,updated_at=clock_timestamp() WHERE installation_id=$1 AND claim_id=$2 RETURNING revision`, [grant.installationId, request.params.id])).rows[0]
      return {ok: true, metadata: {claim_id: request.params.id, revision: Number(updated.revision), protection: parsed.data.protection}}
    })
  })
}
