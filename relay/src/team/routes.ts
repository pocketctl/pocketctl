import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import type { TeamAgentCandidate } from './agent-offers.js'
import type { TeamCollaborationConfig } from './config.js'
import {
  TeamRepository,
  TeamRepositoryError,
  type CollaborationAgentOfferView,
  type CollaborationInvitationView,
  type CollaborationMembershipView,
  type CollaborationTeamView,
} from './repository.js'
import type { TeamProvider } from './types.js'

export interface TeamRouteService {
  listTeams(actorUserId: number): Promise<CollaborationTeamView[]>
  getTeam(teamId: string, actorUserId: number): Promise<CollaborationTeamView>
  createTeam(input: { actorUserId: number; name: string; requestId: string }): Promise<unknown>
  renameTeam(input: { teamId: string; actorUserId: number; name: string; expectedRevision: number; requestId: string }): Promise<CollaborationTeamView>
  listMembers(teamId: string, actorUserId: number): Promise<CollaborationMembershipView[]>
  invite(input: { teamId: string; actorUserId: number; email: string; expectedRevision: number; requestId: string }): Promise<CollaborationInvitationView>
  listInvitations(teamId: string, actorUserId: number): Promise<CollaborationInvitationView[]>
  listMyInvitations(actorUserId: number): Promise<CollaborationInvitationView[]>
  respondToInvitation(input: { invitationId: string; actorUserId: number; action: 'accepted' | 'declined'; expectedRevision: number; requestId: string }): Promise<unknown>
  revokeInvitation(input: { invitationId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<CollaborationInvitationView>
  leaveTeam(input: { teamId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<CollaborationMembershipView>
  removeMember(input: { teamId: string; membershipId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<CollaborationMembershipView>
  dissolveTeam(input: { teamId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<CollaborationTeamView>
  listAgentCandidates(teamId: string, actorUserId: number): Promise<TeamAgentCandidate[]>
  listMyAgentCandidates?(actorUserId: number): Promise<TeamAgentCandidate[]>
  listAgentOffers(teamId: string, actorUserId: number): Promise<CollaborationAgentOfferView[]>
  addAgentOffer(input: { teamId: string; actorUserId: number; daemonId: string; provider: TeamProvider; runtimeProfileId: string | null; expectedRevision: number; requestId: string }): Promise<CollaborationAgentOfferView>
  revokeAgentOffer(input: { offerId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<CollaborationAgentOfferView>
}

export interface TeamRouteDependencies {
  config: TeamCollaborationConfig
  service: TeamRouteService
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady?: () => boolean
  revalidateTeamSubscriptions?: () => Promise<void>
}

type Reply = { code(status: number): unknown }

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

async function authenticate(authorization: string | undefined, reply: Reply, dependencies: TeamRouteDependencies): Promise<{ userId: number } | { error: unknown }> {
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
  const retryable = ['team_feature_disabled', 'revision_conflict', 'context_revision_conflict', 'daemon_team_conflict', 'agent_unavailable', 'no_callable_agent'].includes(error.code)
  return failure(reply, status, error.code, error.message, { retryable, currentRevision: error.currentRevision })
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

function parseMutation(body: unknown, reply: Reply, revisionRequired = true): { requestId: string; expectedRevision: number; body: Record<string, unknown> } | { error: unknown } {
  const parsed = bodyObject(body)
  if (!parsed) return { error: failure(reply, 400, 'invalid_request', 'JSON object body required') }
  if ('actor_user_id' in parsed || 'owner_user_id' in parsed || 'user_id' in parsed) {
    return { error: failure(reply, 400, 'invalid_request', 'client-supplied actor or owner fields are not allowed') }
  }
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id.trim() : ''
  if (!requestId || requestId.length > 128) {
    return { error: failure(reply, 400, 'invalid_request', 'request_id is required and must be at most 128 characters') }
  }
  const expectedRevision = parsed.expected_revision
  if (revisionRequired && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)) {
    return { error: failure(reply, 400, 'invalid_request', 'expected_revision must be a positive integer') }
  }
  return { requestId, expectedRevision: revisionRequired ? Number(expectedRevision) : 0, body: parsed }
}

function pathId(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

function requireWrites(reply: Reply, dependencies: TeamRouteDependencies): unknown | null {
  if (dependencies.getDatabaseReady && !dependencies.getDatabaseReady()) {
    return failure(reply, 503, 'team_feature_disabled', 'Team storage is initializing', { retryable: true })
  }
  if (dependencies.config.collaboration !== 'on') {
    return failure(reply, 503, 'team_feature_disabled', 'Team collaboration writes are disabled', { retryable: true })
  }
  return null
}

async function actorForRead(request: { headers: { authorization?: string } }, reply: Reply, dependencies: TeamRouteDependencies) {
  if (dependencies.getDatabaseReady && !dependencies.getDatabaseReady()) {
    return { error: failure(reply, 503, 'team_feature_disabled', 'Team storage is initializing', { retryable: true }) }
  }
  return authenticate(request.headers.authorization, reply, dependencies)
}

export function registerTeamRoutes(app: FastifyInstance, dependencies: TeamRouteDependencies): void {
  app.get('/api/team/teams', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    return { teams: await dependencies.service.listTeams(actor.userId) }
  })

  app.post('/api/team/teams', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply, false)
    if ('error' in parsed) return parsed.error
    const name = typeof parsed.body.name === 'string' ? parsed.body.name.trim() : ''
    if (!name || name.length > 120) return failure(reply, 400, 'invalid_request', 'name must be 1 to 120 characters')
    try {
      const result = await dependencies.service.createTeam({ actorUserId: actor.userId, name, requestId: parsed.requestId })
      reply.code(201)
      return result
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/teams/:teamId', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    try { return { team: await dependencies.service.getTeam(pathId(request.params, 'teamId'), actor.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.patch('/api/team/teams/:teamId', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    const name = typeof parsed.body.name === 'string' ? parsed.body.name.trim() : ''
    if (!name || name.length > 120) return failure(reply, 400, 'invalid_request', 'name must be 1 to 120 characters')
    try {
      return { team: await dependencies.service.renameTeam({ teamId: pathId(request.params, 'teamId'), actorUserId: actor.userId, name, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) }
    } catch (error) { return mapError(error, reply) }
  })

  app.delete('/api/team/teams/:teamId', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    try {
      const team = await dependencies.service.dissolveTeam({ teamId: pathId(request.params, 'teamId'), actorUserId: actor.userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId })
      await dependencies.revalidateTeamSubscriptions?.()
      return { team }
    } catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/teams/:teamId/leave', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    try {
      const membership = await dependencies.service.leaveTeam({ teamId: pathId(request.params, 'teamId'), actorUserId: actor.userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId })
      await dependencies.revalidateTeamSubscriptions?.()
      return { membership }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/teams/:teamId/members', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    try { return { members: await dependencies.service.listMembers(pathId(request.params, 'teamId'), actor.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.delete('/api/team/teams/:teamId/members/:membershipId', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    try {
      const membership = await dependencies.service.removeMember({
        teamId: pathId(request.params, 'teamId'), membershipId: pathId(request.params, 'membershipId'),
        actorUserId: actor.userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId,
      })
      await dependencies.revalidateTeamSubscriptions?.()
      return { membership }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/invitations', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    return { invitations: await dependencies.service.listMyInvitations(actor.userId) }
  })

  app.get('/api/team/teams/:teamId/invitations', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    try { return { invitations: await dependencies.service.listInvitations(pathId(request.params, 'teamId'), actor.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/teams/:teamId/invitations', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    const email = typeof parsed.body.email === 'string' ? parsed.body.email.trim() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) return failure(reply, 400, 'invalid_request', 'valid email is required')
    try {
      const invitation = await dependencies.service.invite({ teamId: pathId(request.params, 'teamId'), actorUserId: actor.userId, email, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId })
      reply.code(201)
      return { invitation }
    } catch (error) { return mapError(error, reply) }
  })

  for (const action of ['accept', 'decline'] as const) {
    app.post(`/api/team/invitations/:invitationId/${action}`, async (request, reply) => {
      const actor = await authenticate(request.headers.authorization, reply, dependencies)
      if ('error' in actor) return actor.error
      const disabled = requireWrites(reply, dependencies)
      if (disabled) return disabled
      const parsed = parseMutation(request.body, reply)
      if ('error' in parsed) return parsed.error
      try {
        return await dependencies.service.respondToInvitation({ invitationId: pathId(request.params, 'invitationId'), actorUserId: actor.userId, action: action === 'accept' ? 'accepted' : 'declined', expectedRevision: parsed.expectedRevision, requestId: parsed.requestId })
      } catch (error) { return mapError(error, reply) }
    })
  }

  app.delete('/api/team/invitations/:invitationId', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    try {
      return { invitation: await dependencies.service.revokeInvitation({ invitationId: pathId(request.params, 'invitationId'), actorUserId: actor.userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/teams/:teamId/agent-candidates', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    try { return { agents: await dependencies.service.listAgentCandidates(pathId(request.params, 'teamId'), actor.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/agent-candidates', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    if (!dependencies.service.listMyAgentCandidates) {
      return failure(reply, 503, 'team_feature_disabled', 'Agent candidate discovery is unavailable', { retryable: true })
    }
    return { agents: await dependencies.service.listMyAgentCandidates(actor.userId) }
  })

  app.get('/api/team/teams/:teamId/agent-offers', async (request, reply) => {
    const actor = await actorForRead(request, reply, dependencies)
    if ('error' in actor) return actor.error
    try { return { offers: await dependencies.service.listAgentOffers(pathId(request.params, 'teamId'), actor.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/teams/:teamId/agent-offers', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    const daemonId = typeof parsed.body.daemon_id === 'string' ? parsed.body.daemon_id.trim() : ''
    const provider = parsed.body.provider
    const runtimeProfileId = parsed.body.runtime_profile_id === undefined || parsed.body.runtime_profile_id === null
      ? null
      : typeof parsed.body.runtime_profile_id === 'string' ? parsed.body.runtime_profile_id.trim() : undefined
    if (!daemonId || daemonId.length > 64 || (provider !== 'codex' && provider !== 'claude-code') || runtimeProfileId === undefined || (runtimeProfileId?.length ?? 0) > 255) {
      return failure(reply, 400, 'invalid_request', 'valid daemon_id, provider, and runtime_profile_id are required')
    }
    try {
      const offer = await dependencies.service.addAgentOffer({ teamId: pathId(request.params, 'teamId'), actorUserId: actor.userId, daemonId, provider, runtimeProfileId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId })
      reply.code(201)
      return { offer }
    } catch (error) { return mapError(error, reply) }
  })

  app.delete('/api/team/agent-offers/:offerId', async (request, reply) => {
    const actor = await authenticate(request.headers.authorization, reply, dependencies)
    if ('error' in actor) return actor.error
    const disabled = requireWrites(reply, dependencies)
    if (disabled) return disabled
    const parsed = parseMutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    try {
      return { offer: await dependencies.service.revokeAgentOffer({ offerId: pathId(request.params, 'offerId'), actorUserId: actor.userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) }
    } catch (error) { return mapError(error, reply) }
  })
}

export function createTeamRouteService(pool: pg.Pool): TeamRouteService {
  return new TeamRepository(pool)
}
