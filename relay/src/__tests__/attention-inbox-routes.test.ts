import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { registerAttentionInboxRoutes } from '../attention-inbox/routes.js'

const token = vi.fn(async (value: string) => value === 'valid' ? { userId: 7 } : null)
const itemID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function dependencies(mode: 'off' | 'observe' | 'on' = 'on'): any {
  return {
    pool: {} as any,
    config: {
      schemaVersion: 1 as const, mode, enabled: mode !== 'off', remoteResponseEnabled: mode === 'on',
      providers: {
        codex: { projection: mode !== 'off', remoteResponse: mode === 'on' },
        opencode: { projection: mode !== 'off', remoteResponse: mode === 'on' },
        'claude-code': { projection: false, remoteResponse: false },
      },
      recovery: { mode: 'off', projection: false, visible: false },
    },
    verifyAccessToken: token,
    repository: {
      listItems: vi.fn(async () => ({ items: [], counts: { actionable: 0, open: 0, snoozed: 0, submitting: 0, result_unknown: 0 }, nextCursor: null })),
      mutateMetadata: vi.fn(async () => ({ outcome: 'not_found' })),
    },
    recoveryRepository: {
      listItems: vi.fn(async () => ({ items: [], counts: { open: 0, snoozed: 0 } })),
      mutateMetadata: vi.fn(async () => ({ outcome: 'not_found' })),
    },
    service: { submitAction: vi.fn(async () => ({ outcome: 'submitted', receiptId: '12', item: { itemId: itemID }, final: false })) },
  }
}

