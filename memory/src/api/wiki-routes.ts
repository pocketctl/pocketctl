import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { createHmac, timingSafeEqual } from 'node:crypto'

import type { GrantGuard, VerifiedMemoryGrant } from '../auth/grant-guard.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'
import { phase4ModeForScope, type SharedScopesMode } from '../config.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createWikiBuildService } from '../wiki/build-service.js'
import { createWikiManualService, WikiManualError } from '../wiki/manual-service.js'
import { createWikiPublicationService, WikiPublicationError } from '../wiki/publication-service.js'
import { createWikiReadService } from '../wiki/read-service.js'
import { MemoryApiError, errorBody } from './errors.js'
import { UUIDSchema } from './schemas.js'
import type { Phase4Metrics } from '../metrics.js'
import { recordSharedPhase4MutationDenied } from '../audit/phase4-authorization-audit.js'

export const WikiBuildRequestSchema = z.object({
  expected_generation: z.number().int().min(0),
}).strict()

export const WikiPublishRequestSchema = z.object({
  expected_generation: z.number().int().min(1),
  expected_head_revision: z.number().int().min(0),
}).strict()

export const WikiManualEditRequestSchema = z.object({
  markdown: z.string().min(1).max(200_000),
  expected_lock_version: z.number().int().min(0),
  reason_code: z.string().min(1).max(64).optional(),
}).strict()

export const WikiManualLockRequestSchema = z.object({
  expected_lock_version: z.number().int().min(0),
  reason_code: z.string().min(1).max(64).optional(),
}).strict()

const WikiListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict()

export interface WikiRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  wikiMode?: 'off' | 'shadow' | 'enabled'
  sharedScopesMode?: SharedScopesMode
  cursorSigningKey: string
  purgeHmacKey?: string
  phase4Metrics?: Phase4Metrics
}

interface ReplyLike {
  code(status: number): { send(body: unknown): void }
  send(body: unknown): void
}

