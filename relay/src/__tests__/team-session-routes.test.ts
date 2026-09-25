import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { resolveTeamCollaborationConfig } from '../team/config.js'
import { TeamRepositoryError } from '../team/repository.js'
import { registerTeamSessionRoutes } from '../team/session-routes.js'
import type { TeamSessionService } from '../team/session-service.js'

function appFor(overrides: Record<string, unknown>) {
  const service = {
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    addParticipant: vi.fn(),
    removeParticipant: vi.fn(),
    changeBinding: vi.fn(),
    listEvents: vi.fn(async () => ({ events: [], next_cursor: null })),
    appendMessage: vi.fn(),
    ...overrides,
  }
  const app = Fastify()
  registerTeamSessionRoutes(app, {
    config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
    service: service as unknown as TeamSessionService,
    verifyAccessToken: async token => token === 'valid' ? { userId: 23 } : null,
    getDatabaseReady: () => true,
  })
  return { app, service }
}

describe('Team shared session routes', () => {
  test('records the authenticated author and rejects a supplied author', async () => {
    const appendMessage = vi.fn(async input => ({ event: { id: 'cev_1', author_user_id: input.actorUserId }, call_ids: [] }))
    const { app, service } = appFor({ appendMessage })
    const forged = await app.inject({
      method: 'POST', url: '/api/team/sessions/css_1/events', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'forged-author', content: 'hello', target_mode: 'discussion', author_user_id: 99 },
    })
    expect(forged.statusCode).toBe(400)
    expect(service.appendMessage).not.toHaveBeenCalled()

    const response = await app.inject({
      method: 'POST', url: '/api/team/sessions/css_1/events', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'server-author', content: ' hello ', target_mode: 'discussion' },
    })
    expect(response.statusCode).toBe(201)
    expect(appendMessage).toHaveBeenCalledWith({
      sessionId: 'css_1', actorUserId: 23, requestId: 'server-author', content: 'hello',
      targetMode: 'discussion', targetOfferIds: [], referenceEventId: null,
    })
    await app.close()
  })

  test('conceals sessions when membership or participant access is missing', async () => {
    const { app } = appFor({
      getSession: vi.fn(async () => { throw new TeamRepositoryError('team_not_found', 'shared session not found') }),
      listEvents: vi.fn(async () => { throw new TeamRepositoryError('team_not_found', 'shared session not found') }),
    })
    const detail = await app.inject({ method: 'GET', url: '/api/team/sessions/css_foreign', headers: { authorization: 'Bearer valid' } })
    expect(detail.statusCode).toBe(404)
    const history = await app.inject({ method: 'GET', url: '/api/team/sessions/css_foreign/events', headers: { authorization: 'Bearer valid' } })
    expect(history.statusCode).toBe(404)
    await app.close()
  })

  test('requires revisions for lifecycle and participant mutations', async () => {
    const { app, service } = appFor({})
    const paused = await app.inject({
      method: 'PATCH', url: '/api/team/sessions/css_1', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'pause-without-revision', state: 'paused' },
    })
    expect(paused.statusCode).toBe(400)
    expect(service.updateSession).not.toHaveBeenCalled()
    await app.close()
  })
})
