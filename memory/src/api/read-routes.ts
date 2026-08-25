import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { GrantGuard } from '../auth/grant-guard.js'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { MemoryApiError, errorBody } from './errors.js'
import {
  EpisodesQuerySchema,
  ClaimVersionsQuerySchema,
  RecallRequestSchema,
  SearchRequestSchema,
  UUIDSchema,
} from './schemas.js'
import { createSearchService } from '../retrieval/search-service.js'
import { createRecallService } from '../retrieval/recall-service.js'
import { createEvidenceService } from '../claims/evidence-service.js'
import { createMemoryReadService } from '../retrieval/read-service.js'
import type { Phase1Metrics } from '../metrics.js'

/**
 * Read routes (plan §7.1). Authorization is the grant guard; every data
 * query carries installation_id inside its SQL; CORS/Host checks fail
 * closed; responses are bounded and never expose raw payloads.
 */

export interface ReadRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  policy: CorsHostPolicy
  rateLimiter?: { check(key: string): { allowed: boolean } }
  embed?: { provider: string; model: string; dimensions: number; embed(input: { operation: 'claim_index' | 'recall_query'; texts: string[]; signal: AbortSignal }): Promise<{ vectors: number[][]; model: string; tokens: number }> }
  recallEmbeddingTimeoutMs: number
  cursorSigningKey: string
  embeddingConsentFingerprint?: string
  phase1Metrics?: Phase1Metrics
}

interface ReplyLike {
  code(status: number): { send(body: unknown): void }
  send(body: unknown): void
}

