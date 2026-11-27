import {MEMORY_USAGE_OPERATIONS} from './memory-usage-contract.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { ExtensionMode } from './types.js'
import { ExtensionApiError } from './errors.js'
import { verifyProviderExtensionToken } from './provider-auth.js'
import { extensionUsageIngested } from '../metrics.js'

export interface UsageRouteDeps {
  pool: pg.Pool
  mode: ExtensionMode
  providerJwtSecret: string
  issuer: string
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  rateLimiter?: { check(key: string): { allowed: boolean; retryAfterMs?: number } }
}

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USAGE_OPERATIONS: readonly string[] = MEMORY_USAGE_OPERATIONS
const MAX_BATCH = 100
const MAX_USAGE_ID_LENGTH = 128
const MAX_MODEL_LENGTH = 128
const FUTURE_SKEW_SECONDS = 300

interface UsageFactInput {
  usage_id: string
  operation: string
  model?: string | null
  input_tokens: number
  output_tokens: number
  embedding_tokens: number
  cached_tokens: number
  cost_micros: number
  occurred_at: string
}

function fail(reply: { code: (status: number) => unknown }, error: ExtensionApiError) {
  reply.code(error.httpStatus)
  // Server-controlled details nest inside the envelope.
  return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } }
}

function parseFact(raw: unknown): UsageFactInput | ExtensionApiError {
  if (!raw || typeof raw !== 'object') {
    return new ExtensionApiError('invalid_request', 'each usage fact must be an object')
  }
  const fact = raw as Record<string, unknown>
  if (typeof fact.usage_id !== 'string' || fact.usage_id.length === 0
    || fact.usage_id.length > MAX_USAGE_ID_LENGTH) {
    return new ExtensionApiError('invalid_request', 'usage_id must be a bounded string')
  }
  if (typeof fact.operation !== 'string' || !USAGE_OPERATIONS.includes(fact.operation)) {
    return new ExtensionApiError('invalid_request', 'operation is outside the allowlist')
  }
  if (fact.model !== undefined && fact.model !== null
    && (typeof fact.model !== 'string' || fact.model.length > MAX_MODEL_LENGTH)) {
    return new ExtensionApiError('invalid_request', 'model must be a bounded string')
  }
  const counters: Record<string, number> = {}
  for (const key of ['input_tokens', 'output_tokens', 'embedding_tokens', 'cached_tokens', 'cost_micros']) {
    const value = fact[key] ?? 0
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return new ExtensionApiError('invalid_request', `${key} must be a non-negative integer`)
    }
    counters[key] = value
  }
  if (typeof fact.occurred_at !== 'string') {
    return new ExtensionApiError('invalid_request', 'occurred_at required')
  }
  const occurredAt = new Date(fact.occurred_at)
  if (Number.isNaN(occurredAt.getTime())) {
    return new ExtensionApiError('invalid_request', 'occurred_at must be an ISO timestamp')
  }
  if (occurredAt.getTime() > Date.now() + FUTURE_SKEW_SECONDS * 1000) {
    return new ExtensionApiError('invalid_request', 'occurred_at is significantly in the future')
  }
  return {
    usage_id: fact.usage_id,
    operation: fact.operation,
    model: typeof fact.model === 'string' ? fact.model : null,
    input_tokens: counters.input_tokens,
    output_tokens: counters.output_tokens,
    embedding_tokens: counters.embedding_tokens,
    cached_tokens: counters.cached_tokens,
    cost_micros: counters.cost_micros,
    occurred_at: fact.occurred_at,
  }
}

/**
 * Immutable, idempotent provider usage facts. They are completely separate
 * from the agent-session token_usage_facts ledger.
 */
