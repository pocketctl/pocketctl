import Fastify from 'fastify'
import { expect, test, vi } from 'vitest'
import { registerTeamDeliveryRoutes, type DeliveryRouteService } from '../team/delivery-routes.js'
import { TeamRepositoryError } from '../team/repository.js'

test('external authority uses current bearer identity, bounded body, no-store and explicit retry semantics', async () => {
  const app = Fastify()
  const authorize = vi.fn(async () => ({ authorized: true as const, call_id: 'call', request_id: 'original', native_session_id: 'native', phase: 'execute' as const, provider: 'agentteams' as const }))
  let ready = true
  registerTeamDeliveryRoutes(app, {
    service: {} as DeliveryRouteService, externalAuthorization: { authorize },
    verifyAccessToken: async token => token === 'current' ? { userId: 7 } : null,
    getDatabaseReady: () => ready,
  })
  try {
    const payload = { authorization: {}, request_id: 'original', native_session_id: 'native', phase: 'execute' }
    const request = { method: 'POST' as const, url: '/api/team/daemons/daemon/calls/call/external-authorization', payload, headers: { authorization: 'Bearer current' } }
    expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401)
    expect((await app.inject({ ...request, headers: { authorization: 'Bearer revoked' } })).statusCode).toBe(401)
    ready = false
    expect((await app.inject(request)).statusCode).toBe(503)
    expect(authorize).not.toHaveBeenCalled()
    ready = true
    expect((await app.inject({ ...request, payload: { ...payload, endpoint: 'injected' } })).statusCode).toBe(400)
    expect((await app.inject({ ...request, payload: { ...payload, request_id: 'x'.repeat(17000) } })).statusCode).toBe(413)
    expect(authorize).not.toHaveBeenCalled()
    const ok = await app.inject(request)
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(authorize).toHaveBeenCalledWith(7, 'daemon', 'call', payload)
    authorize.mockRejectedValueOnce(new TeamRepositoryError('external_call_not_ready', 'Not accepted yet'))
    const pending = await app.inject(request)
    expect(pending.statusCode).toBe(503)
    expect(pending.json().error).toMatchObject({ code: 'external_call_not_ready', retryable: true })
    authorize.mockRejectedValueOnce(new TeamRepositoryError('team_access_denied', 'Revoked'))
    const denied = await app.inject(request)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.retryable).toBe(false)
  } finally { await app.close() }
})