export function registerWikiRoutes(app: FastifyInstance, deps: WikiRouteDeps): void {
  const reads = createWikiReadService(deps.pool)
  const builds = createWikiBuildService({ pool: deps.pool })
  const publication = createWikiPublicationService(deps.pool, { metrics: deps.phase4Metrics })
  const manual = createWikiManualService(deps.pool, { metrics: deps.phase4Metrics })
  const purge = createPurgeRepository(deps.pool, { hmacKey: deps.purgeHmacKey ?? deps.cursorSigningKey })

  const authenticate = async (
    request: { headers: { authorization?: string } },
    reply: ReplyLike,
    service: 'memory.search' | 'memory.manage',
  ): Promise<VerifiedMemoryGrant | undefined> => {
    try {
      const guardAny = deps.guard.guardMcp?.bind(deps.guard) ?? deps.guard.guard.bind(deps.guard)
      return await guardAny({ authorization: request.headers.authorization, requiredService: service })
    } catch (error) {
      const mapped = error instanceof MemoryApiError
        ? error : new MemoryApiError('unauthorized', 'grant rejected')
      reply.code(mapped.httpStatus).send(errorBody(mapped))
      return undefined
    }
  }

  const targetGrant = async (
    grant: VerifiedMemoryGrant,
    permission: 'contribute' | 'publish',
  ): Promise<ValidatedV2Grant | null> => {
    if ('version' in grant && grant.version === 'v2') {
      const binding = grant.scopeBindings.find(item => item.installation_id === grant.installationId)
      if (!binding?.permissions.includes(permission)) return null
      return grant
    }
    const scope = await deps.pool.query<{
      owner_scope_kind: string
      owner_scope_id: string
      state: string
      authorization_epoch: string
    }>(`
      SELECT owner_scope_kind, owner_scope_id::text, state, authorization_epoch::text
      FROM memory_owner_scopes WHERE installation_id = $1
    `, [grant.installationId])
    const row = scope.rows[0]
    if (!row || row.owner_scope_kind !== 'personal' || row.state !== 'active') return null
    return {
      primaryInstallationId: grant.installationId,
      configVersion: grant.configVersion,
      scopeBindings: [{
        installation_id: grant.installationId,
        owner_scope_kind: 'personal',
        owner_scope_id: row.owner_scope_id,
        membership_id: null,
        membership_revision: '0',
        authorization_epoch: row.authorization_epoch,
        permissions: ['read', 'contribute', 'publish'],
      }],
    }
  }

  const effectiveMode = (grant: VerifiedMemoryGrant): SharedScopesMode => {
    let ownerScopeKind: 'personal' | 'shared' = 'personal'
    if ('version' in grant && grant.version === 'v2') {
      const binding = grant.scopeBindings.find(item => item.installation_id === grant.installationId)
      if (!binding) return 'off'
      ownerScopeKind = binding.owner_scope_kind === 'personal' ? 'personal' : 'shared'
    }
    return phase4ModeForScope(
      deps.wikiMode ?? 'off',
      deps.sharedScopesMode ?? 'off',
      ownerScopeKind,
    )
  }

  const requireMode = (
    reply: ReplyLike,
    grant: VerifiedMemoryGrant,
    required: 'shadow' | 'enabled',
  ): boolean => {
    const mode = effectiveMode(grant)
    if (mode === 'off' || (required === 'enabled' && mode !== 'enabled')) {
      reply.code(503).send(errorBody(new MemoryApiError('feature_disabled', 'wiki mutation disabled')))
      return false
    }
    return true
  }

  const resourceWiki = async (installationId: string, wikiId: string) => {
    const result = await deps.pool.query<{ wiki_id: string; repository_id: string; generation: string }>(`
      SELECT wiki_id::text, repository_id::text, generation::text
      FROM memory_wikis WHERE installation_id = $1 AND wiki_id = $2
    `, [installationId, wikiId])
    return result.rows[0] ?? null
  }

  app.get('/api/v1/memory/repositories/:repositoryId/wiki', async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.search')
    if (!grant) return reply
    const repositoryId = UUIDSchema.safeParse((request.params as { repositoryId?: string }).repositoryId)
    if (!repositoryId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid repository id')))
      return reply
    }
    const result = await reads.getActiveWiki({
      installationId: grant.installationId,
      repositoryId: repositoryId.data,
    })
    if (!result) {
      reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
      return reply
    }
    return result
  })

  // Bootstrap the first Wiki from a repository because no wikiId exists
  // before scheduleBuild creates the repository-scoped Wiki ledger row.
  app.post('/api/v1/memory/repositories/:repositoryId/wiki/builds', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.manage')
    if (!grant) return reply
    if (!requireMode(reply, grant, 'shadow')) return reply
    const repositoryId = UUIDSchema.safeParse((request.params as { repositoryId?: string }).repositoryId)
    const parsed = WikiBuildRequestSchema.safeParse(request.body)
    if (!repositoryId.success || !parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid build request')))
      return reply
    }
    const governed = await targetGrant(grant, 'contribute')
    if (!governed) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'build rejected')))
      return reply
    }
    let scheduled
    try {
      scheduled = await builds.scheduleBuild({
        installationId: grant.installationId,
        repositoryId: repositoryId.data,
        expectedGeneration: parsed.data.expected_generation,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'wiki_generation_conflict') {
        reply.code(409).send(errorBody(new MemoryApiError('revision_conflict', 'build rejected')))
        return reply
      }
      if (error instanceof Error
        && ['wiki_repository_not_found', 'wiki_active_graph_not_found'].includes(error.message)) {
        reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
        return reply
      }
      throw error
    }
    reply.code(202)
    return { wiki_id: scheduled.wikiId, run_id: scheduled.runId, generation: scheduled.generation }
  })

  app.get('/api/v1/memory/wikis/:wikiId/builds', async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.search')
    if (!grant) return reply
    const wikiId = UUIDSchema.safeParse((request.params as { wikiId?: string }).wikiId)
    const query = WikiListQuerySchema.safeParse(request.query)
    if (!wikiId.success || !query.success || !await resourceWiki(grant.installationId, wikiId.data)) {
      reply.code(wikiId.success && query.success ? 404 : 400).send(errorBody(new MemoryApiError(
        wikiId.success && query.success ? 'not_found' : 'invalid_request',
        wikiId.success && query.success ? 'resource not found' : 'invalid build query',
      )))
      return reply
    }
    const limit = query.data.limit ?? 20
    let beforeGeneration: number | null
    try {
      beforeGeneration = decodeBuildCursor(
        query.data.cursor ?? null,
        grant.installationId,
        wikiId.data,
        deps.cursorSigningKey,
      )
    } catch {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid build cursor')))
      return reply
    }
    const result = await deps.pool.query(`
      SELECT run_id::text, generation::text, source_snapshot_id::text,
             graph_version_id::text, state, input_digest, prompt_version,
             model_version, policy_version, parser_version, error_code,
             created_at, started_at, completed_at
      FROM memory_wiki_build_runs
      WHERE installation_id = $1 AND wiki_id = $2
        AND ($3::bigint IS NULL OR generation < $3)
      ORDER BY generation DESC LIMIT $4
    `, [grant.installationId, wikiId.data, beforeGeneration, limit + 1])
    const hasMore = result.rows.length > limit
    const page = hasMore ? result.rows.slice(0, limit) : result.rows
    return {
      builds: page,
      next_cursor: hasMore
        ? encodeBuildCursor(
            grant.installationId,
            wikiId.data,
            Number(page.at(-1)!.generation),
            deps.cursorSigningKey,
          )
        : null,
    }
  })

  app.post('/api/v1/memory/wikis/:wikiId/builds', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.manage')
    if (!grant) return reply
    if (!requireMode(reply, grant, 'shadow')) return reply
    const wikiId = UUIDSchema.safeParse((request.params as { wikiId?: string }).wikiId)
    const parsed = WikiBuildRequestSchema.safeParse(request.body)
    if (!wikiId.success || !parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid build request')))
      return reply
    }
    const wiki = await resourceWiki(grant.installationId, wikiId.data)
    if (!wiki) {
      reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
      return reply
    }
    const governed = await targetGrant(grant, 'contribute')
    if (Number(wiki.generation) !== parsed.data.expected_generation || !governed) {
      reply.code(Number(wiki.generation) !== parsed.data.expected_generation ? 409 : 403)
        .send(errorBody(new MemoryApiError(
          Number(wiki.generation) !== parsed.data.expected_generation ? 'revision_conflict' : 'forbidden',
          'build rejected',
        )))
      return reply
    }
    let scheduled
    try {
      scheduled = await builds.scheduleBuild({
        installationId: grant.installationId,
        repositoryId: wiki.repository_id,
        expectedGeneration: parsed.data.expected_generation,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'wiki_generation_conflict') {
        reply.code(409).send(errorBody(new MemoryApiError('revision_conflict', 'build rejected')))
        return reply
      }
      throw error
    }
    reply.code(202)
    return { run_id: scheduled.runId, generation: scheduled.generation }
  })

  app.get('/api/v1/memory/wikis/:wikiId/candidates/:buildId', async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.search')
    if (!grant) return reply
    const params = request.params as { wikiId?: string; buildId?: string }
    const wikiId = UUIDSchema.safeParse(params.wikiId)
    const buildId = UUIDSchema.safeParse(params.buildId)
    if (!wikiId.success || !buildId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid candidate id')))
      return reply
    }
    const governed = await targetGrant(grant, 'contribute') ?? await targetGrant(grant, 'publish')
    if (!governed) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'candidate access rejected')))
      return reply
    }
    const candidate = await deps.pool.query(`
      SELECT c.document, c.content_hash, c.validated_at,
             r.generation::text, r.source_snapshot_id::text,
             r.graph_version_id::text, r.state, s.commit_sha
      FROM memory_wiki_build_candidates c
      JOIN memory_wiki_build_runs r
        ON r.installation_id = c.installation_id AND r.run_id = c.run_id
      JOIN memory_source_snapshots s
        ON s.installation_id = r.installation_id AND s.snapshot_id = r.source_snapshot_id
      WHERE c.installation_id = $1 AND c.wiki_id = $2 AND c.run_id = $3
    `, [grant.installationId, wikiId.data, buildId.data])
    if (!candidate.rows[0]) {
      reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
      return reply
    }
    return candidate.rows[0]
  })

  app.post('/api/v1/memory/wikis/:wikiId/candidates/:buildId/publish', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.manage')
    if (!grant) return reply
    if (!requireMode(reply, grant, 'enabled')) return reply
    const params = request.params as { wikiId?: string; buildId?: string }
    const wikiId = UUIDSchema.safeParse(params.wikiId)
    const buildId = UUIDSchema.safeParse(params.buildId)
    const parsed = WikiPublishRequestSchema.safeParse(request.body)
    const governed = await targetGrant(grant, 'publish')
    if (!wikiId.success || !buildId.success || !parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid publish request')))
      return reply
    }
    if (!governed) {
      await recordSharedPhase4MutationDenied(deps.pool, grant, 'publish')
      deps.phase4Metrics?.wikiPublications.inc({ result: 'unauthorized' })
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'publish rejected')))
      return reply
    }
    try {
      return await publication.publish({
        grant: governed, targetInstallationId: grant.installationId,
        wikiId: wikiId.data, runId: buildId.data,
        expectedGeneration: parsed.data.expected_generation,
        expectedHeadRevision: parsed.data.expected_head_revision,
      })
    } catch (error) {
      sendWikiMutationError(reply, error)
      return reply
    }
  })

  app.put('/api/v1/memory/wikis/:wikiId/manual-sections/:sectionKey', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.manage')
    if (!grant) return reply
    if (!requireMode(reply, grant, 'enabled')) return reply
    const params = request.params as { wikiId?: string; sectionKey?: string }
    const wikiId = UUIDSchema.safeParse(params.wikiId)
    const parsed = WikiManualEditRequestSchema.safeParse(request.body)
    const governed = await targetGrant(grant, 'contribute')
    if (!wikiId.success || !parsed.success || typeof params.sectionKey !== 'string') {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid manual edit')))
      return reply
    }
    if (!governed) {
      await recordSharedPhase4MutationDenied(deps.pool, grant, 'manual_edit')
      deps.phase4Metrics?.wikiManualActions.inc({ action: 'edit', result: 'unauthorized' })
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'manual edit rejected')))
      return reply
    }
    try {
      return await manual.edit({
        grant: governed, targetInstallationId: grant.installationId,
        wikiId: wikiId.data, sectionKey: params.sectionKey,
        markdown: parsed.data.markdown,
        expectedLockVersion: parsed.data.expected_lock_version,
        reasonCode: parsed.data.reason_code,
      })
    } catch (error) {
      sendWikiMutationError(reply, error)
      return reply
    }
  })

  for (const action of ['lock', 'unlock'] as const) {
    app.post(`/api/v1/memory/wikis/:wikiId/manual-sections/:sectionKey/${action}`, { bodyLimit: 4 * 1024 }, async (request, reply) => {
      const grant = await authenticate(request, reply, 'memory.manage')
      if (!grant) return reply
      if (!requireMode(reply, grant, 'enabled')) return reply
      const params = request.params as { wikiId?: string; sectionKey?: string }
      const wikiId = UUIDSchema.safeParse(params.wikiId)
      const parsed = WikiManualLockRequestSchema.safeParse(request.body)
      const governed = await targetGrant(grant, 'contribute')
      if (!wikiId.success || !parsed.success || typeof params.sectionKey !== 'string') {
        reply.code(400).send(errorBody(new MemoryApiError('invalid_request', `invalid ${action} request`)))
        return reply
      }
      if (!governed) {
        if (action === 'unlock') {
          await recordSharedPhase4MutationDenied(deps.pool, grant, 'unlock')
        }
        deps.phase4Metrics?.wikiManualActions.inc({ action, result: 'unauthorized' })
        reply.code(403).send(errorBody(new MemoryApiError('forbidden', `${action} rejected`)))
        return reply
      }
      try {
        return await manual[action]({
          grant: governed, targetInstallationId: grant.installationId,
          wikiId: wikiId.data, sectionKey: params.sectionKey,
          expectedLockVersion: parsed.data.expected_lock_version,
          reasonCode: parsed.data.reason_code,
        })
      } catch (error) {
        sendWikiMutationError(reply, error)
        return reply
      }
    })
  }

  app.delete('/api/v1/memory/repositories/:repositoryId/memory', async (request, reply) => {
    const grant = await authenticate(request, reply, 'memory.manage')
    if (!grant) return reply
    const repositoryId = UUIDSchema.safeParse((request.params as { repositoryId?: string }).repositoryId)
    const governed = await targetGrant(grant, 'publish')
    if (!repositoryId.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid repository id')))
      return reply
    }
    if (!governed) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'purge rejected')))
      return reply
    }
    const snapshotCount = await deps.pool.query<{ count: string; owner_scope_kind: string | null }>(`
      SELECT COUNT(s.snapshot_id)::text AS count,
             MAX(os.owner_scope_kind::text) AS owner_scope_kind
      FROM repositories r
      LEFT JOIN memory_source_snapshots s
        ON s.installation_id = r.installation_id AND s.repository_id = r.repository_id
      LEFT JOIN memory_owner_scopes os ON os.installation_id = r.installation_id
      WHERE r.installation_id = $1 AND r.repository_id = $2
    `, [grant.installationId, repositoryId.data])
    const result = await purge.purgeRepository({
      installationId: grant.installationId,
      repositoryId: repositoryId.data,
      reasonCode: 'explicit_repository_delete',
    })
    if (result.purged) {
      deps.phase4Metrics?.codeSnapshots.inc({
        result: 'purged',
        source_kind: snapshotCount.rows[0]?.owner_scope_kind === 'personal'
          || !snapshotCount.rows[0]?.owner_scope_kind ? 'personal' : 'shared',
      }, Number(snapshotCount.rows[0]?.count ?? 0))
    }
    return result
  })
}