export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): void {
  app.post('/api/extensions/v1/usage/batch', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`usage:${String(req.ip ?? '-')}`)
      if (!decision.allowed) {
        reply.code(429)
        return { error: { code: 'invalid_request', message: 'rate limit exceeded' } }
      }
    }
    if (deps.mode !== 'enabled') {
      return fail(reply, new ExtensionApiError('feature_disabled', 'usage requires RELAY_EXTENSIONS=enabled'))
    }
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    }
    const identity = verifyProviderExtensionToken(header.slice(7), {
      secret: deps.providerJwtSecret,
      issuer: deps.issuer,
    })
    if (!identity) return fail(reply, new ExtensionApiError('unauthorized', 'provider token required'))
    const body = req.body as Record<string, unknown> | null
    const installationId = typeof body?.installation_id === 'string' ? body.installation_id : ''
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return fail(reply, new ExtensionApiError('invalid_request', 'installation_id required'))
    }
    const facts = body?.facts
    if (!Array.isArray(facts) || facts.length === 0 || facts.length > MAX_BATCH) {
      return fail(reply, new ExtensionApiError('invalid_request', `facts must be a list of at most ${MAX_BATCH}`))
    }
    const parsed: UsageFactInput[] = []
    const seen = new Set<string>()
    for (const raw of facts) {
      const fact = parseFact(raw)
      if (fact instanceof ExtensionApiError) return fail(reply, fact)
      if (seen.has(fact.usage_id)) {
        return fail(reply, new ExtensionApiError('invalid_request', 'duplicate usage_id in batch'))
      }
      seen.add(fact.usage_id)
      parsed.push(fact)
    }

    const guard = await deps.pool.query(
      `SELECT 1 FROM extension_installations
       WHERE installation_id = $1 AND provider_id = $2
         AND status IN ('pending', 'active', 'paused')`,
      [installationId, identity.providerId],
    )
    if ((guard.rowCount ?? 0) === 0) {
      return fail(reply, new ExtensionApiError('not_found', 'installation not found'))
    }
    // Duplicates collapse through ON CONFLICT; rowCount 0 means idempotent
    // replay, not a missing installation.
    const result = await deps.pool.query<{ operation: string }>(
      `INSERT INTO extension_provider_usage_facts
         (installation_id, usage_id, operation, model, input_tokens, output_tokens,
          embedding_tokens, cached_tokens, cost_micros, occurred_at)
       SELECT $1, (f->>'usage_id'), f->>'operation', NULLIF(f->>'model',''),
              (f->>'input_tokens')::bigint, (f->>'output_tokens')::bigint,
              (f->>'embedding_tokens')::bigint, (f->>'cached_tokens')::bigint,
              (f->>'cost_micros')::bigint, (f->>'occurred_at')::timestamptz
       FROM jsonb_array_elements($2::jsonb) AS t(f)
       ON CONFLICT (installation_id, usage_id) DO NOTHING
       RETURNING operation`,
      [installationId, JSON.stringify(parsed)],
    )
    // The counter reflects rows actually inserted (RETURNING), so ON
    // CONFLICT duplicates are neither over- nor under-counted.
    const insertedByOperation = new Map<string, number>()
    for (const row of result.rows) {
      insertedByOperation.set(row.operation, (insertedByOperation.get(row.operation) ?? 0) + 1)
    }
    for (const [operation, count] of insertedByOperation) {
      extensionUsageIngested.inc({ operation, result: 'ingested' }, count)
    }
    const ingested=result.rowCount??0
    if(ingested<parsed.length) {
      // A fresh statement sees rows inserted by a concurrent transaction that
      // won the unique key. Compare every immutable field before issuing ACKs.
      const verified=await deps.pool.query(`SELECT f.usage_id FROM jsonb_to_recordset($2::jsonb)
        AS f(usage_id text,operation text,model text,input_tokens bigint,output_tokens bigint,
             embedding_tokens bigint,cached_tokens bigint,cost_micros bigint,occurred_at timestamptz)
        JOIN extension_provider_usage_facts u ON u.installation_id=$1 AND u.usage_id=f.usage_id
          AND (u.operation,u.model,u.input_tokens,u.output_tokens,u.embedding_tokens,u.cached_tokens,u.cost_micros,u.occurred_at)
          IS NOT DISTINCT FROM (f.operation,NULLIF(f.model,''),f.input_tokens,f.output_tokens,f.embedding_tokens,f.cached_tokens,f.cost_micros,f.occurred_at)`,
        [installationId,JSON.stringify(parsed)])
      if(verified.rowCount!==parsed.length) return fail(reply,new ExtensionApiError('revision_conflict','usage identity does not match the recorded fact'))
    }
    return {installation_id:installationId,ingested,acknowledged_usage_ids:parsed.map(f=>f.usage_id)}
  })

  // User summary: aggregates per installation and operation. No row-level
  // content is exposed.
  app.get('/api/extensions/v1/usage', async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return fail(reply, new ExtensionApiError('unauthorized', 'authorization required'))
    }
    const payload = await deps.verifyAccessToken(header.slice(7))
    if (!payload) return fail(reply, new ExtensionApiError('unauthorized', 'invalid token'))
    const result = await deps.pool.query(
      `SELECT i.installation_id, i.provider_id, f.operation,
              SUM(f.input_tokens)::text AS input_tokens,
              SUM(f.output_tokens)::text AS output_tokens,
              SUM(f.embedding_tokens)::text AS embedding_tokens,
              SUM(f.cached_tokens)::text AS cached_tokens,
              SUM(f.cost_micros)::text AS cost_micros,
              COUNT(*)::text AS facts
       FROM extension_installations i
       JOIN extension_provider_usage_facts f ON f.installation_id = i.installation_id
       WHERE i.owner_user_id = $1
       GROUP BY i.installation_id, i.provider_id, f.operation
       ORDER BY i.installation_id, f.operation`,
      [payload.userId],
    )
    return { usage: result.rows }
  })
}
