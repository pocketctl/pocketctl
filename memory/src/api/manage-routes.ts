import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { GrantGuard } from '../auth/grant-guard.js'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { MemoryApiError, errorBody } from './errors.js'
import {
  AcceptRequestSchema,
  CorrectRequestSchema,
  DeleteRequestSchema,
  FeedbackRequestSchema,
  ListQuerySchema,
  RejectRequestSchema,
  SettingsPatchSchema,
  TransitionRequestSchema,
  UUIDSchema,
} from './schemas.js'
import { createClaimRepository } from '../claims/repository.js'
import { createReviewService } from '../claims/review-service.js'
import { createLifecycleService } from '../claims/lifecycle-service.js'
import { createIdempotencyStore } from './idempotency.js'
import { createSettingsRepository } from '../settings/repository.js'
import type { TombstoneHmacKey } from '../config.js'
import { insertKnowledgeTombstones } from '../claims/tombstones.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'
import type { Phase1Metrics } from '../metrics.js'
import { createTransactionBoundPool } from './transaction-bound-pool.js'

/**
 * Management routes (plan §7.2). Every mutation requires memory.manage, an
 * Idempotency-Key header and expected_revision; duplicate keys replay the
 * original bounded metadata, stale revisions surface 409 with only the
 * current revision/state.
 */

export interface ManageRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  policy: CorsHostPolicy
  rateLimiter?: { check(key: string): { allowed: boolean } }
  textConfigured: boolean
  embeddingConfigured: boolean
  extractionAdapter?: ModelDisclosure
  embeddingAdapter?: ModelDisclosure
  tombstoneHmacKeys: readonly TombstoneHmacKey[]
  phase1Metrics?: Phase1Metrics
}

export interface ModelDisclosure {
  provider: string
  origin: string
  model: string
  fingerprint: string
  pricing_configured: boolean
}

interface ReplyLike {
  code(status: number): { send(body: unknown): void }
  send(body: unknown): void
}

