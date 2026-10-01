import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { resolveTeamCollaborationConfig } from '../team/config.js'
import { TeamRepositoryError } from '../team/repository.js'
import { registerTeamTaskRoutes, type TeamTaskRouteService } from '../team/task-routes.js'

function service(overrides: Partial<TeamTaskRouteService> = {}): TeamTaskRouteService {
  return {
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    restoreTask: vi.fn(),
    setHolder: vi.fn(),
    linkSession: vi.fn(),
    ...overrides,
  }
}

function appFor(testService: TeamTaskRouteService, enabled = true) {
  const app = Fastify()
  registerTeamTaskRoutes(app, {
    config: resolveTeamCollaborationConfig(enabled ? { TEAM_COLLABORATION: 'on' } : {}),
    service: testService,
    verifyAccessToken: async token => token === 'valid' ? { userId: 17 } : null,
    getDatabaseReady: () => true,
  })
  return app
}

describe('Team task routes', () => {
  test('creates a lightweight task with the authenticated actor', async () => {
    const createTask = vi.fn(async input => ({ id: 'ctk_1', revision: 1, ...input }))
    const app = appFor(service({ createTask }))
    const response = await app.inject({
      method: 'POST', url: '/api/team/teams/ctm_1/tasks',
      headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'task-create', title: '  Investigate  ', background: 'Facts only' },
    })
    expect(response.statusCode).toBe(201)
    expect(createTask).toHaveBeenCalledWith({
      teamId: 'ctm_1', actorUserId: 17, title: 'Investigate', background: 'Facts only', requestId: 'task-create',
    })
    await app.close()
  })

  test('does not turn a disabled Team feature into a task write path', async () => {
    const updateTask = vi.fn()
    const app = appFor(service({ updateTask }), false)
    const response = await app.inject({
      method: 'PATCH', url: '/api/team/tasks/ctk_1', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'task-update', expected_revision: 1, state: 'in_progress' },
    })
    expect(response.statusCode).toBe(503)
    expect(updateTask).not.toHaveBeenCalled()
    await app.close()
  })

  test('returns revision and creator authorization failures from the service', async () => {
    const app = appFor(service({
      updateTask: vi.fn(async () => { throw new TeamRepositoryError('revision_conflict', 'revision mismatch', 3) }),
      setHolder: vi.fn(async () => { throw new TeamRepositoryError('creator_required', 'team creator authority required') }),
    }))
    const stale = await app.inject({
      method: 'PATCH', url: '/api/team/tasks/ctk_1', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'task-stale', expected_revision: 2, background: 'new' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatchObject({ code: 'revision_conflict', current_revision: 3, retryable: true })

    const forbidden = await app.inject({
      method: 'PUT', url: '/api/team/tasks/ctk_1/holders/99', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'holder-other', expected_revision: 3 },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error.code).toBe('creator_required')
    await app.close()
  })
})
