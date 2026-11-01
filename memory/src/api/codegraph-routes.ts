import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { GrantGuard, VerifiedMemoryGrant } from '../auth/grant-guard.js'
import { MemoryApiError, errorBody } from '../api/errors.js'
import { UUIDSchema } from '../api/schemas.js'
import {
  CodeSnapshotBatchSchema,
  CodeSnapshotManifestSchema,
  FinalizeCodeSnapshotRequestSchema,
  StartCodeSnapshotRequestSchema,
} from '../codegraph/source-repository.js'
import { createSourceIngestService, SnapshotIngestError } from '../codegraph/ingest-service.js'
import {requireSourceAuthority,assertSourceGrantClock,SourceLifecycleFenceError} from '../codegraph/lifecycle.js'
import {TargetBindingError} from '../governance/authorization.js'
import { SourceRepositoryTombstonedError } from '../codegraph/source-repository.js'
import { createCodeGraphReadService } from '../codegraph/read-service.js'
import { phase4ModeForScope, type SharedScopesMode } from '../config.js'
import type { Phase4Metrics } from '../metrics.js'
import { recordSharedPhase4MutationDenied } from '../audit/phase4-authorization-audit.js'

/**
 * Phase 4 source-sync routes (plan §4.1). Mutations require the
 * `memory.codegraph.write` grant; request identity derives from the verified
 * grant, never from a body field; foreign/missing snapshots read as uniform
 * 404s; batch bodies are bounded to the frozen 1 MiB request budget.
 */

const CODEGRAPH_SERVICE = 'memory.codegraph.write'

export interface CodegraphRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  codegraphMode?: 'off' | 'shadow' | 'enabled'
  sharedScopesMode?: SharedScopesMode
  cursorSigningKey: string
  phase4Metrics?: Phase4Metrics
}

export const CodeGraphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict()

export const CodeGraphImpactRequestSchema = z.object({
  entry_paths: z.array(z.string().min(1).max(1024)).min(1).max(20),
  depth: z.number().int().min(0).max(3).optional(),
  max_nodes: z.number().int().min(1).max(500).optional(),
  max_edges: z.number().int().min(1).max(2_000).optional(),
}).strict()

interface ReplyLike {
  code(status: number): { send(body: unknown): void }
  send(body: unknown): void
}

