import { createServer } from 'http'
import { createHash } from 'node:crypto'
import { loadMemoryConfig } from './config.js'
import { createMemoryPool } from './db.js'
import { applyMemorySchema } from './schema.js'
import { createShutdownSignal } from './shutdown.js'
import { createRelayHttpClient, type RelayHttpClient } from './relay/http-client.js'
import { RelayRequestError } from './relay/errors.js'
import { createProviderTokenClient } from './relay/token-client.js'
import { createInstallationsClient } from './relay/installations.js'
import { createFeedClient } from './relay/feed-client.js'
import { createSnapshotClient } from './relay/snapshot-client.js'
import { createSnapshotReconciler } from './snapshot/reconcile-worker.js'
import { createPurgeClient } from './relay/purge-client.js'
import { createReportingClient } from './relay/reporting-client.js'
import { createStatusWorker } from './reporting/status-worker.js'
import { createUsageWorker } from './reporting/usage-worker.js'
import { createPurgeRepository } from './purge/repository.js'
import { createPurgeWorker } from './purge/worker.js'
import { createFeedConsumer } from './inbox/feed-worker.js'
import { createProjectionHandler } from './projection/repository.js'
import { createEpisodeRepository } from './episodes/repository.js'
import { createCodeGraphBuildService } from './codegraph/build-service.js'
import { createWikiBuildService } from './wiki/build-service.js'
import { createWikiGenerator } from './wiki/generator.js'
import { createExtractionRepository } from './extraction/repository.js'
import { createCandidateExtractor } from './extraction/extractor.js'
import { createCandidateDeduper } from './extraction/deduper.js'
import { validateTombstoneKeyring } from './claims/tombstones.js'
import { createOpenAICompatibleTextGenerator } from './model/openai-compatible-text.js'
import { createClaimRepository } from './claims/repository.js'
import { createLifecycleService } from './claims/lifecycle-service.js'
import { createClaimIndexer } from './retrieval/indexer.js'
import { createOpenAICompatibleEmbeddingProvider } from './model/openai-compatible-embedding.js'
import {
  createProviderBudgetStore,
  withEmbeddingProviderBudget,
  withTextProviderBudget,
} from './model/provider-budget.js'
import { createInstallationRegistry } from './installations/repository.js'
import { createDiscoveryWorker } from './installations/discovery-worker.js'
import { createJobRepository } from './jobs/repository.js'
import { createJobWorker } from './jobs/worker.js'
import { createInvalidationService } from './context/invalidation-service.js'
import { createPolicyRepository } from './policies/repository.js'
import { createPolicyResolver } from './policies/resolver.js'
import type { ExtractionPolicyDocument } from './policies/schemas.js'
import {
  createMemoryMetrics,
  updateFeedLagGauge,
  updatePhase4Gauges,
  type MemoryMetrics,
} from './metrics.js'
import { createMemoryLogger } from './logging.js'
import type pg from 'pg'

const GAUGE_INTERVAL_MS = 30_000
const JOB_RETENTION_INTERVAL_MS = 60 * 60_000
const LOCAL_INSTALLATION_STATES = [
  'discovering', 'syncing', 'ready', 'degraded', 'purging', 'purged', 'integrity_error',
] as const
const INBOX_STATES = ['pending', 'projected', 'quarantined', 'purged'] as const
const JOB_TYPES = [
  'project_feed', 'compile_episode', 'snapshot_reconcile', 'session_purge',
  'installation_purge', 'report_status', 'report_usage',
  'extract_candidates', 'index_claim_version', 'rebuild_claim_index', 'expire_claims',
	'index_shared_claim',
	'recompile_extraction_policy', 'compile_context_shadow',
	'record_context_delivery', 'invalidate_context_packs',
	'parse_code_snapshot', 'build_wiki',
] as const
const JOB_STATES = ['pending', 'running', 'completed', 'dead'] as const

