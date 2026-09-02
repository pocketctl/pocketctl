import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { GrantGuard, VerifiedMemoryGrant } from '../auth/grant-guard.js'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { MemoryApiError, errorBody } from './errors.js'
import { registerMemoryCors } from './cors.js'
import {
  EpisodesQuerySchema,
  ClaimsQuerySchema,
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
import type { RouteV2Grant } from '../governance/authorization.js'
import {
  decorateWithScopeMetadata,
  buildFederatedRecallResult,
  collectFederatedSearchPages,
  defaultReadInstallationId,
  FederatedScopeSelectionError,
  encodeFederatedCursor,
  mergeFederatedRrf,
  MAX_FEDERATED_OFFSET,
  resolveFederatedCursor,
  selectFederatedScopes,
} from '../retrieval/federated-search-service.js'

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
  sharedScopesEnabled?: boolean
}

interface ReplyLike {
  code(status: number): { send(body: unknown): void }
  send(body: unknown): void
}

export function registerReadRoutes(app: FastifyInstance, deps: ReadRouteDeps): void {
  registerMemoryCors(app, deps.policy)
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
  const authenticated = new WeakMap<object, { service: string; grant: VerifiedMemoryGrant }>()

  function resourceId(value: string, reply: ReplyLike): string | undefined {
    const parsed = UUIDSchema.safeParse(value)
    if (parsed.success) return parsed.data
    reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid resource id')))
    return undefined
  }

  app.addHook('onRequest', async (request, reply) => {
    const service = readServiceFor(request.method, request.url)
    if (service) {
      const grant = await authenticateRead(request, reply, service)
      if (!grant) return reply
    }
  })

  const guardRoute = async <T>(
    request: { headers: { authorization?: string; origin?: string; host?: string }; body?: unknown },
    reply: ReplyLike,
    service: string,
    handler: (grant: VerifiedMemoryGrant) => Promise<T>,
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

  const guardV2Route = async <T>(
    request: { headers: { authorization?: string }; body?: unknown },
    reply: ReplyLike,
    service: string,
    handler: (grant: RouteV2Grant) => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      const cached = authenticated.get(request as object)
      let grant: RouteV2Grant
      if (cached?.service === service && 'version' in cached.grant && cached.grant.version === 'v2') {
        grant = cached.grant
      } else {
        grant = await deps.guard.guardV2({
          authorization: request.headers.authorization,
          requiredService: service,
        })
        if (deps.rateLimiter && !deps.rateLimiter.check(`${service}:${grant.installationId}`).allowed) {
          reply.code(429).send(errorBody(new MemoryApiError('rate_limited', 'rate limit exceeded')))
          return undefined
        }
      }
      return await handler(grant)
    } catch (error) {
      if (error instanceof MemoryApiError) {
        reply.code(error.httpStatus).send(errorBody(error))
        return undefined
      }
      if (error instanceof FederatedScopeSelectionError) {
        reply.code(error.code === 'shared_scope_not_enabled' ? 404 : 400)
          .send(errorBody(new MemoryApiError('invalid_request', error.message)))
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
  ): Promise<VerifiedMemoryGrant | undefined> {
    try {
      const guardAny = deps.guard.guardMcp?.bind(deps.guard) ?? deps.guard.guard.bind(deps.guard)
      const grant = await guardAny({ authorization: request.headers.authorization, requiredService: service })
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
    const parsed = SearchRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return errorBody(new MemoryApiError('invalid_request', 'invalid search body'))
    }
    if (parsed.data.scope_installation_ids) {
      const result = await guardV2Route(request, reply, 'memory.search', async grant => {
        const scopes = selectFederatedScopes({
          grant,
          requestedInstallationIds: parsed.data.scope_installation_ids,
          sharedScopesEnabled: deps.sharedScopesEnabled === true,
        })
        const cursorContext = {
          scopes,
          query: parsed.data.query,
          repositoryId: parsed.data.repository_id,
          repoSnapshotId: parsed.data.repo_snapshot_id,
          branch: parsed.data.branch,
          claimTypes: parsed.data.claim_types,
        }
        const cursor = resolveFederatedCursor({
          cursor: parsed.data.cursor,
          context: cursorContext,
          key: deps.cursorSigningKey,
          requestedAsOf: parsed.data.as_of ? new Date(parsed.data.as_of) : null,
        })
        const limit = parsed.data.limit ?? 10
        const perScope = await collectFederatedSearchPages({
          scopes,
          targetCount: cursor.offset + limit,
          load: async (scope, innerCursor, pageLimit) => search.search({
            installationId: scope.installationId,
            query: parsed.data.query,
            repositoryId: parsed.data.repository_id ?? null,
            repoSnapshotId: parsed.data.repo_snapshot_id ?? null,
            branch: parsed.data.branch ?? null,
            claimTypes: parsed.data.claim_types ?? null,
            asOf: cursor.asOf,
            limit: pageLimit,
            cursor: innerCursor,
          }),
        })
        const merged = mergeFederatedRrf(perScope.flatMap(({ scope, hits }) =>
          hits.map(hit => ({
            scope,
            hit,
            claimId: hit.claimId,
            repositoryApplicable: parsed.data.repository_id ? hit.repositoryId === parsed.data.repository_id : true,
            authority: hit.authority,
            freshnessAt: hit.freshnessAt,
          }))), cursor.offset + limit)
        const page = merged.slice(cursor.offset, cursor.offset + limit)
        const ids = new Map<string, string[]>()
        for (const entry of page) {
          const list = ids.get(entry.scope.installationId) ?? []
          list.push(entry.hit.claimId)
          ids.set(entry.scope.installationId, list)
        }
        const metadata = await decorateWithScopeMetadata(
          deps.pool, scopes.map(scope => scope.installationId), ids,
        )
        return {
          hits: page.map(entry => ({
            ...entry.hit,
            installationId: entry.scope.installationId,
            score: entry.rank,
            ownerScopeKind: entry.scope.ownerScopeKind,
            ownerScopeId: entry.scope.ownerScopeId,
            conflictGroupId: metadata.get(`${entry.scope.installationId}:${entry.hit.claimId}`)?.conflictGroupId ?? null,
            conflictVariant: metadata.get(`${entry.scope.installationId}:${entry.hit.claimId}`)?.conflictVariant ?? null,
          })),
          nextCursor: cursor.offset + limit <= MAX_FEDERATED_OFFSET && (merged.length > cursor.offset + limit
            || perScope.some(entry => entry.hasMore)
            || perScope.reduce((count, entry) => count + entry.hits.length, 0) > merged.length)
            ? encodeFederatedCursor({
                offset: cursor.offset + limit,
                asOf: cursor.asOf,
                context: cursorContext,
                key: deps.cursorSigningKey,
              })
            : null,
          degradedComponents: [...new Set(perScope.flatMap(entry => entry.degradedComponents))],
          poolSizes: Object.fromEntries(perScope.map(entry => [entry.scope.installationId, entry.hits.length])),
        }
      })
      if (result !== undefined) return result
      return
    }
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const started = Date.now()
      const searched = await search.search({
        installationId: defaultReadInstallationId(grant),
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
    const parsed = RecallRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return errorBody(new MemoryApiError('invalid_request', 'invalid recall body'))
    }
    if (parsed.data.scope_installation_ids) {
      const result = await guardV2Route(request, reply, 'memory.recall', async grant => {
        const scopes = selectFederatedScopes({
          grant,
          requestedInstallationIds: parsed.data.scope_installation_ids,
          sharedScopesEnabled: deps.sharedScopesEnabled === true,
        })
        const perScope = await Promise.all(scopes.map(async scope => ({
          scope,
          result: await recall.recall({
            installationId: scope.installationId,
            query: parsed.data.query,
            repositoryId: parsed.data.repository_id ?? null,
            repoSnapshotId: parsed.data.repo_snapshot_id ?? null,
            branch: parsed.data.branch ?? null,
            claimTypes: parsed.data.claim_types ?? null,
            asOf: parsed.data.as_of ? new Date(parsed.data.as_of) : null,
            maxClaims: parsed.data.max_claims ?? 5,
            maxEvidencePerClaim: parsed.data.max_evidence_per_claim ?? 2,
            maxChars: parsed.data.max_chars ?? 8000,
          }),
        })))
        const merged = mergeFederatedRrf(perScope.flatMap(({ scope, result: recalled }) =>
          recalled.claims.map(claim => ({
            scope,
            hit: claim,
            claimId: claim.claimId,
            repositoryApplicable: true,
            authority: claim.authority,
            freshnessAt: claim.freshnessAt,
          }))), parsed.data.max_claims ?? 5)
        const ids = new Map<string, string[]>()
        for (const entry of merged) {
          const list = ids.get(entry.scope.installationId) ?? []
          list.push(entry.hit.claimId)
          ids.set(entry.scope.installationId, list)
        }
        const metadata = await decorateWithScopeMetadata(
          deps.pool, scopes.map(scope => scope.installationId), ids,
        )
        return buildFederatedRecallResult(
          perScope,
          merged,
          parsed.data.max_chars ?? 8000,
          metadata,
        )
      })
      if (result !== undefined) return result
      return
    }
    const result = await guardRoute(request, reply, 'memory.recall', async grant => {
      return recall.recall({
        installationId: defaultReadInstallationId(grant),
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

  app.get('/api/v1/memory/claims', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const parsed = ClaimsQuerySchema.safeParse(request.query)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid claims query')
      return reads.listActiveClaims(defaultReadInstallationId(grant), {
        limit: parsed.data.limit,
        cursor: parsed.data.cursor ?? null,
      })
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/claims/:claimId', async (request, reply) => {
    const requestedInstallationId = (request.query as { installation_id?: unknown }).installation_id
    if (requestedInstallationId !== undefined) {
      if (typeof requestedInstallationId !== 'string' || !UUIDSchema.safeParse(requestedInstallationId).success) {
        reply.code(400)
        return errorBody(new MemoryApiError('invalid_request', 'invalid installation id'))
      }
      const claimId = resourceId((request.params as { claimId: string }).claimId, reply)
      if (!claimId) return
      const result = await guardV2Route(request, reply, 'memory.search', async grant => {
        const [scope] = selectFederatedScopes({
          grant,
          requestedInstallationIds: [requestedInstallationId],
          sharedScopesEnabled: deps.sharedScopesEnabled === true,
        })
        const parsed = ClaimVersionsQuerySchema.safeParse(request.query)
        if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid claim query')
        const claim = await reads.getClaim(scope.installationId, claimId, {
          versionLimit: parsed.data.version_limit,
          versionCursor: parsed.data.version_cursor ?? null,
        })
        if (!claim) throw new MemoryApiError('not_found', 'claim not found')
        return claim
      })
      if (result !== undefined) return result
      return
    }
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const claimId = resourceId((request.params as { claimId: string }).claimId, reply)
      if (!claimId) return undefined
      const parsed = ClaimVersionsQuerySchema.safeParse(request.query)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid claim query')
      const claim = await reads.getClaim(defaultReadInstallationId(grant), claimId, {
        versionLimit: parsed.data.version_limit,
        versionCursor: parsed.data.version_cursor ?? null,
      })
      if (!claim) throw new MemoryApiError('not_found', 'claim not found')
      return claim
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/evidence/:evidenceId', async (request, reply) => {
    const requestedInstallationId = (request.query as { installation_id?: unknown }).installation_id
    if (requestedInstallationId !== undefined) {
      if (typeof requestedInstallationId !== 'string' || !UUIDSchema.safeParse(requestedInstallationId).success) {
        reply.code(400)
        return errorBody(new MemoryApiError('invalid_request', 'invalid installation id'))
      }
      const evidenceId = resourceId((request.params as { evidenceId: string }).evidenceId, reply)
      if (!evidenceId) return
      const result = await guardV2Route(request, reply, 'memory.search', async grant => {
        const [scope] = selectFederatedScopes({
          grant,
          requestedInstallationIds: [requestedInstallationId],
          sharedScopesEnabled: deps.sharedScopesEnabled === true,
        })
        const row = await reads.getEvidence(scope.installationId, evidenceId)
        if (!row) throw new MemoryApiError('not_found', 'evidence not found')
        return row
      })
      if (result !== undefined) return result
      return
    }
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const evidenceId = resourceId((request.params as { evidenceId: string }).evidenceId, reply)
      if (!evidenceId) return undefined
      const row = await reads.getEvidence(defaultReadInstallationId(grant), evidenceId)
      if (!row) throw new MemoryApiError('not_found', 'evidence not found')
      return row
    })
    if (result !== undefined) return result
  })

  app.get('/api/v1/memory/versions/:versionId/evidence', async (request, reply) => {
    const requestedInstallationId = (request.query as { installation_id?: unknown }).installation_id
    if (requestedInstallationId !== undefined) {
      if (typeof requestedInstallationId !== 'string' || !UUIDSchema.safeParse(requestedInstallationId).success) {
        reply.code(400)
        return errorBody(new MemoryApiError('invalid_request', 'invalid installation id'))
      }
      const versionId = resourceId((request.params as { versionId: string }).versionId, reply)
      if (!versionId) return
      const result = await guardV2Route(request, reply, 'memory.search', async grant => {
        const [scope] = selectFederatedScopes({
          grant,
          requestedInstallationIds: [requestedInstallationId],
          sharedScopesEnabled: deps.sharedScopesEnabled === true,
        })
        return evidence.evidenceForVersion({ installationId: scope.installationId, versionId })
      })
      if (result !== undefined) return { evidence: result }
      return
    }
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const versionId = resourceId((request.params as { versionId: string }).versionId, reply)
      if (!versionId) return undefined
      return evidence.evidenceForVersion({ installationId: defaultReadInstallationId(grant), versionId })
    })
    if (result !== undefined) return { evidence: result }
  })

  app.get('/api/v1/memory/episodes', async (request, reply) => {
    const result = await guardRoute(request, reply, 'memory.search', async grant => {
      const parsed = EpisodesQuerySchema.safeParse(request.query)
      if (!parsed.success) throw new MemoryApiError('invalid_request', 'invalid episodes query')
      return reads.findRelatedEpisodes(defaultReadInstallationId(grant), {
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
      return reads.getRepositoryContext(defaultReadInstallationId(grant), repositoryId)
    })
    if (result !== undefined) return result
  })
}

function readServiceFor(method: string, url: string): 'memory.search' | 'memory.recall' | undefined {
  const path = url.split('?')[0]
  if (method === 'POST' && path === '/api/v1/memory/search') return 'memory.search'
  if (method === 'POST' && path === '/api/v1/memory/recall') return 'memory.recall'
  if (method !== 'GET') return undefined
  if (/^\/api\/v1\/memory\/(claims(?:\/[^/]+)?|evidence\/[^/]+|versions\/[^/]+\/evidence|episodes)$/.test(path)) {
    return 'memory.search'
  }
  if (/^\/api\/v1\/memory\/repositories\/[^/]+\/context$/.test(path)) return 'memory.recall'
  return undefined
}