export function registerCodegraphRoutes(app: FastifyInstance, deps: CodegraphRouteDeps): void {
  const ingest = createSourceIngestService(deps.pool, { metrics: deps.phase4Metrics })
  const reads = createCodeGraphReadService(deps.pool, deps.cursorSigningKey)

  const authenticate = async (
    request: { headers: { authorization?: string } },
    reply: ReplyLike,
  ): Promise<VerifiedMemoryGrant | undefined> => {
    try {
      const guardAny = deps.guard.guardMcp?.bind(deps.guard) ?? deps.guard.guard.bind(deps.guard)
      return await guardAny({
        authorization: request.headers.authorization,
        requiredService: CODEGRAPH_SERVICE,
      })
    } catch (error) {
      if (error instanceof MemoryApiError) {
        reply.code(error.httpStatus).send(errorBody(error))
        return undefined
      }
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'request failed')))
      return undefined
    }
  }

  const fail = (reply: ReplyLike, error: unknown): void => {
    if(error instanceof TargetBindingError||error instanceof SourceLifecycleFenceError&&error.code==='forbidden'){
      reply.code(403).send(errorBody(new MemoryApiError('forbidden','source mutation rejected')))
      return
    }
    if (error instanceof SourceRepositoryTombstonedError || error instanceof SourceLifecycleFenceError) {
      const missing=error.code==='not_found'
      reply.code(missing?404:409).send(errorBody(new MemoryApiError(missing?'not_found':'revision_conflict', error.code)))
      return
    }
    if (error instanceof SnapshotIngestError) {
      const mapped = error.code === 'not_found' ? 'not_found' as const
        : error.code === 'feature_disabled' ? 'feature_disabled' as const
          : error.code === 'state_conflict' ? 'revision_conflict' as const
            : 'invalid_request' as const
      const status = mapped === 'not_found' ? 404
        : mapped === 'feature_disabled' ? 503
          : mapped === 'revision_conflict' ? 409 : 400
      reply.code(status).send(errorBody(new MemoryApiError(mapped, error.code)))
      return
    }
    reply.code(500).send(errorBody(new MemoryApiError('invalid_request', 'ingest failed')))
  }

  const requireContribute = async (
    reply: ReplyLike,
    grant: VerifiedMemoryGrant,
  ): Promise<boolean> => {
    if (!('version' in grant) || grant.version !== 'v2') return true
    const binding = grant.scopeBindings.find(item => item.installation_id === grant.installationId)
    if (binding?.permissions.includes('contribute')) return true
    await recordSharedPhase4MutationDenied(deps.pool, grant, 'source_upload')
    reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'source mutation rejected')))
    return false
  }

  const requireMutationMode = async (reply: ReplyLike, grant: VerifiedMemoryGrant): Promise<boolean> => {
    if (!await requireContribute(reply, grant)) return false
    let ownerScopeKind: 'personal' | 'shared' = 'personal'
    if ('version' in grant && grant.version === 'v2') {
      const binding = grant.scopeBindings.find(item => item.installation_id === grant.installationId)
      ownerScopeKind = binding?.owner_scope_kind === 'personal' ? 'personal' : 'shared'
    }
    const effective = phase4ModeForScope(
      deps.codegraphMode ?? 'off',
      deps.sharedScopesMode ?? 'off',
      ownerScopeKind,
    )
    if (effective === 'off') {
      reply.code(503).send(errorBody(new MemoryApiError('feature_disabled', 'codegraph mode is off')))
      return false
    }
    return true
  }

  const sourceKindForGrant = (grant: VerifiedMemoryGrant): 'personal' | 'shared' => {
    if (!('version' in grant) || grant.version !== 'v2') return 'personal'
    const binding = grant.scopeBindings.find(item => item.installation_id === grant.installationId)
    return binding?.owner_scope_kind === 'personal' ? 'personal' : 'shared'
  }

  app.post('/api/v1/memory/code-snapshots', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply)
    if (!grant) return reply
    if (!await requireMutationMode(reply, grant)) return reply
    const parsed = StartCodeSnapshotRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid start body')))
      return reply
    }
    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'idempotency-key header required')))
      return reply
    }
    if (parsed.data.idempotency_key !== idempotencyKey) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'idempotency key mismatch')))
      return reply
    }
    try {
      const result = await ingest.startSnapshot({
        installationId: grant.installationId,
        grant,
        repository: parsed.data.repository,
        selection: parsed.data.selection,
        gitObjectFormat: parsed.data.git_object_format,
        commitSha: parsed.data.commit_sha,
        manifestSha256: parsed.data.manifest_sha256,
        expectedFileCount: parsed.data.expected_file_count,
        expectedByteCount: parsed.data.expected_byte_count,
        idempotencyKey,
        sourceKind: sourceKindForGrant(grant),
      })
      return { snapshot_id: result.snapshotId, repository_id: result.repositoryId, state: result.state }
    } catch (error) {
      fail(reply, error)
      return reply
    }
  })

  app.post('/api/v1/memory/code-snapshots/:snapshotId/manifest', {bodyLimit:1024*1024}, async(request,reply)=>{
    const grant = await authenticate(request,reply)
    if (!grant || !await requireMutationMode(reply,grant)) return reply
    const id = UUIDSchema.safeParse((request.params as {snapshotId?:string}).snapshotId)
    const body = CodeSnapshotManifestSchema.safeParse(request.body)
    if (!id.success || !body.success) return reply.code(400).send(errorBody(new MemoryApiError('invalid_request','invalid manifest batch')))
    try { return await ingest.registerManifest({installationId:grant.installationId,grant,snapshotId:id.data,entries:body.data.entries}) }
    catch(error) { fail(reply,error);return reply }
  })

  app.get('/api/v1/memory/codegraph/repositories', async(request,reply)=>{
    const grant = await authenticateReadGrant(request,reply,deps.guard)
    if (!grant) return reply
    const query = z.object({limit:z.coerce.number().int().min(1).max(100).default(50),
      after:UUIDSchema.optional(),repository_id:UUIDSchema.optional()}).strict().safeParse(request.query)
    if (!query.success) return reply.code(400).send(errorBody(new MemoryApiError('invalid_request','invalid repository query')))
    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await requireSourceAuthority(client,{installationId:grant.installationId,grant},'read')
      const result = await client.query(`
        SELECT r.repository_id::text,r.repository_key,r.canonical_remote,
          s.snapshot_id::text,s.commit_sha,s.state,s.file_count,s.byte_count,s.selection,
          g.graph_version_id::text,CASE WHEN g.graph_version_id IS NOT NULL AND gs.selection IS NULL THEN 'partial' ELSE g.coverage END AS coverage,g.parser_version,gs.commit_sha AS graph_commit_sha
        FROM repositories r
        JOIN LATERAL (SELECT * FROM memory_source_snapshots s WHERE s.installation_id=r.installation_id
          AND s.repository_id=r.repository_id ORDER BY s.created_at DESC,s.snapshot_id DESC LIMIT 1) s ON TRUE
        LEFT JOIN memory_code_graph_heads h ON h.installation_id=r.installation_id AND h.repository_id=r.repository_id
        LEFT JOIN memory_code_graph_versions g ON g.installation_id=h.installation_id
          AND g.graph_version_id=h.active_graph_version_id AND g.state='active'
        LEFT JOIN memory_source_snapshots gs ON gs.installation_id=g.installation_id AND gs.snapshot_id=g.snapshot_id
        WHERE r.installation_id=$1 AND ($2::uuid IS NULL OR r.repository_id>$2)
          AND ($4::uuid IS NULL OR r.repository_id=$4)
          AND NOT EXISTS (SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)
        ORDER BY r.repository_id LIMIT $3
      `,[grant.installationId,query.data.after??null,query.data.limit+1,query.data.repository_id??null])
      await assertSourceGrantClock(client,{installationId:grant.installationId,grant})
      await client.query('COMMIT')
      const rows = result.rows.slice(0,query.data.limit)
      return {repositories:rows.map(row=>({...row,file_count:Number(row.file_count),byte_count:Number(row.byte_count)})),
        next_cursor:result.rows.length>query.data.limit?rows.at(-1)?.repository_id:null}
    } catch(error) {await client.query('ROLLBACK');fail(reply,error);return reply}
    finally {client.release()}
  })

  app.put('/api/v1/memory/code-snapshots/:snapshotId/files', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply)
    if (!grant) return reply
    if (!await requireMutationMode(reply, grant)) return reply
    const snapshotId = UUIDSchema.safeParse((request.params as { snapshotId?: string }).snapshotId)
    if (!snapshotId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid snapshot id')))
      return reply
    }
    const parsed = CodeSnapshotBatchSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid batch body')))
      return reply
    }
    try {
      const result = await ingest.uploadBatch({
        installationId: grant.installationId,
        grant,
        snapshotId: snapshotId.data,
        batchIndex: parsed.data.batch_index,
        batchKey: parsed.data.batch_key,
        entries: parsed.data.entries,
      })
      return { accepted: result.accepted }
    } catch (error) {
      fail(reply, error)
      return reply
    }
  })

  app.post('/api/v1/memory/code-snapshots/:snapshotId/finalize', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply)
    if (!grant) return reply
    if (!await requireMutationMode(reply, grant)) return reply
    const snapshotId = UUIDSchema.safeParse((request.params as { snapshotId?: string }).snapshotId)
    if (!snapshotId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid snapshot id')))
      return reply
    }
    const parsed = FinalizeCodeSnapshotRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid finalize body')))
      return reply
    }
    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'idempotency-key header required')))
      return reply
    }
    if (parsed.data.idempotency_key !== idempotencyKey) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'idempotency key mismatch')))
      return reply
    }
    try {
      const result = await ingest.finalizeSnapshot({
        installationId: grant.installationId,
        grant,
        snapshotId: snapshotId.data,
        manifestSha256: parsed.data.manifest_sha256,
        expectedFileCount: parsed.data.expected_file_count,
        expectedByteCount: parsed.data.expected_byte_count,
        idempotencyKey,
        sourceKind: sourceKindForGrant(grant),
      })
      return { snapshot_id: result.snapshotId, state: result.state }
    } catch (error) {
      fail(reply, error)
      return reply
    }
  })

  app.delete('/api/v1/memory/code-snapshots/:snapshotId', async (request, reply) => {
    const grant = await authenticate(request, reply)
    if (!grant) return reply
    if (!await requireContribute(reply, grant)) return reply
    const snapshotId = UUIDSchema.safeParse((request.params as { snapshotId?: string }).snapshotId)
    if (!snapshotId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid snapshot id')))
      return reply
    }
    try {
      await ingest.abortSnapshot({
        installationId: grant.installationId,
        grant,
        snapshotId: snapshotId.data,
        sourceKind: sourceKindForGrant(grant),
      })
      return { aborted: true }
    } catch (error) {
      fail(reply, error)
      return reply
    }
  })

  app.get('/api/v1/memory/repositories/:repositoryId/snapshots', async (request, reply) => {
    const guardAny = deps.guard.guardMcp?.bind(deps.guard) ?? deps.guard.guard.bind(deps.guard)
    let grant: VerifiedMemoryGrant | undefined
    try {
      grant = await guardAny({
        authorization: request.headers.authorization,
        requiredService: 'memory.search',
      })
    } catch {
      grant = undefined
    }
    if (!grant) {
      reply.code(401).send(errorBody(new MemoryApiError('unauthorized', 'grant rejected')))
      return reply
    }
    const repositoryId = UUIDSchema.safeParse((request.params as { repositoryId?: string }).repositoryId)
    if (!repositoryId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid repository id')))
      return reply
    }
    const result = await deps.pool.query(`
      SELECT snapshot_id::text, commit_sha, manifest_hash, state, file_count, byte_count,
             created_at, completed_at
      FROM memory_source_snapshots
      WHERE installation_id = $1 AND repository_id = $2
      ORDER BY created_at DESC
      LIMIT 50
    `, [grant.installationId, repositoryId.data])
    return {
      snapshots: result.rows.map(row => ({
        snapshot_id: row.snapshot_id,
        commit_sha: row.commit_sha,
        manifest_hash: row.manifest_hash,
        state: row.state,
        file_count: Number(row.file_count),
        byte_count: Number(row.byte_count),
        created_at: row.created_at,
        completed_at: row.completed_at,
      })),
    }
  })

  app.get('/api/v1/memory/repositories/:repositoryId/codegraph', async (request, reply) => {
    const grant = await authenticateReadGrant(request, reply, deps.guard)
    if (!grant) return reply
    const repositoryId = UUIDSchema.safeParse((request.params as { repositoryId?: string }).repositoryId)
    const query = CodeGraphQuerySchema.safeParse(request.query)
    if (!repositoryId.success || !query.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid graph query')))
      return reply
    }
    try {
      const result = await reads.getGraph({
        installationId: grant.installationId,
        repositoryId: repositoryId.data,
        limit: query.data.limit,
        cursor: query.data.cursor ?? null,
      })
      if (!result) {
        reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
        return reply
      }
      return result
    } catch (error) {
      const code = error instanceof Error && error.message === 'invalid_cursor'
        ? 'invalid cursor' : 'graph read failed'
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', code)))
      return reply
    }
  })

  app.post('/api/v1/memory/repositories/:repositoryId/impact', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const grant = await authenticateReadGrant(request, reply, deps.guard)
    if (!grant) return reply
    const repositoryId = UUIDSchema.safeParse((request.params as { repositoryId?: string }).repositoryId)
    const parsed = CodeGraphImpactRequestSchema.safeParse(request.body)
    if (!repositoryId.success || !parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid impact request')))
      return reply
    }
    try {
      const result = await reads.analyzeImpact({
        installationId: grant.installationId,
        repositoryId: repositoryId.data,
        entryPaths: parsed.data.entry_paths,
        depth: parsed.data.depth,
        maxNodes: parsed.data.max_nodes,
        maxEdges: parsed.data.max_edges,
      })
      if (!result) {
        deps.phase4Metrics?.codegraphImpact.inc({ result: 'not_found' })
        reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
        return reply
      }
      deps.phase4Metrics?.codegraphImpact.inc({ result: result.coverage })
      return result
    } catch (error) {
      const notFound = error instanceof Error && error.message === 'not_found'
      if (notFound) deps.phase4Metrics?.codegraphImpact.inc({ result: 'not_found' })
      reply.code(notFound ? 404 : 400).send(errorBody(new MemoryApiError(
        notFound ? 'not_found' : 'invalid_request',
        notFound ? 'resource not found' : 'impact failed',
      )))
      return reply
    }
  })
}

async function authenticateReadGrant(
  request: { headers: { authorization?: string } },
  reply: ReplyLike,
  guard: GrantGuard,
): Promise<VerifiedMemoryGrant | undefined> {
  try {
    const guardAny = guard.guardMcp?.bind(guard) ?? guard.guard.bind(guard)
    return await guardAny({ authorization: request.headers.authorization, requiredService: 'memory.search' })
  } catch (error) {
    const mapped = error instanceof MemoryApiError
      ? error : new MemoryApiError('unauthorized', 'grant rejected')
    reply.code(mapped.httpStatus).send(errorBody(mapped))
    return undefined
  }
}