/** Bounded error code for logs: Relay codes pass through, others degrade. */
function loopErrorCode(error: unknown): string {
  if (error instanceof RelayRequestError) return error.code
  const name = error instanceof Error ? error.name : 'unknown'
  return `handler_failed_${name}`.slice(0, 64)
}

/** Update the DB-backed gauges; absent label values reset to zero. */
async function updateGauges(pool: pg.Pool, metrics: MemoryMetrics): Promise<void> {
  const installations = await pool.query<{ local_status: string; count: string }>(`
    SELECT local_status, COUNT(*)::text AS count FROM memory_installations GROUP BY local_status
  `)
  const installationCounts = new Map(installations.rows.map(row => [row.local_status, Number(row.count)]))
  for (const state of LOCAL_INSTALLATION_STATES) {
    metrics.installations.set({ state }, installationCounts.get(state) ?? 0)
  }

  const inbox = await pool.query<{ projection_state: string; count: string }>(`
    SELECT projection_state, COUNT(*)::text AS count FROM memory_feed_inbox GROUP BY projection_state
  `)
  const inboxCounts = new Map(inbox.rows.map(row => [row.projection_state, Number(row.count)]))
  for (const state of INBOX_STATES) {
    metrics.inboxRows.set({ state }, inboxCounts.get(state) ?? 0)
  }

  const jobs = await pool.query<{ job_type: string; state: string; count: string }>(`
    SELECT job_type, state, COUNT(*)::text AS count FROM memory_jobs GROUP BY job_type, state
  `)
  const jobCounts = new Map(jobs.rows.map(row => [`${row.job_type}:${row.state}`, Number(row.count)]))
  for (const type of JOB_TYPES) {
    for (const state of JOB_STATES) {
      metrics.jobs.set({ type, state }, jobCounts.get(`${type}:${state}`) ?? 0)
    }
  }

  const outbox = await pool.query<{ pending: string; reported: string; dead_letter: string }>(`
    SELECT COUNT(*) FILTER (WHERE reported_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
           COUNT(*) FILTER (WHERE reported_at IS NOT NULL)::text AS reported,
           COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_letter
    FROM memory_usage_outbox
  `)
  metrics.usageOutboxRows.set({ state: 'pending' }, Number(outbox.rows[0]?.pending ?? 0))
  metrics.usageOutboxRows.set({ state: 'reported' }, Number(outbox.rows[0]?.reported ?? 0))
  metrics.usageOutboxRows.set({ state: 'dead_letter' }, Number(outbox.rows[0]?.dead_letter ?? 0))

  await updateFeedLagGauge(pool, metrics.feedLag)
  await updatePhase4Gauges(pool, metrics.phase4)
}

/**
 * memory-worker entry point. This process runs the background loops
 * (discovery, purge, feed, snapshot, projection, episodes, reporting),
 * observes them through the bounded metrics registry and redacting logger,
 * and listens on no public port besides the optional /metrics listener.
 */
