import type { FastifyInstance } from 'fastify'

import type { TeamCollaborationConfig } from './config.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamSessionService } from './session-service.js'
import type { TeamContextService } from './context-service.js'
import type { TeamContextReference, TeamMessageTargetMode, TeamProvider, TeamSessionState } from './types.js'

interface Dependencies {
  config: TeamCollaborationConfig
  service: TeamSessionService
  contextService?: TeamContextService
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
    : ['creator_required', 'participant_required', 'offer_owner_required'].includes(error.code) ? 403
      : error.code === 'agent_unavailable' ? 423 : 409
  return fail(reply, status, error.code, error.message,
    ['revision_conflict', 'context_revision_conflict', 'agent_unavailable', 'no_callable_agent'].includes(error.code), error.currentRevision)
}
async function actor(authorization: string | undefined, reply: Reply, deps: Dependencies) {
  if (!authorization?.startsWith('Bearer ')) return { error: fail(reply, 401, 'authorization_required', 'Authorization required') }
  const payload = await deps.verifyAccessToken(authorization.slice(7).trim())
  return payload ?? { error: fail(reply, 401, 'invalid_token', 'Invalid token') }
}
function writable(reply: Reply, deps: Dependencies) {
  if ((deps.getDatabaseReady && !deps.getDatabaseReady()) || deps.config.collaboration !== 'on') return fail(reply, 503, 'team_feature_disabled', 'Team collaboration writes are disabled', true)
  return null
}
function body(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function mutation(value: unknown, reply: Reply, revision = true) {
  const parsed = body(value)
  if (!parsed) return { error: fail(reply, 400, 'invalid_request', 'JSON object body required') }
  if (['actor_user_id', 'author_user_id', 'owner_user_id', 'creator_user_id'].some(key => key in parsed)) return { error: fail(reply, 400, 'invalid_request', 'client-supplied identity fields are not allowed') }
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id.trim() : ''
  if (!requestId || requestId.length > 128) return { error: fail(reply, 400, 'invalid_request', 'valid request_id is required') }
  if (revision && (!Number.isSafeInteger(parsed.expected_revision) || Number(parsed.expected_revision) < 1)) return { error: fail(reply, 400, 'invalid_request', 'expected_revision must be a positive integer') }
  return { parsed, requestId, expectedRevision: revision ? Number(parsed.expected_revision) : 0 }
}
function param(params: unknown, key: string) {
  const value = (params as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

export function registerTeamSessionRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.get('/api/team/teams/:teamId/sessions', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const query = request.query as { daemon_id?: string; provider?: string } | null
    const provider = query?.provider === 'codex' || query?.provider === 'claude-code' ? query.provider as TeamProvider : undefined
    try { return { sessions: await deps.service.listSessions(param(request.params, 'teamId'), identity.userId, { daemonId: query?.daemon_id, provider }) } }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/teams/:teamId/sessions', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
    const title = typeof parsed.parsed.title === 'string' ? parsed.parsed.title.trim() : ''
    const taskId = parsed.parsed.task_id === undefined || parsed.parsed.task_id === null ? null : typeof parsed.parsed.task_id === 'string' ? parsed.parsed.task_id : undefined
    const offerIds = Array.isArray(parsed.parsed.offer_ids) ? parsed.parsed.offer_ids.filter((id): id is string => typeof id === 'string') : []
    if (!title || title.length > 240 || taskId === undefined || offerIds.length === 0 || offerIds.length > 16) return fail(reply, 400, 'invalid_request', 'title, task_id, or offer_ids is invalid')
    try {
      const session = await deps.service.createSession({ teamId: param(request.params, 'teamId'), actorUserId: identity.userId, title, taskId, offerIds: [...new Set(offerIds)], requestId: parsed.requestId })
      reply.code(201); return { session }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/sessions/:sessionId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    try { return { session: await deps.service.getSession(param(request.params, 'sessionId'), identity.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.patch('/api/team/sessions/:sessionId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
    const title = parsed.parsed.title === undefined ? undefined : typeof parsed.parsed.title === 'string' ? parsed.parsed.title.trim() : null
    const state = parsed.parsed.state as TeamSessionState | undefined
    if ((title !== undefined && (!title || title.length > 240)) || (state !== undefined && !['active', 'paused', 'ended', 'archived'].includes(state)) || (title === undefined && state === undefined)) return fail(reply, 400, 'invalid_request', 'session update is invalid')
    try { return { session: await deps.service.updateSession({ sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, ...(title === undefined ? {} : { title }), ...(state === undefined ? {} : { state }), expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) } }
    catch (error) { return mapError(error, reply) }
  })

  for (const active of [true, false]) {
    const method = active ? 'put' : 'delete'
    app[method]('/api/team/sessions/:sessionId/participants/:userId', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const disabled = writable(reply, deps); if (disabled) return disabled
      const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
      const userId = Number(param(request.params, 'userId')); if (!Number.isSafeInteger(userId) || userId < 1) return fail(reply, 400, 'invalid_request', 'valid userId is required')
      const input = { sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }
      try { return { session: active ? await deps.service.addParticipant(input) : await deps.service.removeParticipant(input) } }
      catch (error) { return mapError(error, reply) }
    })
    app[method]('/api/team/sessions/:sessionId/agent-bindings/:offerId', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const disabled = writable(reply, deps); if (disabled) return disabled
      const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
      try { return { session: await deps.service.changeBinding({ sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, offerId: param(request.params, 'offerId'), active, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) } }
      catch (error) { return mapError(error, reply) }
    })
  }

  app.get('/api/team/sessions/:sessionId/events', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const query = request.query as { after_seq?: string; limit?: string } | null
    const afterSeq = Math.max(0, Number.parseInt(query?.after_seq ?? '0', 10) || 0)
    const limit = Math.min(100, Math.max(1, Number.parseInt(query?.limit ?? '50', 10) || 50))
    try { return await deps.service.listEvents(param(request.params, 'sessionId'), identity.userId, afterSeq, limit) }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/sessions/:sessionId/events', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
    const content = typeof parsed.parsed.content === 'string' ? parsed.parsed.content.trim() : ''
    const targetMode = parsed.parsed.target_mode as TeamMessageTargetMode
    const targetOfferIds = Array.isArray(parsed.parsed.target_offer_ids) ? parsed.parsed.target_offer_ids.filter((id): id is string => typeof id === 'string') : []
    const referenceEventId = parsed.parsed.reference_event_id === undefined || parsed.parsed.reference_event_id === null ? null : typeof parsed.parsed.reference_event_id === 'string' ? parsed.parsed.reference_event_id : undefined
    if (!content || content.length > 64_000 || !['offers', 'all', 'discussion'].includes(targetMode) || referenceEventId === undefined) return fail(reply, 400, 'invalid_request', 'message content or targets are invalid')
    try {
      const result = await deps.service.appendMessage({ sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, requestId: parsed.requestId, content, targetMode, targetOfferIds, referenceEventId })
      reply.code(201); return result
    } catch (error) { return mapError(error, reply) }
  })

  if (deps.contextService) {
    app.get('/api/team/sessions/:sessionId/context', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const rawVersion = (request.query as { version?: string } | null)?.version
      const version = rawVersion === undefined ? undefined : Number.parseInt(rawVersion, 10)
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) return fail(reply, 400, 'invalid_request', 'version must be a positive integer')
      try { return { context: await deps.contextService!.get(param(request.params, 'sessionId'), identity.userId, version) } }
      catch (error) { return mapError(error, reply) }
    })

    app.post('/api/team/sessions/:sessionId/context', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const disabled = writable(reply, deps); if (disabled) return disabled
      const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
      const expectedRevision = Number(parsed.parsed.expected_revision)
      const goal = typeof parsed.parsed.goal === 'string' ? parsed.parsed.goal.trim() : ''
      const consensus = Array.isArray(parsed.parsed.consensus) && parsed.parsed.consensus.every(item => typeof item === 'string')
        ? (parsed.parsed.consensus as string[]).map(item => item.trim()).filter(Boolean) : null
      const openQuestions = Array.isArray(parsed.parsed.open_questions) && parsed.parsed.open_questions.every(item => typeof item === 'string')
        ? (parsed.parsed.open_questions as string[]).map(item => item.trim()).filter(Boolean) : null
      const rawReferences = Array.isArray(parsed.parsed.references) ? parsed.parsed.references : null
      const references: TeamContextReference[] | null = rawReferences?.every(reference => {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return false
        const value = reference as Record<string, unknown>
        return value.source_kind === 'team_event' && typeof value.source_id === 'string' && typeof value.source_version === 'string'
          && value.owner_scope_id === null && value.installation_id === null
      }) ? rawReferences as TeamContextReference[] : null
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !goal || goal.length > 16_000
        || !consensus || consensus.length > 50 || consensus.some(item => item.length > 4_000)
        || !openQuestions || openQuestions.length > 50 || openQuestions.some(item => item.length > 4_000)
        || !references || references.length > 100) {
        return fail(reply, 400, 'invalid_request', 'context payload is invalid')
      }
      try {
        const result = await deps.contextService!.create({
          sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId,
          expectedRevision, requestId: parsed.requestId, goal, consensus, openQuestions, references,
        })
        reply.code(201); return result
      } catch (error) { return mapError(error, reply) }
    })
  }
}
