import type { FastifyInstance } from 'fastify'

import type { TeamCollaborationConfig } from './config.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamRunService } from './run-service.js'
import type { TeamRunBudget } from './types.js'

interface Dependencies {
  config: TeamCollaborationConfig
  service: TeamRunService
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady?: () => boolean
}

type Reply = { code(status: number): unknown }

function fail(reply: Reply, status: number, code: string, message: string, retryable = false, currentRevision?: number) {
  reply.code(status)
  return { error: { code, message, retryable, ...(currentRevision === undefined ? {} : { current_revision: currentRevision }) } }
}

function mapError(error: unknown, reply: Reply) {
  if (!(error instanceof TeamRepositoryError)) throw error
  const status = error.code === 'team_not_found' ? 404
    : ['creator_required', 'participant_required'].includes(error.code) ? 403
      : error.code === 'agent_unavailable' ? 423
        : error.code === 'budget_exhausted' ? 400 : 409
  return fail(reply, status, error.code, error.message,
    ['revision_conflict', 'context_revision_conflict', 'agent_unavailable', 'dispatch_uncertain'].includes(error.code), error.currentRevision)
}

async function actor(authorization: string | undefined, reply: Reply, deps: Dependencies) {
  if (!authorization?.startsWith('Bearer ')) return { error: fail(reply, 401, 'authorization_required', 'Authorization required') }
  const payload = await deps.verifyAccessToken(authorization.slice(7).trim())
  return payload ?? { error: fail(reply, 401, 'invalid_token', 'Invalid token') }
}

function writable(reply: Reply, deps: Dependencies) {
  if ((deps.getDatabaseReady && !deps.getDatabaseReady()) || deps.config.collaboration !== 'on' || deps.config.autorun !== 'on') {
    return fail(reply, 503, 'team_feature_disabled', 'Team automatic collaboration writes are disabled', true)
  }
  return null
}

function body(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function mutation(value: unknown, reply: Reply, revision: boolean) {
  const parsed = body(value)
  if (!parsed) return { error: fail(reply, 400, 'invalid_request', 'JSON object body required') }
  if (['actor_user_id', 'author_user_id', 'owner_user_id', 'creator_user_id', 'initiator_user_id'].some(key => key in parsed)) {
    return { error: fail(reply, 400, 'invalid_request', 'client-supplied identity fields are not allowed') }
  }
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id.trim() : ''
  if (!requestId || requestId.length > 128) return { error: fail(reply, 400, 'invalid_request', 'valid request_id is required') }
  if (revision && (!Number.isSafeInteger(parsed.expected_revision) || Number(parsed.expected_revision) < 1)) {
    return { error: fail(reply, 400, 'invalid_request', 'expected_revision must be a positive integer') }
  }
  return { parsed, requestId, expectedRevision: revision ? Number(parsed.expected_revision) : 0 }
}

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

function parseBudget(value: unknown): Partial<TeamRunBudget> | null | undefined {
  if (value === undefined) return undefined
  const parsed = body(value)
  if (!parsed || Object.keys(parsed).some(key => !['max_calls', 'max_concurrent_calls', 'max_duration_seconds'].includes(key))) return null
  const result: Partial<TeamRunBudget> = {}
  for (const key of ['max_calls', 'max_concurrent_calls', 'max_duration_seconds'] as const) {
    if (parsed[key] !== undefined) {
      if (!Number.isSafeInteger(parsed[key])) return null
      result[key] = Number(parsed[key])
    }
  }
  return result
}

export function registerTeamRunRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/api/team/sessions/:sessionId/runs', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    try { return { runs: await deps.service.list(param(request.params, 'sessionId'), identity.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/sessions/:sessionId/runs', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
    const coordinatorOfferId = typeof parsed.parsed.coordinator_offer_id === 'string' ? parsed.parsed.coordinator_offer_id : ''
    const contextVersion = Number(parsed.parsed.context_version)
    const budget = parseBudget(parsed.parsed.budget)
    if (!coordinatorOfferId || !Number.isSafeInteger(contextVersion) || contextVersion < 1 || budget === null) {
      return fail(reply, 400, 'invalid_request', 'coordinator_offer_id, context_version, or budget is invalid')
    }
    try {
      const run = await deps.service.create({
        sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId,
        coordinatorOfferId, contextVersion, budget, requestId: parsed.requestId,
      })
      reply.code(201)
      return { run }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/runs/:runId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    try { return { run: await deps.service.get(param(request.params, 'runId'), identity.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.patch('/api/team/runs/:runId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, true); if ('error' in parsed) return parsed.error
    const action = parsed.parsed.action
    if (!['pause', 'resume', 'cancel'].includes(String(action))) return fail(reply, 400, 'invalid_request', 'action must be pause, resume, or cancel')
    try {
      return { run: await deps.service.control({
        runId: param(request.params, 'runId'), actorUserId: identity.userId,
        action: action as 'pause' | 'resume' | 'cancel', expectedRevision: parsed.expectedRevision, requestId: parsed.requestId,
      }) }
    } catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/runs/:runId/input', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, true); if ('error' in parsed) return parsed.error
    const content = typeof parsed.parsed.content === 'string' ? parsed.parsed.content.trim() : ''
    if (!content || content.length > 64_000) return fail(reply, 400, 'invalid_request', 'content is invalid')
    try {
      return { run: await deps.service.supplement({
        runId: param(request.params, 'runId'), actorUserId: identity.userId, content,
        expectedRevision: parsed.expectedRevision, requestId: parsed.requestId,
      }) }
    } catch (error) { return mapError(error, reply) }
  })
}