describe('Attention Inbox REST routes', () => {
  test('returns 401 with private no-store headers without a bearer token', async () => {
    const app = Fastify()
    registerAttentionInboxRoutes(app, dependencies())
    const response = await app.inject({ method: 'GET', url: '/api/attention-inbox/v1/items' })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store, private')
    expect(response.json()).toEqual({ error: { code: 'unauthorized', message: 'Unauthorized', retryable: false } })
  })

  test('off mode returns a disabled empty snapshot without querying items', async () => {
    const deps = dependencies('off')
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const response = await app.inject({ method: 'GET', url: '/api/attention-inbox/v1/items', headers: { authorization: 'Bearer valid' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(expect.objectContaining({
      schema_version: 1,
      capabilities: expect.objectContaining({ enabled: false, remote_response_enabled: false }),
      items: [], next_cursor: null,
    }))
    expect(deps.repository.listItems).not.toHaveBeenCalled()
  })

  test('returns persisted risk reasons in the v1 item DTO', async () => {
    const deps = dependencies('on')
    deps.repository.listItems.mockResolvedValueOnce({
      items: [{
        itemId: itemID, revision: 1, provider: 'codex', kind: 'approval', state: 'open',
        riskLevel: 'high', classificationIncomplete: true, riskReasons: ['executes_command'],
        daemonId: 'daemon-1', sessionId: 'session-1', requestId: 'request-1',
        title: 'Approval required', summary: 'Run command', context: {}, allowedActions: [],
        createdAt: new Date('2026-08-12T00:00:00.000Z'), updatedAt: new Date('2026-08-12T00:00:00.000Z'),
      }] as any[],
      counts: { actionable: 0, open: 1, snoozed: 0, submitting: 0, result_unknown: 0 },
      nextCursor: null,
    })
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const response = await app.inject({
      method: 'GET', url: '/api/attention-inbox/v1/items', headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().items[0].risk).toEqual({
      level: 'high', classification_incomplete: true, reasons: ['executes_command'],
    })
  })

  test('keeps the v1 snapshot shape free of recovery fields', async () => {
    const deps = dependencies('on')
    deps.config.recovery = { mode: 'on', projection: true, visible: true }
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)

    const response = await app.inject({
      method: 'GET', url: '/api/attention-inbox/v1/items',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.json()).not.toHaveProperty('recovery_items')
    expect(response.json().capabilities).not.toHaveProperty('recovery')
    expect(deps.recoveryRepository.listItems).not.toHaveBeenCalled()
  })

  test('returns a separate host-level recovery collection in v2 only when visible', async () => {
    const deps = dependencies('on')
    deps.config.recovery = { mode: 'on', projection: true, visible: true }
    deps.recoveryRepository.listItems.mockResolvedValueOnce({
      items: [{
        recoveryId: itemID, userId: 7, daemonId: 'daemon-1',
        registrationGeneration: 'registration-1', state: 'open', revision: 2,
        reasonCode: 'daemon_offline', daemonDisplayName: 'Mac mini',
        lastSeenAt: new Date('2026-08-12T00:00:00.000Z'), seenAt: null,
        snoozedUntil: null, resolvedAt: null, handledAt: null, resolution: null,
        createdAt: new Date('2026-08-12T00:00:30.000Z'),
        updatedAt: new Date('2026-08-12T00:00:30.000Z'),
      }],
      counts: { open: 1, snoozed: 0 },
    })
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)

    const response = await app.inject({
      method: 'GET', url: '/api/attention-inbox/v2/items',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      schema_version: 2,
      capabilities: { recovery: { mode: 'on', projection: true, visible: true } },
      counts: { recovery_open: 1, recovery_snoozed: 0, attention_required: 1 },
      recovery_items: [{
        recovery_id: itemID, kind: 'recovery', state: 'open',
        reason_code: 'daemon_offline',
        daemon: { id: 'daemon-1', display_name: 'Mac mini' },
        navigation: { type: 'host', daemon_id: 'daemon-1' },
      }],
    })
    expect(response.json().recovery_items[0]).not.toHaveProperty('allowed_actions')
    expect(response.json().recovery_items[0]).not.toHaveProperty('session')
  })

  test('observe mode projects but hides recovery rows from v2 clients', async () => {
    const deps = dependencies('on')
    deps.config.recovery = { mode: 'observe', projection: true, visible: false }
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const response = await app.inject({
      method: 'GET', url: '/api/attention-inbox/v2/items',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.json()).toMatchObject({
      capabilities: { recovery: { mode: 'observe', projection: true, visible: false } },
      counts: { recovery_open: 0, recovery_snoozed: 0 },
      recovery_items: [],
    })
    expect(deps.recoveryRepository.listItems).not.toHaveBeenCalled()
  })

  test('v2 recovery endpoint accepts metadata only and has no action route', async () => {
    const deps = dependencies('on')
    deps.config.recovery = { mode: 'on', projection: true, visible: true }
    deps.recoveryRepository.mutateMetadata.mockResolvedValueOnce({
      outcome: 'updated',
      item: {
        recoveryId: itemID, userId: 7, daemonId: 'daemon-1',
        registrationGeneration: 'registration-1', state: 'open', revision: 3,
        reasonCode: 'daemon_offline', daemonDisplayName: 'Mac mini',
        lastSeenAt: new Date(), seenAt: new Date(), snoozedUntil: null,
        resolvedAt: null, handledAt: null, resolution: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    })
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const changed = await app.inject({
      method: 'PATCH', url: `/api/attention-inbox/v2/recovery-items/${itemID}`,
      headers: { authorization: 'Bearer valid' },
      payload: { operation: 'mark_seen', expected_revision: 2 },
    })
    const action = await app.inject({
      method: 'POST', url: `/api/attention-inbox/v2/recovery-items/${itemID}/actions`,
      headers: { authorization: 'Bearer valid' },
      payload: { action_id: 'reconnect', expected_revision: 2 },
    })

    expect(changed.statusCode).toBe(200)
    expect(changed.json().recovery).toMatchObject({ recovery_id: itemID, revision: 3 })
    expect(action.statusCode).toBe(404)
    expect(deps.service.submitAction).not.toHaveBeenCalled()
  })

  test('requires UUID idempotency key and maps accepted submission to HTTP 202', async () => {
    const deps = dependencies('on')
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const body = { expected_revision: 1, action_id: 'once' }
    const missing = await app.inject({ method: 'POST', url: `/api/attention-inbox/v1/items/${itemID}/actions`, headers: { authorization: 'Bearer valid' }, payload: body })
    expect(missing.statusCode).toBe(400)

    const accepted = await app.inject({
      method: 'POST', url: `/api/attention-inbox/v1/items/${itemID}/actions`,
      headers: { authorization: 'Bearer valid', 'idempotency-key': '11111111-1111-4111-8111-111111111111' },
      payload: body,
    })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json()).toEqual(expect.objectContaining({ outcome: 'submitted', receipt_id: '12', final: false }))
  })

  test('maps ownership-safe not found and stale revision errors', async () => {
    const deps = dependencies('on')
    deps.service.submitAction
      .mockResolvedValueOnce({ outcome: 'error', code: 'item_not_found' } as any)
      .mockResolvedValueOnce({ outcome: 'error', code: 'stale_revision', item: { itemId: itemID } } as any)
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const request = {
      method: 'POST' as const, url: `/api/attention-inbox/v1/items/${itemID}/actions`,
      headers: { authorization: 'Bearer valid', 'idempotency-key': '11111111-1111-4111-8111-111111111111' },
      payload: { expected_revision: 1, action_id: 'once' },
    }
    expect((await app.inject(request)).statusCode).toBe(404)
    expect((await app.inject(request)).statusCode).toBe(409)
  })

  test('maps observer_read_only to a stable non-retryable HTTP conflict', async () => {
    const deps = dependencies('on')
    deps.service.submitAction.mockResolvedValueOnce({ outcome: 'error', code: 'observer_read_only' } as any)
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)

    const response = await app.inject({
      method: 'POST', url: `/api/attention-inbox/v1/items/${itemID}/actions`,
      headers: {
        authorization: 'Bearer valid',
        'idempotency-key': '11111111-1111-4111-8111-111111111111',
      },
      payload: { expected_revision: 1, action_id: 'once' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: {
        code: 'observer_read_only', message: 'Observer session is read-only', retryable: false,
      },
    })
  })

  test('rejects malformed item identifiers without reaching the repository or service', async () => {
    const deps = dependencies('on')
    const app = Fastify()
    registerAttentionInboxRoutes(app, deps)
    const response = await app.inject({
      method: 'POST', url: '/api/attention-inbox/v1/items/not-a-uuid/actions',
      headers: { authorization: 'Bearer valid', 'idempotency-key': '11111111-1111-4111-8111-111111111111' },
      payload: { expected_revision: 1, action_id: 'once' },
    })
    expect(response.statusCode).toBe(404)
    expect(deps.service.submitAction).not.toHaveBeenCalled()
  })
})