export function registerManageRoutes(app: FastifyInstance, deps: ManageRouteDeps): void {
  const claims = createClaimRepository(deps.pool)
  const review = createReviewService(deps.pool, claims)
  const idempotency = createIdempotencyStore(deps.pool)
  const settings = createSettingsRepository(deps.pool, {
    textConfigured: deps.textConfigured,
    embeddingConfigured: deps.embeddingConfigured,
    extractionConsentFingerprint: deps.extractionAdapter?.fingerprint,
    embeddingConsentFingerprint: deps.embeddingAdapter?.fingerprint,
  })
  const authenticated = new WeakMap<object, { installationId: string }>()

  const settingsBody = (current: Awaited<ReturnType<typeof settings.get>>) => ({
    extraction_mode: current.extractionMode,
    embedding_mode: current.embeddingMode,
    revision: current.revision,
    extraction_ready: deps.textConfigured,
    embedding_ready: deps.embeddingConfigured,
    extraction_adapter: deps.extractionAdapter ?? null,
    embedding_adapter: deps.embeddingAdapter ?? null,
    extraction_consent_required: current.extractionMode !== 'off'
      && Boolean(deps.extractionAdapter)
      && current.extractionConsentFingerprint !== deps.extractionAdapter?.fingerprint,
    embedding_consent_required: current.embeddingMode !== 'off'
      && Boolean(deps.embeddingAdapter)
      && current.embeddingConsentFingerprint !== deps.embeddingAdapter?.fingerprint,
  })

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
    if (isManageRequest(request.method, request.url)) {
      const grant = await guardManage(request, reply)
      if (!grant) return reply
    }
  })

  async function guardManage(
    request: { headers: { authorization?: string } },
    reply: ReplyLike,
  ): Promise<{ installationId: string } | undefined> {
    const cached = authenticated.get(request as object)
    if (cached) return cached
    try {
      const grant = await deps.guard.guard({
        authorization: request.headers.authorization,
        requiredService: 'memory.manage',
      })
      if (deps.rateLimiter && !deps.rateLimiter.check(`manage:${grant.installationId}`).allowed) {
        reply.code(429).send(errorBody(new MemoryApiError('rate_limited', 'rate limit exceeded')))
        return undefined
      }
      authenticated.set(request as object, grant)
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

  function revisionConflict(reply: ReplyLike, currentRevision: number, state: string) {
    reply.code(409).send({
      error: {
        code: 'revision_conflict',
        message: 'expected_revision does not match',
        current_revision: currentRevision,
        state,
      },
    })
  }

  function resourceId(value: string, reply: ReplyLike): string | undefined {
    const parsed = UUIDSchema.safeParse(value)
    if (parsed.success) return parsed.data
    reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid resource id')))
    return undefined
  }

  app.get('/api/v1/memory/candidates', async (request, reply) => {
    const grant = await guardManage(request, reply)
    if (!grant) return
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid candidate query')))
      return
    }
    const queue = await review.reviewQueue({
      installationId: grant.installationId,
      limit: parsed.data.limit,
    })
    return { candidates: queue }
  })

  app.get('/api/v1/memory/settings', async (request, reply) => {
    const grant = await guardManage(request, reply)
    if (!grant) return
    const current = await settings.get(grant.installationId)
    return settingsBody(current)
  })

  app.patch('/api/v1/memory/settings', { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = SettingsPatchSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid settings body')))
      return
    }
    const response = await mutation(request, reply, 'patch_settings', async (grant, transactionPool) => {
      await transactionPool.query(`
        SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
      `, [grant.installationId])
      const transactionSettings = createSettingsRepository(transactionPool, {
        textConfigured: deps.textConfigured,
        embeddingConfigured: deps.embeddingConfigured,
        extractionConsentFingerprint: deps.extractionAdapter?.fingerprint,
        embeddingConsentFingerprint: deps.embeddingAdapter?.fingerprint,
      })
      const previous = await transactionSettings.get(grant.installationId)
      const result = await transactionSettings.update({
        installationId: grant.installationId,
        expectedRevision: parsed.data.expected_revision,
        ...(parsed.data.extraction_mode ? { extractionMode: parsed.data.extraction_mode } : {}),
        ...(parsed.data.embedding_mode ? { embeddingMode: parsed.data.embedding_mode } : {}),
        ...(parsed.data.confirm_extraction_fingerprint
          ? { confirmExtractionFingerprint: parsed.data.confirm_extraction_fingerprint }
          : {}),
        ...(parsed.data.confirm_embedding_fingerprint
          ? { confirmEmbeddingFingerprint: parsed.data.confirm_embedding_fingerprint }
          : {}),
      })
      if (!result.ok) {
        if (result.code === 'revision_conflict') {
          const current = await transactionSettings.get(grant.installationId)
          return { ok: false, error: {
            code: 'revision_conflict', currentRevision: current.revision, state: 'active',
          } }
        }
        return { ok: false, error: { code: result.code } }
      }
      if (result.settings.extractionMode !== 'off' && deps.extractionAdapter
        && (previous.extractionMode === 'off'
          || previous.extractionConsentFingerprint !== deps.extractionAdapter.fingerprint)) {
        await transactionPool.query(`
          INSERT INTO memory_jobs
            (job_id, installation_id, job_type, idempotency_key, priority, payload)
          SELECT gen_random_uuid(), e.installation_id, 'extract_candidates',
                 'extract:' || e.turn_id || ':' || encode(e.source_digest, 'hex') || ':' || $2, 85,
                 jsonb_build_object('turn_id', e.turn_id,
                   'source_digest', encode(e.source_digest, 'hex'),
                   'compiler_version', e.document_compiler_version)
          FROM work_episodes e
          WHERE e.installation_id = $1 AND e.source_digest IS NOT NULL
            AND e.document_compiler_version IS NOT NULL
          ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
            state = CASE
              WHEN memory_jobs.state IN ('completed', 'dead') THEN 'pending'
              ELSE memory_jobs.state
            END,
            available_at = NOW(),
            attempts = CASE
              WHEN memory_jobs.state = 'running' THEN memory_jobs.attempts
              ELSE 0
            END,
            claimed_by = CASE
              WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL
              ELSE memory_jobs.claimed_by
            END,
            claim_expires_at = CASE
              WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL
              ELSE memory_jobs.claim_expires_at
            END,
            last_error_code = CASE
              WHEN memory_jobs.state = 'running' THEN 'rerun_required'
              ELSE NULL
            END,
            completed_at = CASE
              WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL
              ELSE memory_jobs.completed_at
            END
        `, [grant.installationId, deps.extractionAdapter.fingerprint])
      }
      if (result.settings.embeddingMode !== 'off' && deps.embeddingAdapter
        && (previous.embeddingMode === 'off'
          || previous.embeddingConsentFingerprint !== deps.embeddingAdapter.fingerprint)) {
        await transactionPool.query(`
          INSERT INTO memory_jobs
            (job_id, installation_id, job_type, idempotency_key, priority, payload)
          VALUES (gen_random_uuid(), $1, 'rebuild_claim_index', $2, 95,
                  jsonb_build_object('model', $3::text, 'adapter_fingerprint', $4::text))
          ON CONFLICT DO NOTHING
        `, [grant.installationId, `rebuild:${deps.embeddingAdapter.fingerprint}`,
            deps.embeddingAdapter.model, deps.embeddingAdapter.fingerprint])
      }
      return { ok: true, metadata: {
        ...settingsBody(result.settings),
      } }
    })
    if (response !== undefined) return response
  })

  const mutation = async (
    request: { headers: { authorization?: string; 'idempotency-key'?: string }; body?: unknown; params?: unknown },
    reply: ReplyLike,
    operation: string,
    run: (
      grant: { installationId: string },
      transactionPool: pg.Pool,
      client: pg.PoolClient,
    ) => Promise<
      | { ok: true; metadata: Record<string, unknown>; afterCommit?: () => void }
      | { ok: false; error: unknown }
    >,
  ) => {
    const grant = await guardManage(request, reply)
    if (!grant) return undefined
    const key = request.headers['idempotency-key']
    if (!key || key.length === 0 || key.length > 256) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'Idempotency-Key header required')))
      return undefined
    }
    let afterCommit: (() => void) | undefined
    const outcome = await idempotency.execute({
      installationId: grant.installationId,
      operation,
      key,
      requestCanonical: JSON.stringify({ params: request.params ?? {}, body: request.body ?? {} }),
      run: async client => {
        const result = await run(grant, createTransactionBoundPool(client), client)
        if (result.ok) afterCommit = result.afterCommit
        return result
      },
    })
    if (outcome.kind === 'replayed') return outcome.metadata
    if (outcome.kind === 'conflict') {
      reply.code(409).send(errorBody(new MemoryApiError('revision_conflict', 'idempotency key reuse with a different request')))
      return undefined
    }
    if (outcome.kind === 'failed') {
      const error = outcome.error as { code?: string; currentRevision?: number; state?: string }
      if (error?.code === 'revision_conflict') {
        revisionConflict(reply, error.currentRevision ?? 0, error.state ?? 'unknown')
        return undefined
      }
      if (error?.code === 'candidate_not_found' || error?.code === 'claim_not_found') {
        reply.code(404).send(errorBody(new MemoryApiError('not_found', 'resource not found')))
        return undefined
      }
      if (error?.code === 'candidate_not_reviewable' || error?.code === 'claim_not_active') {
        reply.code(409).send({
          error: {
            code: 'revision_conflict',
            message: 'resource is not in a reviewable state',
            state: 'terminal',
          },
        })
        return undefined
      }
      if (error?.code === 'identity_conflict') {
        reply.code(409).send(errorBody(new MemoryApiError('revision_conflict', 'claim identity already exists')))
        return undefined
      }
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', error?.code ?? 'mutation failed')))
      return undefined
    }
    try {
      afterCommit?.()
    } catch {
      // Observability is best-effort after the durable mutation and must not
      // turn a committed operation into a client-visible failure.
    }
    return outcome.metadata
  }

  app.post('/api/v1/memory/candidates/:id/accept', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const id = resourceId((request.params as { id: string }).id, reply)
    if (!id) return
    const parsed = AcceptRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid accept body')))
      return
    }
    const result = await mutation(request, reply, 'accept_candidate', async (grant, transactionPool) => {
      const transactionClaims = createClaimRepository(transactionPool)
      const transactionReview = createReviewService(transactionPool, transactionClaims)
      const accepted = await transactionReview.acceptCandidate({
        installationId: grant.installationId,
        candidateId: id,
        expectedRevision: parsed.data.expected_revision,
        ...(parsed.data.edited_statement ? { editedStatement: parsed.data.edited_statement } : {}),
      })
      if (!accepted.ok) return { ok: false, error: accepted.error }
      return {
        ok: true,
        metadata: { claim_id: accepted.claimId, version_id: accepted.versionId, state: 'active' },
        afterCommit: () => {
          deps.phase1Metrics?.reviewDecisions.inc({ decision: accepted.reviewDecision })
          deps.phase1Metrics?.candidateStatus.inc({ status: 'accepted' })
        },
      }
    })
    if (result !== undefined) return result
  })

  app.post('/api/v1/memory/candidates/:id/reject', { bodyLimit: 4096 }, async (request, reply) => {
    const id = resourceId((request.params as { id: string }).id, reply)
    if (!id) return
    const parsed = RejectRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid reject body')))
      return
    }
    const result = await mutation(request, reply, 'reject_candidate', async (grant, transactionPool) => {
      const transactionClaims = createClaimRepository(transactionPool)
      const transactionReview = createReviewService(transactionPool, transactionClaims)
      const rejected = await transactionReview.rejectCandidate({
        installationId: grant.installationId,
        candidateId: id,
        expectedRevision: parsed.data.expected_revision,
        reasonCode: parsed.data.reason_code ?? undefined,
      })
      if (!rejected.ok) return { ok: false, error: rejected.error }
      return {
        ok: true,
        metadata: { candidate_id: id, state: 'rejected' },
        afterCommit: () => {
          deps.phase1Metrics?.reviewDecisions.inc({ decision: 'rejected' })
          deps.phase1Metrics?.candidateStatus.inc({ status: 'rejected' })
        },
      }
    })
    if (result !== undefined) return result
  })

  app.post('/api/v1/memory/claims/:id/correct', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const id = resourceId((request.params as { id: string }).id, reply)
    if (!id) return
    const parsed = CorrectRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid correct body')))
      return
    }
    const result = await mutation(request, reply, 'correct_claim', async (grant, transactionPool) => {
      const transactionClaims = createClaimRepository(transactionPool)
      const transactionLifecycle = createLifecycleService(transactionPool, transactionClaims)
      const corrected = await transactionLifecycle.correctClaim({
        installationId: grant.installationId,
        claimId: id,
        expectedRevision: parsed.data.expected_revision,
        statement: parsed.data.statement,
        evidence: parsed.data.evidence.map(item => ({
          evidenceKind: item.evidence_kind,
          episodeId: item.episode_id ?? null,
          sourceEventId: item.evidence_kind === 'event' ? item.source_event_id : null,
          artifactId: item.evidence_kind === 'artifact' ? item.artifact_id : null,
          locator: item.locator,
          excerpt: item.excerpt,
          occurredAt: new Date(item.occurred_at),
        })),
      })
      if (!corrected.ok) return { ok: false, error: corrected.error }
      return {
        ok: true,
        metadata: {
          claim_id: corrected.claimId,
          version_id: corrected.versionId,
          version_number: corrected.versionNumber,
          state: 'active',
        },
      }
    })
    if (result !== undefined) return result
  })

  app.post('/api/v1/memory/claims/:id/expire', { bodyLimit: 4096 }, async (request, reply) => {
    const id = resourceId((request.params as { id: string }).id, reply)
    if (!id) return
    const parsed = TransitionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid expire body')))
      return
    }
    const result = await mutation(request, reply, 'expire_claim', async (grant, transactionPool) => {
      const transactionClaims = createClaimRepository(transactionPool)
      const transactionLifecycle = createLifecycleService(transactionPool, transactionClaims)
      const transitioned = await transactionLifecycle.expireClaim({
        installationId: grant.installationId,
        claimId: id,
        expectedRevision: parsed.data.expected_revision,
      })
      if (!transitioned.ok) return { ok: false, error: transitioned.error }
      return { ok: true, metadata: { claim_id: id, state: 'expired' } }
    })
    if (result !== undefined) return result
  })

  app.post('/api/v1/memory/claims/:id/revoke', { bodyLimit: 4096 }, async (request, reply) => {
    const id = resourceId((request.params as { id: string }).id, reply)
    if (!id) return
    const parsed = TransitionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid revoke body')))
      return
    }
    const result = await mutation(request, reply, 'revoke_claim', async (grant, transactionPool) => {
      const transactionClaims = createClaimRepository(transactionPool)
      const transactionLifecycle = createLifecycleService(transactionPool, transactionClaims)
      const transitioned = await transactionLifecycle.revokeClaim({
        installationId: grant.installationId,
        claimId: id,
        expectedRevision: parsed.data.expected_revision,
      })
      if (!transitioned.ok) return { ok: false, error: transitioned.error }
      return { ok: true, metadata: { claim_id: id, state: 'revoked' } }
    })
    if (result !== undefined) return result
  })

  app.delete('/api/v1/memory/claims/:id', async (request, reply) => {
    const id = resourceId((request.params as { id: string }).id, reply)
    if (!id) return
    const parsed = DeleteRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid delete body')))
      return
    }
    const result = await mutation(request, reply, 'delete_claim', async (grant, _transactionPool, client) => {
      const claim = await client.query<{
        claim_type: string
        scope_key: string
        normalized_key: string
        revision: string
      }>(`
          SELECT claim_type, scope_key, normalized_key, revision::text
          FROM knowledge_claims
          WHERE installation_id = $1 AND claim_id = $2
          FOR UPDATE
        `, [grant.installationId, id])
      const row = claim.rows[0]
      if (!row) {
        return { ok: false, error: { code: 'claim_not_found' } }
      }
      if (Number(row.revision) !== parsed.data.expected_revision) {
        return { ok: false, error: {
          code: 'revision_conflict', currentRevision: Number(row.revision), state: 'active',
        } }
      }
      const versions = await client.query<{ statement: string }>(`
        SELECT statement
        FROM knowledge_versions
        WHERE installation_id = $1 AND claim_id = $2
        ORDER BY version_number
      `, [grant.installationId, id])
      await insertKnowledgeTombstones(client, {
        installationId: grant.installationId,
        normalizedKeys: [
          row.normalized_key,
          ...versions.rows.map(version => normalizedClaimKey({
            claimType: row.claim_type,
            scopeKey: row.scope_key,
            statement: version.statement,
          })),
        ],
        reason: 'privacy_delete',
        keys: deps.tombstoneHmacKeys,
      })
      await client.query(`
        DELETE FROM knowledge_claims WHERE installation_id = $1 AND claim_id = $2
      `, [grant.installationId, id])
      await client.query(`
        INSERT INTO memory_feedback (feedback_id, installation_id, action)
        VALUES (gen_random_uuid(), $1, 'claim_deleted')
      `, [grant.installationId])
      return { ok: true, metadata: { claim_id: id, state: 'deleted' } }
    })
    if (result !== undefined) return result
  })

  app.post('/api/v1/memory/feedback', { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = FeedbackRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400).send(errorBody(new MemoryApiError('invalid_request', 'invalid feedback body')))
      return
    }
    const result = await mutation(request, reply, 'record_feedback', async (grant, _transactionPool, client) => {
      await client.query(`
        INSERT INTO memory_feedback
          (feedback_id, installation_id, request_id, action, reason_code)
        VALUES (gen_random_uuid(), $1, $2, $3, $4)
      `, [grant.installationId, parsed.data.request_id ?? null,
        parsed.data.action, parsed.data.reason_code ?? null])
      return {
        ok: true,
        metadata: { recorded: true },
        afterCommit: () => deps.phase1Metrics?.recallFeedback.inc({ action: parsed.data.action }),
      }
    })
    if (result !== undefined) return result
  })
}

function isManageRequest(method: string, rawUrl: string): boolean {
  const path = rawUrl.split('?')[0]
  if (path === '/api/v1/memory/candidates' || path === '/api/v1/memory/settings'
    || path === '/api/v1/memory/feedback') return true
  if (method === 'POST' && /^\/api\/v1\/memory\/candidates\/[^/]+\/(accept|reject)$/.test(path)) return true
  if (method === 'POST' && /^\/api\/v1\/memory\/claims\/[^/]+\/(correct|expire|revoke)$/.test(path)) return true
  return method === 'DELETE' && /^\/api\/v1\/memory\/claims\/[^/]+$/.test(path)
}
