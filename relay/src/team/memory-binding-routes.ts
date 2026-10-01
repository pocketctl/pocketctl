import type { FastifyInstance } from 'fastify'

import type { TeamCollaborationConfig } from './config.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamMemoryBinding } from './types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Reply = { code(status: number): unknown }

export interface TeamMemoryBindingRouteService {
  getBinding(teamId: string, actorUserId: number): Promise<TeamMemoryBinding | null>
  bind(input: {
    teamId: string
    actorUserId: number
    installationId: string
    expectedRevision: number
    requestId: string
  }): Promise<TeamMemoryBinding>
  remove(input: {
    teamId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<null>
}

export interface TeamMemoryBindingRouteDependencies {
  config: TeamCollaborationConfig
  memoryBridgeEnabled: boolean
  service: TeamMemoryBindingRouteService
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady?: () => boolean
}

function failure(reply: Reply, status: number, code: string, message: string, options: { retryable?: boolean; currentRevision?: number } = {}) {
  reply.code(status)
  return {
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.currentRevision === undefined ? {} : { current_revision: options.currentRevision }),
    },
  }
}

async function authenticate(
  authorization: string | undefined,
  reply: Reply,
  dependencies: TeamMemoryBindingRouteDependencies,
): Promise<{ userId: number } | { error: unknown }> {
  if (!authorization?.startsWith('Bearer ')) {
    return { error: failure(reply, 401, 'authorization_required', 'Authorization required') }
  }
  const token = authorization.slice('Bearer '.length).trim()
  const payload = token ? await dependencies.verifyAccessToken(token) : null
  return payload ?? { error: failure(reply, 401, 'invalid_token', 'Invalid token') }
}

function mapError(error: unknown, reply: Reply): unknown {
  if (!(error instanceof TeamRepositoryError)) throw error
  const status = {
    team_feature_disabled: 503,
    team_not_found: 404,
    team_access_denied: 403,
    membership_required: 403,
    participant_required: 403,
    creator_required: 403,
    offer_owner_required: 403,
    memory_grant_required: 403,
    invalid_state: 409,
    revision_conflict: 409,
    context_revision_conflict: 409,
    idempotency_conflict: 409,
    daemon_team_conflict: 409,
    agent_unavailable: 423,
    capability_not_supported: 422,
    no_callable_agent: 409,
    dispatch_uncertain: 202,
    budget_exhausted: 409,
  }[error.code]
  return failure(reply, status, error.code, error.message, {
    retryable: ['team_feature_disabled', 'revision_conflict'].includes(error.code),
    currentRevision: error.currentRevision,
  })
}

function teamId(params: unknown): string {
  const value = (params as Record<string, unknown> | null)?.teamId
  return typeof value === 'string' ? value : ''
}

function parseMutation(body: unknown, reply: Reply, allowZeroRevision: boolean): {
  body: Record<string, unknown>
  requestId: string
  expectedRevision: number
} | { error: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: failure(reply, 400, 'invalid_request', 'JSON object body required') }
  }
  const parsed = body as Record<string, unknown>
  if (['actor_user_id', 'user_id', 'team_id', 'owner_scope_id', 'owner_scope_kind'].some(key => key in parsed)) {
    return { error: failure(reply, 400, 'invalid_request', 'client-supplied actor, Team, or owner scope fields are not allowed') }
  }
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id.trim() : ''
  if (!requestId || requestId.length > 128) {
    return { error: failure(reply, 400, 'invalid_request', 'request_id is required and must be at most 128 characters') }
  }
  if (!Number.isSafeInteger(parsed.expected_revision)
    || Number(parsed.expected_revision) < (allowZeroRevision ? 0 : 1)) {
    return { error: failure(reply, 400, 'invalid_request', `expected_revision must be ${allowZeroRevision ? 'a non-negative' : 'a positive'} integer`) }
  }
  return { body: parsed, requestId, expectedRevision: Number(parsed.expected_revision) }
}

function requireDatabase(reply: Reply, dependencies: TeamMemoryBindingRouteDependencies): unknown | null {
  if (dependencies.getDatabaseReady && !dependencies.getDatabaseReady()) {
    return failure(reply, 503, 'team_feature_disabled', 'Team storage is initializing', { retryable: true })
  }
  return null
}

function requireTeamWrites(reply: Reply, dependencies: TeamMemoryBindingRouteDependencies): unknown | null {
  const database = requireDatabase(reply, dependencies)
  if (database) return database
  if (dependencies.config.collaboration !== 'on') {
    return failure(reply, 503, 'team_feature_disabled', 'Team collaboration writes are disabled', { retryable: true })
  }
  return null
}

export function registerTeamMemoryBindingRoutes(
  app: FastifyInstance,
  dependencies: TeamMemoryBindingRouteDependencies,
): void {
  app.get('/api/team/teams/:teamId/memory-binding', async (request, reply) => {
    const database = requireDatabase(reply, dependencies)
    if (database) return database
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    try {
      return { binding: await dependencies.service.getBinding(teamId(request.params), actor.userId) }
    } catch (error) {
      return mapError(error, reply)
    }
  })

  app.put('/api/team/teams/:teamId/memory-binding', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireTeamWrites(reply, dependencies)
    if (disabled) return disabled
    if (!dependencies.memoryBridgeEnabled) {
      return failure(reply, 503, 'team_feature_disabled', 'Team Memory bridge is disabled', { retryable: true })
    }
    const parsed = parseMutation(request.body, reply, true)
    if ('error' in parsed) return parsed.error
    const installationId = parsed.body.installation_id
    if (typeof installationId !== 'string' || !UUID_PATTERN.test(installationId)) {
      return failure(reply, 400, 'invalid_request', 'installation_id must be a UUID')
    }
    try {
      return {
        binding: await dependencies.service.bind({
          teamId: teamId(request.params),
          actorUserId: actor.userId,
          installationId,
          expectedRevision: parsed.expectedRevision,
          requestId: parsed.requestId,
        }),
      }
    } catch (error) {
      return mapError(error, reply)
    }
  })

  app.delete('/api/team/teams/:teamId/memory-binding', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireTeamWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply, false)
    if ('error' in parsed) return parsed.error
    try {
      await dependencies.service.remove({
        teamId: teamId(request.params),
        actorUserId: actor.userId,
        expectedRevision: parsed.expectedRevision,
        requestId: parsed.requestId,
      })
      return { binding: null }
    } catch (error) {
      return mapError(error, reply)
    }
  })
}
