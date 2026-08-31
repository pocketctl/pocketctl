import type { FastifyInstance } from 'fastify'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import type { GrantGuard } from '../auth/grant-guard.js'
import { MemoryApiError, errorBody } from './errors.js'
import type { ContextCompiler } from '../context/compiler.js'
import type { AdmissionService } from '../context/admission-service.js'
import { createFeedbackService, type FeedbackService } from '../context/feedback-service.js'
import type { PackRepository } from '../context/pack-repository.js'
import { createContextSettingsRepository, type ContextSettingsRepository } from '../context/settings-repository.js'
import { createLoadoutRepository, type LoadoutRepository } from '../context/loadout-repository.js'
import { createInvalidationService } from '../context/invalidation-service.js'
import type { ContextMode } from '../context/types.js'
import { createIdempotencyStore } from './idempotency.js'
import { createTransactionBoundPool } from './transaction-bound-pool.js'

/**
 * Phase 2 context routes (plan section 10). Agent routes require a
 * session-bound daemon grant carrying `memory.context`; management routes
 * require `memory.manage`. The transient query is held in request memory
 * only — it is never logged, echoed, or persisted.
 */

export interface ContextRouteDeps {
  pool: import('pg').Pool
  guard: GrantGuard
  policy: CorsHostPolicy
  rateLimiter?: { check(key: string): { allowed: boolean } }
  compiler: ContextCompiler
  admission: AdmissionService
  feedback: FeedbackService
  packs: PackRepository
  settings: ContextSettingsRepository
  loadouts: LoadoutRepository
  requestKey: { keyId: string; hmacKey: Buffer }
}

const MAX_QUERY_BYTES = 32 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i
const REPOSITORY_HOST_RE = /^[a-z0-9.-]+(?::[0-9]{1,5})?$/

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function optionalBoundedString(value: unknown, maxLength: number): value is string | null | undefined {
  return value == null || boundedString(value, maxLength)
}

function optionalUuid(value: unknown): value is string | null | undefined {
  return value == null || (typeof value === 'string' && UUID_RE.test(value))
}

function canonicalRepositoryKey(value: unknown): value is string {
  if (!boundedString(value, 512) || value.includes('://') || value.includes('\\')
    || value.includes('?') || value.includes('#') || /\s/.test(value)) return false
  const segments = value.split('/')
  if (segments.length < 3 || !REPOSITORY_HOST_RE.test(segments[0])) return false
  return segments.slice(1).every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function repositoryFact(value: unknown): value is string {
  return typeof value === 'string' && (UUID_RE.test(value) || canonicalRepositoryKey(value))
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function decodePackCursor(value: string | undefined): { createdAt: Date; packId: string } | null {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      created_at?: unknown
      pack_id?: unknown
    }
    if (typeof parsed.created_at !== 'string' || typeof parsed.pack_id !== 'string'
      || !UUID_RE.test(parsed.pack_id)) return null
    const createdAt = new Date(parsed.created_at)
    return Number.isFinite(createdAt.getTime()) ? { createdAt, packId: parsed.pack_id } : null
  } catch {
    return null
  }
}

function encodePackCursor(row: { created_at: Date; pack_id: string }): string {
  return Buffer.from(JSON.stringify({
    created_at: row.created_at.toISOString(), pack_id: row.pack_id,
  })).toString('base64url')
}

interface CompileBody {
  schema_version?: number
  client_request_id?: unknown
  session_id?: unknown
  agent?: unknown
  adapter_capability?: unknown
  repository_hint?: {
    repository_id?: unknown
    branch?: unknown
    commit_sha?: unknown
  } | null
  query?: unknown
}