async function main(): Promise<void> {
  const config = loadMemoryConfig()
  const pool = createMemoryPool(config)
  await applyMemorySchema(pool)
  const providerBudgetStore = config.providerBudget || config.wikiProviderBudget
    ? createProviderBudgetStore(pool)
    : undefined
  await validateTombstoneKeyring(pool, config.tombstoneHmacKeys)
  const { signal, wait } = createShutdownSignal()
  const logger = createMemoryLogger(config.logLevel)
  const metrics = createMemoryMetrics()
  const loopError = (loop: string) => (error: unknown) => {
    logger.log('error', 'loop_failed', {
      loop,
      code: loopErrorCode(error),
    })
  }

  // Prometheus surface for the worker process. Loopback by default so the
  // container orchestrator opts into exposure explicitly.
  const metricsServer = createServer((request, response) => {
    if (request.url === '/metrics') {
      void metrics.registry.metrics().then(body => {
        response.writeHead(200, { 'content-type': metrics.registry.contentType })
        response.end(body)
      }, () => {
        response.writeHead(500)
        response.end()
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(resolve => {
    metricsServer.once('listening', resolve)
    metricsServer.listen(config.metricsPort, config.metricsBind === 'all' ? '0.0.0.0' : '127.0.0.1')
  })
  const gaugeTimer = setInterval(() => {
    void updateGauges(pool, metrics).catch(loopError('metrics_gauges'))
  }, GAUGE_INTERVAL_MS)
  gaugeTimer.unref?.()
  void updateGauges(pool, metrics).catch(loopError('metrics_gauges'))

  // Retention sweep for finished jobs: reconcile-driven keys (drain/revive
  // timestamps, per-batch ids) would otherwise accumulate forever. Dead
  // jobs go after a longer window — memory_dead_letters keeps the audit
  // row (no FK) — which also eventually frees stable keys like
  // snapshot:{installation} after an unrecoverable attempt ladder.
  const retentionTimer = setInterval(() => {
    void pool.query(`
      DELETE FROM memory_jobs
      WHERE (state = 'completed' AND completed_at < NOW() - INTERVAL '24 hours')
         OR (state = 'dead' AND completed_at < NOW() - INTERVAL '7 days')
    `).then(() => pool.query(`
      DELETE FROM memory_extraction_runs
      WHERE state IN ('failed', 'quarantined')
        AND completed_at < NOW() - INTERVAL '7 days'
    `)).then(() => pool.query(`
      UPDATE memory_feedback SET details = '{}'::jsonb, reason_code = NULL
      WHERE created_at < NOW() - INTERVAL '30 days'
        AND (details <> '{}'::jsonb OR reason_code IS NOT NULL)
    `)).then(() => pool.query(`
      DELETE FROM memory_idempotency_keys WHERE expires_at <= NOW()
    `)).catch(loopError('job_retention'))
  }, JOB_RETENTION_INTERVAL_MS)
  retentionTimer.unref?.()

  let discovery: ReturnType<typeof createDiscoveryWorker> | undefined
  let jobWorker: ReturnType<typeof createJobWorker> | undefined
  let purgeWorker: ReturnType<typeof createPurgeWorker> | undefined
  let statusWorker: ReturnType<typeof createStatusWorker> | undefined
  let usageWorker: ReturnType<typeof createUsageWorker> | undefined
  let feedTimer: ReturnType<typeof setInterval> | undefined
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  const feedInFlight = new Set<Promise<void>>()
  if (config.mode !== 'off') {
    const http: RelayHttpClient = createRelayHttpClient({
      baseUrl: config.relayUrl,
      timeoutMs: config.httpTimeoutMs,
      observe: ({ operation, result, code, durationMs }) => {
        metrics.relayRequests.inc({ operation, result })
        metrics.relayDuration.observe({ operation }, durationMs / 1000)
        if (operation === 'pull_feed') metrics.feedPulls.inc({ result })
        if (operation === 'ack_feed') metrics.feedAcks.inc({ result })
        if (result === 'error' && code === 'rate_limited') {
          logger.log('warn', 'relay_rate_limited', { operation })
        }
      },
    })
    const tokens = createProviderTokenClient({
      relayUrl: config.relayUrl,
      clientId: config.providerClientId,
      clientSecret: config.providerClientSecret,
      http,
    })
    const feedClient = createFeedClient({ http, tokens })
    const snapshotClient = createSnapshotClient({ http, tokens })
    const snapshotReconciler = createSnapshotReconciler({
      pool,
      relay: {
        listSessions: (installationId, cursor) => snapshotClient.listSessions(installationId, cursor),
        getSnapshot: (installationId, sessionId, cursor) =>
          snapshotClient.getSnapshot(installationId, sessionId, cursor),
        acknowledgeReconcile: installationId => snapshotClient.acknowledgeReconcile(installationId),
      },
      onSnapshotResult: result => {
        metrics.snapshot.inc({ result })
      },
    })
    discovery = createDiscoveryWorker({
      installations: createInstallationsClient({ http, tokens }),
      registry: createInstallationRegistry(pool),
      signal,
      intervalMs: 30_000,
      installationAllowlist: new Set(config.installationAllowlist),
      onError: loopError('discovery'),
    })
    discovery.start()

    const feedConsumer = createFeedConsumer({
      pool,
      pullFeed: (installationId, limit) => feedClient.pullFeed(installationId, limit),
      ackFeed: input => feedClient.ackFeed(input),
      workerId: config.workerId,
      signal,
      pollLeaseMs: 10_000,
      onError: loopError('feed_installation'),
      ...(config.sharedScopesMode !== 'off' ? {
        pullScopeControlFeed: (installationId: string, limit: number) =>
          feedClient.pullScopeControlFeed(installationId, limit),
        ackScopeControlFeed: (input: { installation_id: string; cursor: string; lease_token: string }) =>
          feedClient.ackScopeControlFeed(input),
      } : {}),
    })
    feedTimer = setInterval(() => {
      const run = feedConsumer.runOnce().then(() => undefined, loopError('feed'))
      feedInFlight.add(run)
      void run.finally(() => feedInFlight.delete(run))
    }, config.pollIntervalMs)
    feedTimer.unref?.()

    // Handlers for compile_episode/snapshot_reconcile/purge register in later
    // tasks; unknown job types reschedule with a bounded no_handler code.
    const jobRepository = createJobRepository(pool)
    jobWorker = createJobWorker({
      pool,
      jobs: jobRepository,
      workerId: config.workerId,
      signal,
      leaseMs: config.jobLeaseMs,
      concurrencyLimits: {
        parse_code_snapshot: config.codegraphMaxConcurrency,
        build_wiki: config.wikiMaxConcurrency,
      },
      onError: loopError('jobs'),
    })
    const purgeRepository = createPurgeRepository(pool, {
      hmacKey: config.hmacKey,
      tombstoneHmacKeys: config.tombstoneHmacKeys,
      codeSnapshotRetentionDays: config.codeSnapshotRetentionDays,
      onInvalidated: (scope, count) => {
        if (count > 0) metrics.phase1.purgeInvalidations.inc({ scope }, count)
      },
    })
    purgeWorker = createPurgeWorker({
      pool,
      purge: purgeRepository,
      relay: createPurgeClient({ http, tokens }),
      intervalMs: 5_000,
      onError: loopError('purge'),
      onPurgeResult: result => {
        metrics.purge.inc({ result })
      },
    })
    purgeWorker.start()

    const projection = createProjectionHandler(pool, {
      purge: purgeRepository,
      onInvalidated: (scope, count) => {
        metrics.phase1.purgeInvalidations.inc({ scope }, count)
      },
      onProjected: count => {
        if (count > 0) metrics.projection.inc({ result: 'success' }, count)
      },
      onProjectionError: () => {
        metrics.projection.inc({ result: 'error' })
      },
    })
    jobWorker.register('project_feed', projection.handleProjectFeed)
    const episodes = createEpisodeRepository(pool, {
      stabilizationMs: config.episodeStabilizationMs,
      extractionMaxChars: config.extractionMaxChars,
      extractionDebounceMs: config.extractionDebounceMs,
    })
    jobWorker.register('compile_episode', episodes.handleCompileEpisode)
    jobWorker.register('snapshot_reconcile', snapshotReconciler.handleSnapshotReconcile)
    const codeGraphBuild = createCodeGraphBuildService({
      pool,
      metrics: metrics.phase4,
      mode: config.codegraphMode === 'enabled' ? 'enabled' : 'shadow',
    })
    jobWorker.register('parse_code_snapshot', codeGraphBuild.handleParseCodeSnapshot)
    const rawTextGenerator = config.textModel
      ? createOpenAICompatibleTextGenerator({
          baseUrl: config.textModel.baseUrl,
          model: config.textModel.model,
          apiKey: config.textModel.apiKey,
          timeoutMs: config.modelTimeoutMs,
          inputCostMicrosPerMillionTokens: config.textModel.inputCostMicrosPerMillionTokens,
          outputCostMicrosPerMillionTokens: config.textModel.outputCostMicrosPerMillionTokens,
          maxOutputTokens: config.providerBudget?.textMaxOutputTokensPerRequest,
          maxAttempts: config.providerBudget ? 1 : undefined,
          thinking: config.textModel.thinking,
        })
      : undefined
    const textGenerator = rawTextGenerator && config.providerBudget && providerBudgetStore
      ? withTextProviderBudget(rawTextGenerator, providerBudgetStore, {
          key: config.providerBudget.key,
          maxRequests: config.providerBudget.textMaxRequests,
          maxInputTokens: config.providerBudget.textMaxInputTokens,
          maxOutputTokens: config.providerBudget.textMaxOutputTokens,
          maxOutputTokensPerRequest: config.providerBudget.textMaxOutputTokensPerRequest,
        })
      : rawTextGenerator
    const rawWikiTextGenerator = config.textModel && config.wikiProviderBudget
      ? createOpenAICompatibleTextGenerator({
          baseUrl: config.textModel.baseUrl,
          model: config.textModel.model,
          apiKey: config.textModel.apiKey,
          timeoutMs: config.modelTimeoutMs,
          inputCostMicrosPerMillionTokens: config.textModel.inputCostMicrosPerMillionTokens,
          outputCostMicrosPerMillionTokens: config.textModel.outputCostMicrosPerMillionTokens,
          maxOutputTokens: config.wikiProviderBudget.textMaxOutputTokensPerRequest,
          maxAttempts: 1,
          thinking: config.textModel.thinking,
        })
      : undefined
    const wikiTextGenerator = rawWikiTextGenerator && config.wikiProviderBudget && providerBudgetStore
      ? withTextProviderBudget(rawWikiTextGenerator, providerBudgetStore, {
          key: config.wikiProviderBudget.key,
          maxRequests: config.wikiProviderBudget.textRequestLimit,
          maxInputTokens: config.wikiProviderBudget.textInputTokenLimit,
          maxOutputTokens: config.wikiProviderBudget.textOutputTokenLimit,
          maxOutputTokensPerRequest: config.wikiProviderBudget.textMaxOutputTokensPerRequest,
        })
      : undefined
    const wikiBuild = createWikiBuildService({
      pool,
      maxSections: config.wikiMaxSections,
      metrics: metrics.phase4,
      mode: config.wikiMode === 'enabled' ? 'enabled' : 'shadow',
      generator: wikiTextGenerator
        ? createWikiGenerator({
            provider: wikiTextGenerator,
            timeoutMs: config.modelTimeoutMs,
            maxPages: config.wikiMaxPages,
            maxSections: config.wikiMaxSections,
            maxSourceChars: config.wikiMaxSourceChars,
          })
        : undefined,
    })
    jobWorker.register('build_wiki', wikiBuild.handleBuildWiki)

    if (config.textModel && textGenerator) {
      const extractionConsentFingerprint = createHash('sha256')
        .update(`${config.textModel.provider}\n${config.textModel.baseUrl}\n${config.textModel.model}`)
        .digest('hex')
      const extractionStore = createExtractionRepository(pool)
      const extractionPolicyResolver = createPolicyResolver({
        pool,
        repository: createPolicyRepository(pool),
      })
      const extractor = createCandidateExtractor({
        store: extractionStore,
        textGenerator,
        provider: config.textModel.provider,
        model: config.textModel.model,
        modelConfigFingerprint: extractionConsentFingerprint,
        timeoutMs: config.modelTimeoutMs,
        extractionNotBefore: config.extractionNotBefore,
        maxRunsPerEpisode: config.extractionMaxRunsPerEpisode,
        deduper: createCandidateDeduper(pool, {
          tombstoneHmacKeys: config.tombstoneHmacKeys,
        }),
        resolvePolicy: async (installationId, repositoryId) => {
          const effective = await extractionPolicyResolver.resolve({
            installationId,
            kind: 'extraction',
            repositoryId: repositoryId ?? null,
          })
          return {
            document: effective.document as ExtractionPolicyDocument,
            effectivePolicyHash: effective.effectivePolicyHash,
          }
        },
      })
      jobWorker.register('extract_candidates', async (job, signal, ctx) => {
        if (!job.installation_id) return
        const consent = await pool.query<{
          extraction_mode: string
          extraction_consent_fingerprint: string | null
        }>(`
          SELECT extraction_mode, extraction_consent_fingerprint
          FROM memory_feature_settings WHERE installation_id = $1
        `, [job.installation_id])
        if (!consent.rows[0] || consent.rows[0].extraction_mode === 'off'
          || consent.rows[0].extraction_consent_fingerprint !== extractionConsentFingerprint) {
          metrics.phase1.extractionRuns.inc({ result: 'skipped' })
          return
        }
        const started = Date.now()
        const turnId = String(job.payload.turn_id ?? job.idempotency_key.replace(/^extract:/, '').split(':')[0])
        const outcome = await extractor.extract({
          installationId: job.installation_id,
          turnId,
          signal,
          fence: ctx?.fence,
        })
        const result = outcome.kind === 'succeeded'
          ? 'succeeded'
          : (outcome.kind === 'quarantined' ? 'quarantined'
            : (outcome.kind === 'failed' ? 'failed' : 'skipped'))
        metrics.phase1.extractionRuns.inc({ result })
        const mode = await pool.query<{ extraction_mode: string }>(`
          SELECT extraction_mode FROM memory_feature_settings WHERE installation_id = $1
        `, [job.installation_id])
        const modeLabel = mode.rows[0]?.extraction_mode
        if (modeLabel === 'shadow' || modeLabel === 'enabled') {
          metrics.phase1.extractionLatency.observe({ mode: modeLabel }, (Date.now() - started) / 1000)
        }
        if (outcome.kind === 'succeeded') {
          const statuses = await pool.query<{ status: string; count: string }>(`
            SELECT status, COUNT(*)::text AS count FROM memory_candidates
            WHERE run_id = $1 GROUP BY status
          `, [outcome.runId])
          for (const row of statuses.rows) {
            if (metrics.phase1.extractionLabelAllowed('status', row.status)) {
              metrics.phase1.candidateStatus.inc({ status: row.status }, Number(row.count))
            }
          }
        }
        // Only the worker that owned and completed this model attempt emits
        // its usage. Redelivered jobs return skipped_existing, while a
        // concurrent owner returns run_in_progress; counting either would
        // duplicate an already emitted run's counters.
        if ('runId' in outcome
          && outcome.kind !== 'skipped_existing'
          && !(outcome.kind === 'failed' && outcome.errorCode === 'run_in_progress')) {
          const usage = await pool.query<{ input_tokens: string; output_tokens: string; cost_micros: string }>(`
            SELECT input_tokens::text, output_tokens::text, cost_micros::text
            FROM memory_extraction_runs WHERE run_id = $1
          `, [outcome.runId])
          const row = usage.rows[0]
          if (row) {
            metrics.phase1.extractionTokens.inc({ direction: 'input' }, Number(row.input_tokens))
            metrics.phase1.extractionTokens.inc({ direction: 'output' }, Number(row.output_tokens))
            metrics.phase1.extractionCostMicros.inc(Number(row.cost_micros))
          }
        }
        if (outcome.kind === 'failed' && outcome.retryable) {
          throw new Error(`extract_candidates retryable: ${outcome.errorCode}`)
        }
      })
    } else {
      loopError('extract_candidates')(new Error('extraction_unconfigured'))
    }

    const claimRepository = createClaimRepository(pool)
    const lifecycle = createLifecycleService(pool, claimRepository)
		const contextInvalidation = createInvalidationService({ pool })
		jobWorker.register('invalidate_context_packs', async job => {
			if (!job.installation_id) return
			const claimIds = Array.isArray(job.payload.claim_ids)
				? job.payload.claim_ids.filter((value): value is string => typeof value === 'string') : []
			const versionIds = Array.isArray(job.payload.version_ids)
				? job.payload.version_ids.filter((value): value is string => typeof value === 'string') : []
			if (claimIds.length > 0) {
				await contextInvalidation.onClaimStateChange({ installationId: job.installation_id, claimIds })
			} else if (versionIds.length > 0) {
				await contextInvalidation.onEvidencePurge({ installationId: job.installation_id, versionIds })
			} else {
				const reason = String(job.payload.reason ?? 'settings_changed')
				const boundedReason = ['settings_changed', 'policy_changed', 'loadout_changed', 'service_disabled'].includes(reason)
					? reason as 'settings_changed' | 'policy_changed' | 'loadout_changed' | 'service_disabled'
					: 'settings_changed'
				await contextInvalidation.onConfigurationChange({
					installationId: job.installation_id, reason: boundedReason,
				})
			}
		})
		jobWorker.register('recompile_extraction_policy', async job => {
			if (!job.installation_id) return
			const turns = await pool.query<{ turn_id: string }>(`
				SELECT turn_id FROM work_episodes
				WHERE installation_id = $1 AND state = 'ready'
				ORDER BY ready_at DESC NULLS LAST LIMIT 1000
			`, [job.installation_id])
			const policyKey = String(job.payload.policy_hash ?? 'current').slice(0, 64)
			for (const row of turns.rows) {
				await jobRepository.enqueueJob({
					installationId: job.installation_id, jobType: 'extract_candidates', priority: 85,
					idempotencyKey: `extract:${row.turn_id}:policy:${policyKey}`,
					payload: { turn_id: row.turn_id },
				})
			}
		})
		// Shadow compilation is synchronous because the minimized query must never
		// be persisted in a job payload. Delivery receipts are likewise committed
		// synchronously by the session-bound API. Register terminal compatibility
		// handlers so legacy queued rows complete instead of looping as no_handler.
		jobWorker.register('compile_context_shadow', async () => undefined)
		jobWorker.register('record_context_delivery', async () => undefined)
    jobWorker.register('expire_claims', async () => {
      await lifecycle.expireDueClaims()
    })
    const enqueueExpirySweep = () => jobRepository.enqueueJob({
      jobType: 'expire_claims',
      idempotencyKey: `expire:${Math.floor(Date.now() / 60_000)}`,
      priority: 95,
    })
    await enqueueExpirySweep()
    maintenanceTimer = setInterval(() => {
      void enqueueExpirySweep().catch(loopError('expire_schedule'))
    }, 60_000)
    maintenanceTimer.unref?.()
    const rawWorkerEmbeddingProvider = config.embeddingModel
      ? createOpenAICompatibleEmbeddingProvider({
          baseUrl: config.embeddingModel.baseUrl,
          model: config.embeddingModel.model,
          apiKey: config.embeddingModel.apiKey,
          dimensions: config.embeddingModel.dimensions,
          timeoutMs: config.modelTimeoutMs,
          inputCostMicrosPerMillionTokens: config.embeddingModel.inputCostMicrosPerMillionTokens,
          maxAttempts: config.providerBudget ? 1 : undefined,
        })
      : undefined
    const workerEmbeddingProvider = rawWorkerEmbeddingProvider && config.providerBudget && providerBudgetStore
      ? withEmbeddingProviderBudget(rawWorkerEmbeddingProvider, providerBudgetStore, {
          key: config.providerBudget.key,
          maxRequests: config.providerBudget.embeddingMaxRequests,
          maxTokens: config.providerBudget.embeddingMaxTokens,
        })
      : rawWorkerEmbeddingProvider
    const claimIndexer = createClaimIndexer({
      pool,
      ...(config.embeddingModel && workerEmbeddingProvider ? {
        embed: Object.assign(
          workerEmbeddingProvider,
          { provider: config.embeddingModel.provider, model: config.embeddingModel.model },
        ),
      } : {}),
      ...(config.embeddingModel ? {
        embeddingConsentFingerprint: createHash('sha256')
          .update(`${config.embeddingModel.provider}\n${config.embeddingModel.baseUrl}\n${config.embeddingModel.model}\n${config.embeddingModel.dimensions}`)
          .digest('hex'),
      } : {}),
    })
    const indexClaimVersion = async (job: import('./jobs/types.js').JobClaim, signal: AbortSignal) => {
      try {
        await claimIndexer.handleIndexClaimVersion(job, signal)
        metrics.phase1.indexJobs.inc({ result: 'success' })
      } catch (error) {
        metrics.phase1.indexJobs.inc({ result: 'failed' })
        throw error
      }
    }
    jobWorker.register('index_claim_version', indexClaimVersion)
    jobWorker.register('index_shared_claim', indexClaimVersion)
    jobWorker.register('rebuild_claim_index', claimIndexer.handleRebuildClaimIndex.bind(claimIndexer))
    if (config.embeddingModel) {
      const enabledInstallations = await pool.query<{ installation_id: string }>(`
        SELECT installation_id::text
        FROM memory_feature_settings
        WHERE embedding_mode IN ('shadow', 'enabled')
      `)
      for (const installation of enabledInstallations.rows) {
        await claimIndexer.enqueueRebuildIfModelChanged(
          installation.installation_id,
          {
            provider: config.embeddingModel.provider,
            model: config.embeddingModel.model,
            dimensions: config.embeddingModel.dimensions,
            fingerprint: createHash('sha256')
              .update(`${config.embeddingModel.provider}\n${config.embeddingModel.baseUrl}\n${config.embeddingModel.model}\n${config.embeddingModel.dimensions}`)
              .digest('hex'),
          },
        )
      }
    }
    jobWorker.start()

    const reportingClient = createReportingClient({ http, tokens })
    statusWorker = createStatusWorker({
      pool,
      reportStatus: input => reportingClient.reportStatus(input),
      providerVersion: config.providerVersion,
      intervalMs: 60_000,
      onError: loopError('status'),
    })
    statusWorker.start()
    usageWorker = createUsageWorker({
      pool,
      reportUsage: (installationId, facts) => reportingClient.reportUsage(installationId, facts),
      onError: loopError('usage'),
    })
    usageWorker.start()
    logger.log('info', 'worker_started', {
      mode: config.mode,
      metrics_port: config.metricsPort,
      job_lease_ms: config.jobLeaseMs,
    })
  } else {
    // off: never dial Relay, never consume the feed. Idle until shutdown.
    logger.log('info', 'worker_started', { mode: 'off', metrics_port: config.metricsPort })
  }

  // Run until SIGINT/SIGTERM. No deadline here: a deadline measured from
  // process start would self-terminate the worker; the per-loop drain steps
  // below already bound how long shutdown itself takes.
  await wait
  // Stop every timer first so no new cycle can start while draining; then
  // wait for the in-flight passes so pool.end() never yanks the connection
  // out from under a relay ack or feed commit.
  if (feedTimer) clearInterval(feedTimer)
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  clearInterval(gaugeTimer)
  clearInterval(retentionTimer)
  await Promise.all([
    purgeWorker?.stop(),
    statusWorker?.stop(),
    usageWorker?.stop(),
    discovery?.stop(),
  ])
  const jobOutcome = await jobWorker?.stop()
  await Promise.race([
    Promise.allSettled([...feedInFlight]),
    new Promise(resolve => {
      const timer = setTimeout(resolve, 10_000)
      timer.unref?.()
    }),
  ])
  // Idle keep-alive scrapers would otherwise hold close() open indefinitely.
  metricsServer.closeIdleConnections()
  await new Promise<void>(resolve => metricsServer.close(() => resolve()))
  await pool.end()
  logger.log('info', 'worker_stopped', { job_outcome: jobOutcome ?? 'off' })
  process.exit(jobOutcome === 'deadline' ? 1 : 0)
}

main().catch(error => {
  // Config or startup failures exit non-zero without echoing secrets.
  console.error('memory-worker startup failed:', loopErrorCode(error))
  process.exit(1)
})