export function registerReadRoutes(app: FastifyInstance, deps: ReadRouteDeps): void {
  const search = createSearchService({
    pool: deps.pool,
    ...(deps.embed ? { embed: deps.embed } : {}),
    recallEmbeddingTimeoutMs: deps.recallEmbeddingTimeoutMs,
    cursorSigningKey: deps.cursorSigningKey,
    ...(deps.embeddingConsentFingerprint
      ? { embeddingConsentFingerprint: deps.embeddingConsentFingerprint }
      : {}),
  })
  const recall = createRecallService(deps.pool, search)
  const evidence = createEvidenceService(deps.pool)
  const reads = createMemoryReadService(deps.pool, deps.cursorSigningKey)
  const authenticated = new WeakMap<object, { service: string; grant: { installationId: string } }>()

  function resourceId(value: string, reply: ReplyLike): string | undefined {
    const parsed = UUIDSchema.safeParse(value)
    if (parsed.success) return parsed.data
    reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid resource id')))
    return undefined
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!deps.policy.hostAllowed(request.headers.host)) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'host rejected')))
      return reply
    }
    if (!deps.policy.originAllowed(request.headers.origin)) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'origin rejected')))
      return reply
    }
    if (request.headers.origin) {
      reply.header('access-control-allow-origin', request.headers.origin)
      reply.header('vary', 'origin')
    }
    const service = readServiceFor(request.method, request.url)
    if (service) {
      const grant = await authenticateRead(request, reply, service)
      if (!grant) return reply
    }
  })

  app.options('/api/v1/memory/*', async (request, reply) => {
    if (request.headers.origin && deps.policy.originAllowed(request.headers.origin)) {
      reply.header('access-control-allow-origin', request.headers.origin)
      reply.header('vary', 'origin')
    }
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    reply.header('access-control-allow-headers', 'authorization, content-type, idempotency-key')
    reply.header('access-control-max-age', '600')
    return ''
  })

  const guardRoute = async <T>(
    request: { headers: { authorization?: string; origin?: string; host?: string }; body?: unknown },
    reply: ReplyLike,
    service: string,
    handler: (grant: { installationId: string }) => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      const cached = authenticated.get(request as object)
      const grant = cached?.service === service
        ? cached.grant
        : await authenticateRead(request, reply, service)
      return grant ? await handler(grant) : undefined
    } catch (error) {
      if (error instanceof MemoryApiError) {
        reply.code(error.httpStatus).send(errorBody(error))
        return undefined
      }
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'request failed')))
      return undefined
    }
  }

  async function authenticateRead(
    request: { headers: { authorization?: string } },
    reply: ReplyLike,
    service: string,
  ): Promise<{ installationId: string } | undefined> {
    try {
      const grant = await deps.guard.guard({
        authorization: request.headers.authorization,
        requiredService: service,
      })
      if (deps.rateLimiter && !deps.rateLimiter.check(`${service}:${grant.installationId}`).allowed) {
        reply.code(429).send(errorBody(new MemoryApiError('rate_limited', 'rate limit exceeded')))
        return undefined
      }
      authenticated.set(request as object, { service, grant })
      return grant
    } catch (error) {
      if (error instanceof MemoryApiError) {
        reply.code(error.httpStatus).send(errorBody(error))
        return undefined
      }
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'request failed')))
      return undefined
    }
  }

  app.post('/api/v1/memory/search', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const parsed = SearchRequestSchema.safeParse(request.body)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid search body')
      const started = Date.now()
      const searched = await search.search({
        installationId: grant.installationId,
        query: parsed.data.query,
        repositoryId: parsed.data.repository_id ?? null,
        repoSnapshotId: parsed.data.repo_snapshot_id ?? null,
        branch: parsed.data.branch ?? null,
        claimTypes: parsed.data.claim_types ?? null,
        asOf: parsed.data.as_of ? new Date(parsed.data.as_of) : null,
        limit: parsed.data.limit ?? 10,
        cursor: parsed.data.cursor ?? null,
      })
      const degraded = searched.degradedComponents.includes('embedding') ? 'embedding' : 'none'
      deps.phase1Metrics?.searchLatency.observe({ degraded }, (Date.now() - started) / 1000)
      deps.phase1Metrics?.searchResults.observe({ degraded }, searched.hits.length)
      return searched
    })
    if (result !== undefined) return result
  })

  app.post('/api/v1/memory/recall', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.recall', async grant => {
      const parsed = RecallRequestSchema.safeParse(request.body)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid recall body')
      return recall.recall({
        installationId: grant.installationId,
        query: parsed.data.query,
        repositoryId: parsed.data.repository_id ?? null,
        repoSnapshotId: parsed.data.repo_snapshot_id ?? null,
        branch: parsed.data.branch ?? null,
        claimTypes: parsed.data.claim_types ?? null,
        asOf: parsed.data.as_of ? new Date(parsed.data.as_of) : null,
        maxClaims: parsed.data.max_claims ?? 5,
        maxEvidencePerClaim: parsed.data.max_evidence_per_claim ?? 2,
        maxChars: parsed.data.max_chars ?? 8000,
      })
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/claims/:claimId', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const claimId = resourceId((request.params as { claimId: string }).claimId, reply)
      if (!claimId) return undefined
      const parsed = ClaimVersionsQuerySchema.safeParse(request.query)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid claim query')
      const claim = await reads.getClaim(grant.installationId, claimId, {
        versionLimit: parsed.data.version_limit,
        versionCursor: parsed.data.version_cursor ?? null,
      })
      if (!claim) throw new MemoryApiError('not_found', 'claim not found')
      return claim
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/evidence/:evidenceId', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const evidenceId = resourceId((request.params as { evidenceId: string }).evidenceId, reply)
      if (!evidenceId) return undefined
      const row = await reads.getEvidence(grant.installationId, evidenceId)
      if (!row) throw new MemoryApiError('not_found', 'evidence not found')
      return row
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/versions/:versionId/evidence', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const versionId = resourceId((request.params as { versionId: string }).versionId, reply)
      if (!versionId) return undefined
      return evidence.evidenceForVersion({ installationId: guard0(grant), versionId })
    })
    if (result !== undefined) return { evidence: result }
  })

  app.get('/api/v1/memory/episodes', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const parsed = EpisodesQuerySchema.safeParse(request.query)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid episodes query')
      return reads.findRelatedEpisodes(grant.installationId, {
        sessionId: parsed.data.session_id ?? null,
        limit: parsed.data.limit,
      })
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/repositories/:repositoryId/context', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.recall', async grant => {
      const repositoryId = resourceId((request.params as { repositoryId: string }).repositoryId, reply)
      if (!repositoryId) return undefined
      return reads.getRepositoryContext(grant.installationId, repositoryId)
    })
    if (result !== undefined) return result
  })
}

function readServiceFor(method: string, url: string): 'memory.search' | 'memory.recall' | undefined {
  const path = url.split('?')[0]
  if (method === 'POST' && path === '/api/v1/memory/search') return 'memory.search'
  if (method === 'POST' && path === '/api/v1/memory/recall') return 'memory.recall'
  if (method !== 'GET') return undefined
  if (/^\/api\/v1\/memory\/(claims\/[^/]+|evidence\/[^/]+|versions\/[^/]+\/evidence|episodes)$/.test(path)) {
    return 'memory.search'
  }
  if (/^\/api\/v1\/memory\/repositories\/[^/]+\/context$/.test(path)) return 'memory.recall'
  return undefined
}

function guard0(grant: { installationId: string }): string {
  return grant.installationId
}