function encodeBuildCursor(
  installationId: string,
  wikiId: string,
  beforeGeneration: number,
  key: string,
): string {
  const payload = Buffer.from(JSON.stringify({ i: installationId, w: wikiId, g: beforeGeneration }), 'utf8')
    .toString('base64url')
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}

function decodeBuildCursor(
  cursor: string | null,
  installationId: string,
  wikiId: string,
  key: string,
): number | null {
  if (!cursor) return null
  const [payload, signature, extra] = cursor.split('.')
  if (!payload || !signature || extra) throw new Error('invalid_cursor')
  const expected = createHmac('sha256', key).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid_cursor')
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    i?: unknown
    w?: unknown
    g?: unknown
  }
  if (parsed.i !== installationId || parsed.w !== wikiId
    || !Number.isSafeInteger(parsed.g) || Number(parsed.g) < 1) {
    throw new Error('invalid_cursor')
  }
  return Number(parsed.g)
}

function sendWikiMutationError(reply: ReplyLike, error: unknown): void {
  const code = error instanceof WikiPublicationError || error instanceof WikiManualError
    ? error.code : 'invalid_input'
  const status = code === 'forbidden' ? 403
    : code === 'not_found' ? 404
      : code === 'revision_conflict' || code === 'stale_generation'
        || code === 'state_conflict' || code === 'locked' || code === 'section_key_collision'
        ? 409 : 400
  const apiCode = status === 403 ? 'forbidden'
    : status === 404 ? 'not_found'
      : status === 409 ? 'revision_conflict' : 'invalid_request'
  reply.code(status).send(errorBody(new MemoryApiError(apiCode, `wiki mutation ${code}`)))
}
