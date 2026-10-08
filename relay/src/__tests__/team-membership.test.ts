import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { candidateForProvider } from '../team/agent-offers.js'
import { resolveTeamCollaborationConfig } from '../team/config.js'
import { TeamRepositoryError, type CollaborationAgentOfferView } from '../team/repository.js'
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
    changeMemberRole: vi.fn(),
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

function register(testService: TeamRouteService, enabled = true, live?: (daemonId: string, ownerUserId: number) => boolean) {
  const app = Fastify()
  registerTeamRoutes(app, {
    config: resolveTeamCollaborationConfig(enabled ? { TEAM_COLLABORATION: 'on' } : {}),
    service: testService,
    verifyAccessToken: async token => token.startsWith('user-') ? { userId: Number(token.slice(5)) } : null,
    getDatabaseReady: () => true,
    isDaemonOnline: live,
  })
  return app
}

describe('Team membership routes', () => {
  test('validates role mutations and forwards authenticated revision and invitation role', async () => {
    const changeMemberRole = vi.fn().mockResolvedValue({ role: 'viewer', revision: 3 })
    const invite = vi.fn().mockResolvedValue({ role: 'admin' })
    const app = register(service({ changeMemberRole, invite }))
    const headers = { authorization: 'Bearer user-7' }
    const url = '/api/team/teams/t/members/m/role'
    for (const role of ['owner', ['admin'], null]) {
      expect((await app.inject({ method: 'PATCH', url, headers,
        payload: { request_id: 'role-invalid', expected_revision: 2, role } })).statusCode).toBe(400)
    }
    expect(changeMemberRole).not.toHaveBeenCalled()
    const response = await app.inject({ method: 'PATCH', url, headers,
      payload: { request_id: 'role-valid', expected_revision: 2, role: 'viewer' } })
    expect(response.statusCode).toBe(200)
    expect(changeMemberRole).toHaveBeenCalledWith({ teamId: 't', membershipId: 'm', actorUserId: 7,
      role: 'viewer', expectedRevision: 2, requestId: 'role-valid' })
    const invitation = await app.inject({ method: 'POST', url: '/api/team/teams/t/invitations', headers,
      payload: { request_id: 'invite-admin', expected_revision: 2, email: 'admin@example.test', role: 'admin' } })
    expect(invitation.statusCode).toBe(201)
    expect(invite).toHaveBeenCalledWith({ teamId: 't', actorUserId: 7, email: 'admin@example.test', role: 'admin', expectedRevision: 2, requestId: 'invite-admin' })
    await app.close()
  })

  test('does not advertise persisted online Agents before their live socket reconnects', async () => {
    const candidate = candidateForProvider({ daemon_id: 'd-stale', hostname: 'host', status: 'online',
      agents: ['claude-code'], collaboration_capabilities: ['team_collaboration_dispatch_v1', 'team_collaboration_context_v1'] }, 'claude-code', 't')
    const offer: CollaborationAgentOfferView = { ...candidate, id: 'o', team_id: 't', owner_user_id: 8,
      runtime_profile_id: null, capability_revision: 1, state: 'active', revision: 1,
      created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z' }
    let connected = false
    const live = vi.fn(() => connected)
    const app = register(service({ listMyAgentCandidates: async () => [candidate],
      listAgentCandidates: async () => [candidate], listAgentOffers: async () => [offer] }), true, live)
    for (const route of ['/api/team/agent-candidates', '/api/team/teams/t/agent-candidates', '/api/team/teams/t/agent-offers']) {
      const response = await app.inject({ method:'GET',url:route,headers:{authorization:'Bearer user-7'} })
      expect(response.statusCode).toBe(200)
      const item = (response.json().agents ?? response.json().offers)[0]
      expect(item).toMatchObject({ online:false, managed_callable:false, availability:'offline' })
    }
    expect(live).toHaveBeenCalledWith('d-stale',8)
    connected = true
    const recovered = await app.inject({method:'GET',url:'/api/team/teams/t/agent-offers',headers:{authorization:'Bearer user-7'}})
    expect(recovered.json().offers[0]).toMatchObject({online:true,managed_callable:true,availability:'online'})
    await app.close()
  })
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

  test('accepts a bounded description and rejects malformed descriptions before creation', async () => {
    const createTeam = vi.fn(async () => ({ team: { id: 'ctm_description' } }))
    const app = register(service({ createTeam }))
    for (const description of [123, null, 'x'.repeat(2001)]) {
      const response = await app.inject({method:'POST',url:'/api/team/teams',headers:{authorization:'Bearer user-7'},payload:{request_id:'invalid-description',name:'Team',description}})
      expect(response.statusCode).toBe(400)
    }
    expect(createTeam).not.toHaveBeenCalled()
    const response = await app.inject({method:'POST',url:'/api/team/teams',headers:{authorization:'Bearer user-7'},payload:{request_id:'valid-description',name:'Team',description:'  A shared goal  '}})
    expect(response.statusCode).toBe(201)
    expect(createTeam).toHaveBeenCalledWith({actorUserId:7,name:'Team',description:'A shared goal',requestId:'valid-description'})
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

 describe('DSH Team offers', () => {
  test('requires DSH-specific live runtime support independently of package upgrade ownership', async () => {
    const { offeredProviders } = await import('../team/agent-offers.js')
    const daemon = { daemon_id: 'dsh-host', hostname: 'DSH', status: 'online', agents: [{ type: 'dsh', manageable: false }],
      collaboration_capabilities: ['team_collaboration_dispatch_v1', 'team_collaboration_context_v1'] }
    expect(offeredProviders(daemon.agents)).toEqual(['dsh'])
    expect(candidateForProvider(daemon, 'dsh', 'team')).toMatchObject({installed: true, managed_callable: false, availability: 'unsupported'})
    daemon.collaboration_capabilities.push('team_collaboration_dsh_v1')
    expect(candidateForProvider(daemon, 'dsh', 'team')).toMatchObject({managed_callable: true, availability: 'online'})
    expect(candidateForProvider({...daemon, status:'offline'}, 'dsh', 'team')).toMatchObject({managed_callable:false,availability:'offline'})
    expect(candidateForProvider({...daemon, team_id:'another'}, 'dsh', 'team')).toMatchObject({managed_callable:false,availability:'occupied'})
  })

  test('accepts DSH sharing and continues rejecting unknown providers', async () => {
    const addAgentOffer = vi.fn(async input => ({...input, owner_user_id:7}))
    const app = register(service({addAgentOffer: addAgentOffer as any}))
    for (const provider of ['dsh', 'unknown']) {
      const response = await app.inject({method:'POST',url:'/api/team/teams/t/agent-offers',headers:{authorization:'Bearer user-7'},
        payload:{request_id:'share-'+provider,expected_revision:1,daemon_id:'dsh-host',provider}})
      expect(response.statusCode).toBe(provider === 'dsh' ? 201 : 400)
    }
    expect(addAgentOffer).toHaveBeenCalledTimes(1)
    expect(addAgentOffer).toHaveBeenCalledWith(expect.objectContaining({provider:'dsh',daemonId:'dsh-host',actorUserId:7}))
    await app.close()
  })
 })
