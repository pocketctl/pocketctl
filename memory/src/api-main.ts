import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { loadMemoryConfig } from './config.js'
import { createMemoryPool } from './db.js'
import { applyMemorySchema } from './schema.js'
import { createCapabilityVerifier } from './relay/capability-verifier.js'
import { createMemoryMetrics } from './metrics.js'
import { createGrantGuard } from './auth/grant-guard.js'
import { createCorsHostPolicy } from './auth/cors-host-policy.js'
import { registerReadRoutes } from './api/read-routes.js'
import { registerGovernanceRoutes } from './api/governance-routes.js'
import { registerManageRoutes } from './api/manage-routes.js'
import { registerContextRoutes } from './api/context-routes.js'
import { registerPolicyRoutes } from './api/policy-routes.js'
import { createTrajectoryRepository } from './context/trajectory-repository.js'
import { createContextRetrieval } from './context/retrieval.js'
import { createContextSettingsRepository } from './context/settings-repository.js'
import { createLoadoutRepository } from './context/loadout-repository.js'
import { createScopeResolver } from './context/scope-resolver.js'
import { createPackRepository } from './context/pack-repository.js'
import { createGenerationRunRepository } from './generation/repository.js'
import { createContextCompiler } from './context/compiler.js'
import { createAdmissionService } from './context/admission-service.js'
import { createFeedbackService } from './context/feedback-service.js'
import { createInvalidationService } from './context/invalidation-service.js'
import { createPolicyRepository } from './policies/repository.js'
import { createPolicyResolver } from './policies/resolver.js'
import { createPolicyService } from './policies/service.js'
import { createSearchService } from './retrieval/search-service.js'
import { registerMcpRoute } from './mcp/server.js'
import { validateTombstoneKeyring } from './claims/tombstones.js'
import { createOpenAICompatibleEmbeddingProvider } from './model/openai-compatible-embedding.js'
import { createRateLimiter } from './api/rate-limiter.js'
import {
  createProviderBudgetStore,
  withEmbeddingProviderBudget,
} from './model/provider-budget.js'

/**
 * memory-api entry point: health/ready/metrics plus the Capability-Grant
 * protected probe, and — when MEMORY_MODE=enabled — the Phase 1 personal
 * recall REST surface. This process runs no background workers and never
 * talks to Relay on behalf of a request.
 *
 * Health semantics (frozen):
 * - /health  — process is alive; no Relay or database probe.
 * - /ready   — config valid, database answers SELECT 1, migrations applied.
 *   A degraded Relay or installation never makes the API unready.
 */