export function registerContextRoutes(app: FastifyInstance, deps: ContextRouteDeps) {
  const idempotency = createIdempotencyStore(deps.pool)
  const mutation = async (
    req: Pick<import('fastify').FastifyRequest, 'headers' | 'body' | 'params'>,
    installationId: string,
    operation: string,
    run: (transactionPool: import('pg').Pool) => Promise<
      { ok: true; metadata: Record<string, unknown> } | { ok: false; error: unknown }
    >,
  ) => {
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
      throw new MemoryApiError('invalid_request', 'Idempotency-Key header required')
    }
    return idempotency.execute({
      installationId,
      operation,
      key,
      requestCanonical: JSON.stringify({ params: req.params ?? {}, body: req.body ?? {} }),
      run: async client => run(createTransactionBoundPool(client)),
    })
  }
  const daemonGuard = async (authorization: string | undefined, sessionId: string) => {
    const grant = await deps.guard.guard({
      authorization,
      requiredService: 'memory.context',
      sessionId,
    })
    return grant
  }

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof MemoryApiError) {
      reply.code(error.httpStatus).send(errorBody(error))
      return
    }
    reply.code(500).send({ error: { code: 'internal', message: 'internal error' } })
  })

  const gate = (req: { headers: { host?: string; origin?: string } }, reply: {
    code: (status: number) => { send: (body: unknown) => unknown }
  }): boolean => {
    if (!deps.policy.hostAllowed(req.headers.host)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'host rejected' } })
      return false
    }
    if (!deps.policy.originAllowed(req.headers.origin)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'origin rejected' } })
      return false
    }
    return true
  }

  app.post('/api/v1/memory/context/compile', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    if (!gate(req, reply)) return
    const body = (req.body ?? {}) as CompileBody
    if (body.schema_version !== 1
      || !boundedString(body.client_request_id, 128)
      || !boundedString(body.session_id, 64)
      || !boundedString(body.agent, 64)
      || (body.adapter_capability !== 'native_hidden_v1' && body.adapter_capability !== 'shadow_only')
      || typeof body.query !== 'string'
      || (body.repository_hint != null
        && (typeof body.repository_hint !== 'object'
          || (body.repository_hint.repository_id !== undefined
            && (typeof body.repository_hint.repository_id !== 'string'
              || !repositoryFact(body.repository_hint.repository_id)))
          || (body.repository_hint.branch !== undefined
            && (typeof body.repository_hint.branch !== 'string'
              || body.repository_hint.branch.length > 255))
          || (body.repository_hint.commit_sha !== undefined
            && (typeof body.repository_hint.commit_sha !== 'string'
              || !COMMIT_SHA_RE.test(body.repository_hint.commit_sha)))))) {
      throw new MemoryApiError('invalid_request', 'invalid compile body')
    }
    const query = truncateUtf8(body.query, MAX_QUERY_BYTES)

    // Session binding: the body session MUST equal the grant session.
    const grant = await daemonGuard(req.headers.authorization, body.session_id)
    if (grant.callerType !== 'daemon') {
      throw new MemoryApiError('forbidden', 'caller type not permitted')
    }
    if (deps.rateLimiter && !deps.rateLimiter.check(`context:${grant.installationId}`).allowed) {
      reply.code(429)
      return { error: { code: 'rate_limited' } }
    }

    const outcome = await deps.compiler.compile({
      installationId: grant.installationId,
      sessionId: body.session_id,
      clientRequestId: body.client_request_id,
      agent: body.agent,
      adapterCapability: body.adapter_capability,
      repositoryId: typeof body.repository_hint?.repository_id === 'string'
        && UUID_RE.test(body.repository_hint.repository_id)
        ? body.repository_hint.repository_id : null,
      repositoryKey: canonicalRepositoryKey(body.repository_hint?.repository_id)
        ? body.repository_hint?.repository_id : null,
      branch: typeof body.repository_hint?.branch === 'string'
        ? body.repository_hint.branch : null,
      query,
      requestKey: deps.requestKey,
    })

    switch (outcome.kind) {
      case 'off':
        return { outcome: 'off' }
      case 'shadow':
        return { outcome: 'shadow_queued', run_id: outcome.packId }
      case 'empty':
        return {
          outcome: 'empty',
          reason: outcome.reason,
          degraded_components: outcome.degradedComponents,
        }
      case 'ready':
        return {
          outcome: 'ready',
          pack: {
            pack_id: outcome.packId,
            stable_tokens: outcome.stableTokens,
            dynamic_tokens: outcome.dynamicTokens,
            item_count: outcome.itemCount,
          },
          admission_required: true,
        }
      case 'retrieval_failed':
        return { outcome: 'degraded', reason: 'retrieval_failed' }
      default:
        return { outcome: 'unsupported_adapter', effective_mode: 'shadow' }
    }
  })

  app.post('/api/v1/memory/context/packs/:packId/admit', async (req, reply) => {
    if (!gate(req, reply)) return
    const { packId } = req.params as { packId: string }
    const body = (req.body ?? {}) as {
      client_request_id?: unknown
      session_id?: unknown
      agent?: unknown
      adapter?: unknown
    }
    if (!UUID_RE.test(packId)
      || !boundedString(body.client_request_id, 128)
      || !boundedString(body.session_id, 64)
      || !boundedString(body.agent, 64)
      || typeof body.adapter !== 'string'
      || !['codex-app-server', 'opencode-server', 'claude-print-resume'].includes(body.adapter)) {
      throw new MemoryApiError('invalid_request', 'invalid admit body')
    }
    const grant = await daemonGuard(req.headers.authorization, body.session_id)
    if (grant.callerType !== 'daemon') {
      throw new MemoryApiError('forbidden', 'caller type not permitted')
    }
    const result = await deps.admission.admit({
      installationId: grant.installationId,
      sessionId: body.session_id,
      clientRequestId: body.client_request_id,
      packId,
      agent: body.agent,
      adapter: body.adapter,
      grantConfigVersion: grant.configVersion,
    })
    if (!result.ok) {
      reply.code(result.error === 'pack_not_ready' ? 404 : 409)
      return { error: { code: result.error } }
    }
    if ('existing' in result) {
      return { injection_id: result.injectionId, state: result.state, existing: true }
    }
    return {
      injection_id: result.injectionId,
      nonce: result.nonce,
      expires_at: result.expiresAt.toISOString(),
    }
  })

  app.get('/api/v1/memory/context/packs/:packId/text', async (req, reply) => {
    if (!gate(req, reply)) return
    const { packId } = req.params as { packId: string }
    const query = req.query as {
      session_id?: unknown
      injection_id?: unknown
      nonce?: unknown
    }
    if (!UUID_RE.test(packId)
      || typeof query.session_id !== 'string' || query.session_id.length === 0 || query.session_id.length > 64
      || typeof query.injection_id !== 'string' || !UUID_RE.test(query.injection_id)
      || typeof query.nonce !== 'string' || query.nonce.length === 0 || query.nonce.length > 128) {
      throw new MemoryApiError('invalid_request', 'invalid pack consume request')
    }
    const grant = await daemonGuard(req.headers.authorization, query.session_id)
    if (grant.callerType !== 'daemon') {
      throw new MemoryApiError('forbidden', 'caller type not permitted')
    }
    const result = await deps.admission.consume({
      installationId: grant.installationId,
      sessionId: query.session_id,
      packId,
      injectionId: query.injection_id,
      nonce: query.nonce,
    })
    if (!result.ok) {
      reply.code(result.error === 'expired' ? 410 : result.error === 'already_consumed' ? 409 : 404)
      return { error: { code: result.error } }
    }
    return {
      pack_id: result.pack.packId,
      stable_text: result.pack.stableText,
      dynamic_text: result.pack.dynamicText,
      stable_hash: result.pack.stableHash,
      dynamic_hash: result.pack.dynamicHash,
    }
  })

  app.post('/api/v1/memory/context/injections/:injectionId/receipt', async (req, reply) => {
    if (!gate(req, reply)) return
    const { injectionId } = req.params as { injectionId: string }
    const body = (req.body ?? {}) as { session_id?: unknown; delivered?: unknown; outcome_code?: unknown }
    if (!UUID_RE.test(injectionId)
      || typeof body.session_id !== 'string' || body.session_id.length === 0 || body.session_id.length > 64
      || typeof body.delivered !== 'boolean'
      || (body.outcome_code !== undefined
        && (typeof body.outcome_code !== 'string' || body.outcome_code.length > 64))) {
      throw new MemoryApiError('invalid_request', 'invalid receipt body')
    }
    const grant = await daemonGuard(req.headers.authorization, body.session_id)
    if (grant.callerType !== 'daemon') {
      throw new MemoryApiError('forbidden', 'caller type not permitted')
    }
    const result = await deps.admission.receipt({
      injectionId,
      installationId: grant.installationId,
      sessionId: body.session_id,
      delivered: body.delivered,
      outcomeCode: typeof body.outcome_code === 'string' ? body.outcome_code.slice(0, 64) : undefined,
    })
    if (!result.ok) {
      reply.code(404)
      return { error: { code: 'not_found' } }
    }
    return { state: result.state }
  })

  app.post('/api/v1/memory/context/injections/:injectionId/usage', async (req, reply) => {
    if (!gate(req, reply)) return
    const { injectionId } = req.params as { injectionId: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const counters = [body.input_tokens ?? 0, body.output_tokens ?? 0, body.cached_tokens ?? 0]
    if (!UUID_RE.test(injectionId)
      || typeof body.session_id !== 'string' || body.session_id.length === 0 || body.session_id.length > 64
      || counters.some(value => typeof value !== 'number' || !Number.isSafeInteger(value)
        || value < 0 || value > 1_000_000_000)) {
      throw new MemoryApiError('invalid_request', 'invalid usage body')
    }
    const grant = await daemonGuard(req.headers.authorization, body.session_id)
    if (grant.callerType !== 'daemon') {
      throw new MemoryApiError('forbidden', 'caller type not permitted')
    }
    const updated = await deps.pool.query(`
      UPDATE memory_context_injections
      SET usage_input_tokens = $3, usage_output_tokens = $4, usage_cached_tokens = $5
      WHERE injection_id = $1 AND installation_id = $2 AND session_id = $6
        AND state = 'delivered'
    `, [injectionId, grant.installationId,
      counters[0], counters[1], counters[2], body.session_id])
    if ((updated.rowCount ?? 0) === 0) {
      reply.code(404)
      return { error: { code: 'not_found' } }
    }
    return { accepted: true }
  })

  // ---- Management surface (memory.manage) ----

  app.get('/api/v1/memory/context/packs', async (req, reply) => {
    if (!gate(req, reply)) return
    const grant = await deps.guard.guard({
      authorization: req.headers.authorization,
      requiredService: 'memory.manage',
    })
    const query = req.query as { session_id?: string; page_size?: string; cursor?: string }
    const sessionId = typeof query.session_id === 'string' ? query.session_id : ''
    const pageSize = query.page_size === undefined ? 50 : Number(query.page_size)
    const cursor = decodePackCursor(query.cursor)
    if (!boundedString(sessionId, 64)
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50
      || (query.cursor !== undefined && cursor === null)) {
      throw new MemoryApiError('invalid_request', 'invalid session_id')
    }
    const rows = await deps.packs.listForSession({
      installationId: grant.installationId,
      sessionId,
      limit: pageSize + 1,
      beforeCreatedAt: cursor?.createdAt ?? null,
      beforePackId: cursor?.packId ?? null,
    })
    const page = rows.slice(0, pageSize)
    const injections = await deps.pool.query<{
      pack_id: string
      state: string
      outcome_code: string | null
    }>(`
      SELECT pack_id::text, state, outcome_code FROM memory_context_injections
      WHERE installation_id = $1 AND session_id = $2
    `, [grant.installationId, sessionId])
    const deliveryByPack = Object.fromEntries(injections.rows.map(row => [row.pack_id, row]))
    return {
      packs: page.map(row => ({
        ...row,
        delivery: deliveryByPack[row.pack_id] ?? null,
      })),
      next_cursor: rows.length > pageSize && page.length > 0
        ? encodePackCursor(page[page.length - 1]) : null,
    }
  })

  app.post('/api/v1/memory/context/feedback', { bodyLimit: 4096 }, async (req, reply) => {
    if (!gate(req, reply)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const grant = await deps.guard.guard({
      authorization: req.headers.authorization,
      requiredService: 'memory.manage',
    })
    if (typeof body.action !== 'string'
      || !['used', 'ignored', 'incorrect', 'harmful'].includes(body.action)
      || !optionalUuid(body.injection_id)
      || !optionalUuid(body.pack_id)
      || !optionalUuid(body.item_id)
      || (!body.injection_id && !body.pack_id)
      || !optionalBoundedString(body.reason_code, 64)) {
      throw new MemoryApiError('invalid_request', 'invalid feedback action')
    }
    const outcome = await mutation(req, grant.installationId, 'context_feedback', async transactionPool => {
      const result = await createFeedbackService({ pool: transactionPool }).submit({
        installationId: grant.installationId,
        injectionId: typeof body.injection_id === 'string' ? body.injection_id : null,
        packId: typeof body.pack_id === 'string' ? body.pack_id : null,
        itemId: typeof body.item_id === 'string' ? body.item_id : null,
        actor: 'user',
        action: body.action as 'used' | 'ignored' | 'incorrect' | 'harmful',
        reasonCode: typeof body.reason_code === 'string' ? body.reason_code : null,
      })
      return result.ok
        ? { ok: true, metadata: { feedback_id: result.feedbackId } }
        : { ok: false, error: result.error }
    })
    if (outcome.kind === 'conflict') {
      reply.code(409)
      return { error: { code: 'idempotency_conflict' } }
    }
    if (outcome.kind === 'failed') {
      reply.code(400)
      return { error: { code: String(outcome.error) } }
    }
    return outcome.metadata
  })

  app.get('/api/v1/memory/context/settings', async (req, reply) => {
    if (!gate(req, reply)) return
    const grant = await deps.guard.guard({
      authorization: req.headers.authorization,
      requiredService: 'memory.manage',
    })
    const rows = await deps.settings.list({ installationId: grant.installationId })
    return { settings: rows }
  })

  app.put('/api/v1/memory/context/settings', { bodyLimit: 4096 }, async (req, reply) => {
    if (!gate(req, reply)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const grant = await deps.guard.guard({
      authorization: req.headers.authorization,
      requiredService: 'memory.manage',
    })
    const scopeKeyValid = body.scope_kind === 'installation'
      ? body.scope_key === 'global'
      : body.scope_kind === 'repository'
        ? typeof body.scope_key === 'string' && UUID_RE.test(body.scope_key)
        : boundedString(body.scope_key, 64)
    if (typeof body.scope_kind !== 'string'
      || !['installation', 'repository', 'session'].includes(body.scope_kind)
      || !scopeKeyValid
      || typeof body.mode !== 'string'
      || !['off', 'shadow', 'enabled'].includes(body.mode)
      || !positiveRevision(body.expected_revision)
      || !optionalBoundedString(body.agent, 64)
      || (body.max_tokens !== undefined && body.max_tokens !== null
        && (typeof body.max_tokens !== 'number' || !Number.isSafeInteger(body.max_tokens)
          || body.max_tokens < 1 || body.max_tokens > 2_000))) {
      throw new MemoryApiError('invalid_request', 'invalid settings body')
    }
    const setting = {
      scopeKind: body.scope_kind as 'installation' | 'repository' | 'session',
      scopeKey: String(body.scope_key),
      agent: typeof body.agent === 'string' ? body.agent : null,
      mode: body.mode as ContextMode,
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
      expectedRevision: body.expected_revision as number,
    }
    const outcome = await mutation(req, grant.installationId, 'context_settings', async transactionPool => {
      const result = await createContextSettingsRepository(transactionPool).upsert({
        installationId: grant.installationId,
        ...setting,
      })
      if (result.ok) {
        await createInvalidationService({ pool: transactionPool }).onConfigurationChange({
          installationId: grant.installationId, reason: 'settings_changed',
        })
      }
      return result.ok
        ? { ok: true, metadata: { revision: result.revision } }
        : { ok: false, error: 'cas_conflict' }
    })
    if (outcome.kind === 'conflict' || outcome.kind === 'failed') {
      reply.code(409)
      return { error: { code: 'cas_conflict', current_revision: undefined } }
    }
    return outcome.metadata
  })

  app.get('/api/v1/memory/context/loadouts', async (req, reply) => {
    if (!gate(req, reply)) return
    const grant = await deps.guard.guard({
      authorization: req.headers.authorization, requiredService: 'memory.manage',
    })
    const query = req.query as { repository_id?: unknown; agent?: unknown }
    if (!optionalUuid(query.repository_id) || !optionalBoundedString(query.agent, 64)) {
      throw new MemoryApiError('invalid_request', 'invalid loadout query')
    }
    const resolved = await deps.loadouts.resolve({
      installationId: grant.installationId,
      repositoryId: query.repository_id ?? null,
      agent: query.agent ?? null,
    })
    return { revision: resolved.revision, items: resolved.items }
  })

  app.put('/api/v1/memory/context/loadouts', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    if (!gate(req, reply)) return
    const grant = await deps.guard.guard({
      authorization: req.headers.authorization, requiredService: 'memory.manage',
    })
    const body = (req.body ?? {}) as Record<string, unknown>
    const items = Array.isArray(body.items) ? body.items : []
    if (!positiveRevision(body.expected_revision)
      || !optionalUuid(body.repository_id)
      || !optionalBoundedString(body.agent, 64)
      || items.length > 20
      || items.some(item => typeof item !== 'object' || item === null)) {
      throw new MemoryApiError('invalid_request', 'invalid loadout body')
    }
    const parsed = items.map(item => item as Record<string, unknown>)
    const itemIds = new Set(parsed.map(item => item.item_id))
    if (itemIds.size !== parsed.length || parsed.some(item => {
      const claimAsset = ['claim', 'persona', 'runbook'].includes(String(item.asset_kind))
      const externalAsset = ['wiki', 'skill'].includes(String(item.asset_kind))
      return typeof item.item_id !== 'string' || !UUID_RE.test(item.item_id)
        || typeof item.asset_kind !== 'string' || (!claimAsset && !externalAsset)
        || typeof item.representation !== 'string'
        || !['summary', 'on_demand', 'reference'].includes(item.representation)
        || typeof item.priority !== 'number' || !Number.isSafeInteger(item.priority)
        || item.priority < 0 || item.priority > 100
        || (claimAsset && (typeof item.claim_id !== 'string' || !UUID_RE.test(item.claim_id)))
        || (externalAsset && !boundedString(item.external_asset_ref, 512))
    })) {
      throw new MemoryApiError('invalid_request', 'invalid loadout item')
    }
    const repositoryId = typeof body.repository_id === 'string' ? body.repository_id : null
    const agent = typeof body.agent === 'string' ? body.agent : null
    const expectedRevision = body.expected_revision as number
    const outcome = await mutation(req, grant.installationId, 'context_loadouts', async transactionPool => {
      const result = await createLoadoutRepository(transactionPool).replace({
        installationId: grant.installationId,
        repositoryId,
        agent,
        expectedRevision,
        items: parsed.map(item => ({
          itemId: String(item.item_id),
          assetKind: item.asset_kind as import('../context/types.js').LoadoutAssetKind,
          claimId: typeof item.claim_id === 'string' ? item.claim_id : null,
          externalAssetRef: typeof item.external_asset_ref === 'string' ? item.external_asset_ref : null,
          representation: item.representation as import('../context/types.js').LoadoutRepresentation,
          priority: Number(item.priority),
        })),
      })
      if (result.ok) {
        await createInvalidationService({ pool: transactionPool }).onConfigurationChange({
          installationId: grant.installationId, reason: 'loadout_changed',
        })
      }
      return result.ok
        ? { ok: true, metadata: { revision: result.revision } }
        : { ok: false, error: 'cas_conflict' }
    })
    if (outcome.kind === 'conflict' || outcome.kind === 'failed') {
      reply.code(409)
      return { error: { code: 'cas_conflict' } }
    }
    return outcome.metadata
  })
}
