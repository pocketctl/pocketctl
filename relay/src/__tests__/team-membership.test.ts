import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { candidateForProvider } from '../team/agent-offers.js'
import { resolveTeamCollaborationConfig } from '../team/config.js'
import { TeamRepositoryError } from '../team/repository.js'
import { registerTeamRoutes, type TeamRouteService } from '../team/routes.js'

function service(overrides: Partial<TeamRouteService> = {}): TeamRouteService {
  return {
    listTeams: vi.fn(async () => []),
    getTeam: vi.fn(),
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    listMembers: vi.fn(async () => []),
    invite: vi.fn(),
    listInvitations: vi.fn(async () => []),
    listMyInvitations: vi.fn(async () => []),
    respondToInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    leaveTeam: vi.fn(),
    removeMember: vi.fn(),
    dissolveTeam: vi.fn(),
    listAgentCandidates: vi.fn(async () => []),
    listMyAgentCandidates: vi.fn(async () => []),
    listAgentOffers: vi.fn(async () => []),
    addAgentOffer: vi.fn(),
    revokeAgentOffer: vi.fn(),
    ...overrides,
  }
}

function register(testService: TeamRouteService, enabled = true) {
  const app = Fastify()
  registerTeamRoutes(app, {
    config: resolveTeamCollaborationConfig(enabled ? { TEAM_COLLABORATION: 'on' } : {}),
    service: testService,
    verifyAccessToken: async token => token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null,
    getDatabaseReady: () => true,
  })
  return app
}

describe('Team membership routes', () => {
  test('keeps writes disabled by default without calling the service', async () => {
    const createTeam = vi.fn()
    const app = register(service({ createTeam }), false)
    const response = await app.inject({
      method: 'POST',
      url: '/api/team/teams',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'create-disabled', name: 'Disabled team' },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('team_feature_disabled')
    expect(createTeam).not.toHaveBeenCalled()
    await app.close()
  })

  test('derives the actor from authentication and rejects client identity fields', async () => {
    const createTeam = vi.fn(async () => ({ team: { id: 'ctm_1' } }))
    const app = register(service({ createTeam }))
    const forged = await app.inject({
      method: 'POST',
      url: '/api/team/teams',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'create-forged', name: 'Team', user_id: 99 },
    })
    expect(forged.statusCode).toBe(400)
    expect(createTeam).not.toHaveBeenCalled()

    const response = await app.inject({
      method: 'POST',
      url: '/api/team/teams',
      headers: { authorization: 'Bearer user-7' },
      payload: { request_id: 'create-owned', name: '  My team  ' },
    })
    expect(response.statusCode).toBe(201)
    expect(createTeam).toHaveBeenCalledWith({ actorUserId: 7, name: 'My team', requestId: 'create-owned' })
    await app.close()
  })

  test('conceals foreign team resources and exposes revision conflicts', async () => {
    const app = register(service({
      getTeam: vi.fn(async () => { throw new TeamRepositoryError('team_not_found', 'team not found') }),
      leaveTeam: vi.fn(async () => { throw new TeamRepositoryError('revision_conflict', 'revision mismatch', 4) }),
    }))
    const missing = await app.inject({
      method: 'GET', url: '/api/team/teams/ctm_foreign', headers: { authorization: 'Bearer user-8' },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('team_not_found')

    const conflict = await app.inject({
      method: 'POST', url: '/api/team/teams/ctm_owned/leave',
      headers: { authorization: 'Bearer user-8' },
      payload: { request_id: 'leave-stale', expected_revision: 3 },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toMatchObject({ code: 'revision_conflict', current_revision: 4, retryable: true })
    await app.close()
  })

  test('discovers only the authenticated users candidate agents before team creation', async () => {
    const listMyAgentCandidates = vi.fn(async () => [{
      daemon_id: 'daemon-7', hostname: 'Mac mini', provider: 'codex' as const,
      installed: true, online: false, managed_callable: false, dispatch_supported: true,
      availability: 'offline' as const, occupied_team_id: null,
    }])
    const app = register(service({ listMyAgentCandidates }))
    const response = await app.inject({
      method: 'GET', url: '/api/team/agent-candidates', headers: { authorization: 'Bearer user-7' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().agents[0]).toMatchObject({ daemon_id: 'daemon-7', availability: 'offline' })
    expect(listMyAgentCandidates).toHaveBeenCalledWith(7)
    await app.close()
  })
})

describe('Team Agent evidence', () => {
  test('distinguishes offline, unmanaged, and occupied installations', () => {
    expect(candidateForProvider({
      daemon_id: 'd1', hostname: 'one', status: 'offline', agents: ['codex'],
    }, 'codex', 'ctm_a')).toMatchObject({ installed: true, online: false, managed_callable: false, availability: 'offline' })

    expect(candidateForProvider({
      daemon_id: 'd2', hostname: 'two', status: 'online', agents: [{ type: 'claude-code', manageable: false }],
    }, 'claude-code', 'ctm_a')).toMatchObject({ managed_callable: false, availability: 'unmanaged' })

    expect(candidateForProvider({
      daemon_id: 'd3', hostname: 'three', status: 'online', agents: [{ type: 'codex', manageable: true }], team_id: 'ctm_b',
    }, 'codex', 'ctm_a')).toMatchObject({ managed_callable: false, availability: 'occupied', occupied_team_id: 'ctm_b' })

    expect(candidateForProvider({
      daemon_id: 'd4', hostname: 'four', status: 'online', agents: [{ type: 'codex', manageable: true }],
    }, 'codex', 'ctm_a')).toMatchObject({ managed_callable: false, dispatch_supported: false, availability: 'unsupported' })

    expect(candidateForProvider({
      daemon_id: 'd5', hostname: 'five', status: 'online', agents: [{ type: 'codex', manageable: true }],
      collaboration_capabilities: ['team_collaboration_dispatch_v1', 'team_collaboration_context_v1'],
    }, 'codex', 'ctm_a')).toMatchObject({ managed_callable: true, dispatch_supported: true, availability: 'online' })
  })
})