async function main(): Promise<void> {
  const config = loadMemoryConfig()
  const pool = createMemoryPool(config)
  await applyMemorySchema(pool)
  const providerBudgetStore = config.providerBudget ? createProviderBudgetStore(pool) : undefined
  await validateTombstoneKeyring(pool, config.tombstoneHmacKeys)
  const schemaReady = true
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/ready', async (_req, reply) => {
    if (!schemaReady) {
      reply.code(503)
      return { status: 'unavailable' }
    }
    try {
      await pool.query('SELECT 1')
      return { status: 'ready' }
    } catch {
      reply.code(503)
      return { status: 'unavailable' }
    }
  })

  // Bounded Prometheus metrics with the frozen label allowlists.
  const metrics = createMemoryMetrics()
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType)
    return metrics.registry.metrics()
  })

  // Phase 0 probe: Capability Grant protected, no content. Failures answer a
  // uniform 401/403 without explaining which claim missed.
  const verifier = createCapabilityVerifier({
    relayUrl: config.relayUrl,
    issuer: config.relayIssuer,
    lookupInstallation: async installationId => {
      const result = await pool.query<{
        local_status: string
        relay_status: string
        config_version: string
      }>(`
        SELECT local_status, relay_status, config_version::text
        FROM memory_installations WHERE installation_id = $1
      `, [installationId])
      return result.rows[0] ?? null
    },
  })
  app.get('/api/v1/probe', async (req, reply) => {
    if (config.mode !== 'enabled') {
      reply.code(404)
      return { error: 'feature disabled' }
    }
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const grant = await verifier.verify(token, 'memory.search')
    if (!grant) {
      reply.code(403)
      return { error: 'capability grant required' }
    }
    return {
      provider_id: config.providerId,
      installation_id: grant.installationId,
      provider_version: config.providerVersion,
      // Phase 1 schema (ledger, candidates, projections) ships with this
      // build; the probe reports it only once migrations actually applied.
      phase: schemaReady ? 1 : 0,
      state: 'ready',
    }
  })

  // Phase 1 REST surface: registered only in enabled mode; shadow/off keeps
  // the Phase 0 surface exactly as it was.
  if (config.mode === 'enabled') {
    const disclosure = (adapter: { provider: string; baseUrl: string; model: string; pricingConfigured: boolean } | undefined) => adapter
      ? {
          provider: adapter.provider,
          origin: adapter.baseUrl,
          model: adapter.model,
          pricing_configured: adapter.pricingConfigured,
          fingerprint: createHash('sha256')
            .update(`${adapter.provider}\n${adapter.baseUrl}\n${adapter.model}`)
            .digest('hex'),
        }
      : undefined
    const extractionAdapter = disclosure(config.textModel)
    const embeddingAdapter = config.embeddingModel
      ? {
          ...disclosure(config.embeddingModel)!,
          fingerprint: createHash('sha256')
            .update(`${config.embeddingModel.provider}\n${config.embeddingModel.baseUrl}\n${config.embeddingModel.model}\n${config.embeddingModel.dimensions}`)
            .digest('hex'),
        }
      : undefined
    const rawEmbeddingProvider = config.embeddingModel
      ? createOpenAICompatibleEmbeddingProvider({
          baseUrl: config.embeddingModel.baseUrl,
          model: config.embeddingModel.model,
          apiKey: config.embeddingModel.apiKey,
          dimensions: config.embeddingModel.dimensions,
          timeoutMs: config.recallEmbeddingTimeoutMs,
          inputCostMicrosPerMillionTokens: config.embeddingModel.inputCostMicrosPerMillionTokens,
          maxAttempts: config.providerBudget ? 1 : undefined,
        })
      : undefined
    const budgetedEmbeddingProvider = rawEmbeddingProvider && config.providerBudget && providerBudgetStore
      ? withEmbeddingProviderBudget(rawEmbeddingProvider, providerBudgetStore, {
          key: config.providerBudget.key,
          maxRequests: config.providerBudget.embeddingMaxRequests,
          maxTokens: config.providerBudget.embeddingMaxTokens,
        })
      : rawEmbeddingProvider
    const embeddingProvider = budgetedEmbeddingProvider && config.embeddingModel
      ? Object.assign(budgetedEmbeddingProvider, {
          provider: config.embeddingModel.provider,
          model: config.embeddingModel.model,
        })
      : undefined
    const guard = createGrantGuard({
      pool,
      relayUrl: config.relayUrl,
      relayIssuer: config.relayIssuer,
    })
    const policy = createCorsHostPolicy({
      allowedOrigins: config.allowedOrigins,
      allowedHosts: config.allowedHosts,
      isProduction: config.isProduction,
    })
    const rateLimiter = createRateLimiter(120, 60_000)
    registerReadRoutes(app, {
      pool,
      guard,
      policy,
      rateLimiter,
      recallEmbeddingTimeoutMs: config.recallEmbeddingTimeoutMs,
      cursorSigningKey: config.hmacKey,
      ...(embeddingAdapter ? { embeddingConsentFingerprint: embeddingAdapter.fingerprint } : {}),
      phase1Metrics: metrics.phase1,
      sharedScopesEnabled: config.sharedScopesMode === 'enabled',
      ...(embeddingProvider ? { embed: embeddingProvider } : {}),
    })
    registerGovernanceRoutes(app, {
      pool,
      guard,
      sharedScopesEnabled: config.sharedScopesMode === 'enabled',
      cursorSigningKey: config.hmacKey,
    })
    registerManageRoutes(app, {
      pool,
      guard,
      policy,
      rateLimiter,
      textConfigured: config.textModel !== undefined,
      embeddingConfigured: config.embeddingModel !== undefined,
      ...(extractionAdapter ? { extractionAdapter } : {}),
      ...(embeddingAdapter ? { embeddingAdapter } : {}),
      tombstoneHmacKeys: config.tombstoneHmacKeys,
      phase1Metrics: metrics.phase1,
    })
    const policyRepository = createPolicyRepository(pool)
    const policyResolver = createPolicyResolver({ pool, repository: policyRepository })
		const invalidation = createInvalidationService({ pool })
		const policyService = createPolicyService({
			pool, repository: policyRepository, resolver: policyResolver, invalidation,
		})
    const trajectoryRepository = createTrajectoryRepository(pool)
    const contextSettings = createContextSettingsRepository(pool)
    const contextPacks = createPackRepository(pool)
		const contextLoadouts = createLoadoutRepository(pool)
    const contextCompiler = createContextCompiler({
      pool,
      retrieval: createContextRetrieval({
        pool,
        search: createSearchService({
          pool,
          recallEmbeddingTimeoutMs: config.recallEmbeddingTimeoutMs,
          cursorSigningKey: config.hmacKey,
          ...(embeddingProvider ? { embed: embeddingProvider } : {}),
          ...(embeddingAdapter ? { embeddingConsentFingerprint: embeddingAdapter.fingerprint } : {}),
        }),
        trajectory: trajectoryRepository,
      }),
      scope: createScopeResolver(pool),
      loadouts: contextLoadouts,
      settings: contextSettings,
      packs: contextPacks,
      generation: createGenerationRunRepository(pool),
      policyResolver,
    })
    registerContextRoutes(app, {
      pool,
      guard,
      policy,
      rateLimiter,
      compiler: contextCompiler,
      admission: createAdmissionService({ pool, nonceHmacKey: Buffer.from(config.hmacKey) }),
      feedback: createFeedbackService({ pool }),
      packs: contextPacks,
      settings: contextSettings,
		loadouts: contextLoadouts,
      requestKey: { keyId: 'context-v1', hmacKey: Buffer.from(config.hmacKey) },
    })
    registerPolicyRoutes(app, {
      pool,
      guard,
      policy,
      rateLimiter,
      policies: policyService,
      transactionalPolicies: transactionPool => {
        const repository = createPolicyRepository(transactionPool)
        return createPolicyService({
          pool: transactionPool,
          repository,
          resolver: createPolicyResolver({ pool: transactionPool, repository }),
          invalidation: createInvalidationService({ pool: transactionPool }),
        })
      },
      onPolicyActivated: async () => {
        policyResolver.clearCache()
      },
    })
    registerMcpRoute(app, {
      pool,
      guard,
      policy,
      rateLimiter,
      providerVersion: config.providerVersion,
      recallEmbeddingTimeoutMs: config.recallEmbeddingTimeoutMs,
      cursorSigningKey: config.hmacKey,
      sharedScopesEnabled: config.sharedScopesMode === 'enabled',
      ...(embeddingAdapter ? { embeddingConsentFingerprint: embeddingAdapter.fingerprint } : {}),
      ...(embeddingProvider ? { embed: embeddingProvider } : {}),
    })
  }

  const port = config.port
  await app.listen({ port, host: config.apiBind === 'all' ? '0.0.0.0' : '127.0.0.1' })

  const shutdown = async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(error => {
  // Config or startup failures exit non-zero without echoing secrets.
  console.error('memory-api startup failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
