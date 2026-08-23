import { describe, expect, test, vi } from 'vitest'
import { Router } from '../router.js'
import {
  RealtimeOutboxConsumer,
  type RealtimeOutboxClaim,
  type RealtimeOutboxRow,
} from '../materialization/realtime-outbox.js'

function ws(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(), terminate: vi.fn(), _sent: sent,
  }
}

function pool(): any {
  const calls: Array<{ sql: string; params: any[] }> = []
  const value: any = {
    _calls: calls,
    query: vi.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params })
      if (/SELECT 1 FROM deleted_sessions/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/SELECT 1 FROM sessions/i.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (/SELECT daemon_id FROM sessions/i.test(sql)) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
      if (/INSERT INTO events/i.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
  }
  value.connect = vi.fn(async () => ({ query: value.query, release: vi.fn() }))
  return value
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('OpenCode interaction router', () => {
  test('routes owned interaction operations only to the session daemon', async () => {
    const db = pool()
    const router = new Router(db)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 1)
    const client = ws()
    router.registerClient(client, 7)
    ;(router as any).sessionToDaemon.set('ses_1', 'd1')
    daemon._sent.length = 0

    await router.handleClientMessage(client, { type: 'set_session_agent', session_id: 'ses_1', agent_name: 'build' })
    await router.handleClientMessage(client, { type: 'question_response', session_id: 'ses_1', request_id: 'que_1', answers: [['A']] })
    await router.handleClientMessage(client, { type: 'approval_response', session_id: 'ses_1', request_id: 'per_1', action: 'always' })

    expect(daemon._sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'set_session_agent', session_id: 'ses_1', agent_name: 'build' }),
      expect.objectContaining({ type: 'question_response', request_id: 'que_1', answers: [['A']] }),
      expect.objectContaining({ type: 'approval_response', request_id: 'per_1', action: 'always' }),
    ]))
  })

  test('persists confirmed agent change and broadcasts to subscribed clients', async () => {
    const db = pool()
    const router = new Router(db)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 1)
    const client = ws()
    router.registerClient(client, 7)
    ;(router as any).clients.get(client).subscribedSessions.add('ses_1')

    router.handleDaemonMessage('d1', { type: 'session_agent_changed', session_id: 'ses_1', current_agent: 'build', seq: 9 })
    await tick()

    expect(db._calls.some((call: any) => /UPDATE sessions SET active_agent/i.test(call.sql) && call.params[0] === 'build')).toBe(true)
    expect(db._calls.some((call: any) => /INSERT INTO events/i.test(call.sql) && call.params.includes('session_agent_changed'))).toBe(true)
    expect(client._sent).toContainEqual(expect.objectContaining({ type: 'session_agent_changed', current_agent: 'build' }))
  })

  test('preserves full asked and remote resolved payloads across relay', async () => {
    const db = pool()
    const router = new Router(db)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 1)
    const client = ws()
    router.registerClient(client, 7)
    ;(router as any).clients.get(client).subscribedSessions.add('ses_1')

    const asked = {
      type: 'approval_request', session_id: 'ses_1', request_id: 'per_1', permission_name: 'bash',
      patterns: ['git *'], always: ['git status'], metadata: { command: 'git status' }, permission_version: 'legacy', seq: 10,
    }
    const permissionResolved = { type: 'approval_resolved', session_id: 'ses_1', request_id: 'per_1', action: 'always', approved: true, reason: 'resolved_elsewhere', seq: 11 }
    const questionResolved = { type: 'question_resolved', session_id: 'ses_1', request_id: 'que_1', answers: [['A'], ['B', 'custom']], rejected: false, reason: 'resolved_elsewhere', seq: 12 }
    router.handleDaemonMessage('d1', asked)
    router.handleDaemonMessage('d1', permissionResolved)
    router.handleDaemonMessage('d1', questionResolved)
    await tick()

    expect(client._sent).toEqual(expect.arrayContaining([asked, permissionResolved, questionResolved]))
    const persisted = db._calls.filter((call: any) => /INSERT INTO events/i.test(call.sql))
    expect(persisted.some((call: any) => call.params.includes('approval_request') && call.params.some((value: any) => typeof value === 'string' && value.includes('git status')))).toBe(true)
    expect(persisted.some((call: any) => call.params.includes('approval_resolved') && call.params.some((value: any) => typeof value === 'string' && value.includes('always')))).toBe(true)
    expect(persisted.some((call: any) => call.params.includes('question_resolved') && call.params.some((value: any) => typeof value === 'string' && value.includes('custom')))).toBe(true)
  })

  test('persists and broadcasts managed control claims from session discovery', async () => {
    const db = pool()
    const router = new Router(db)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 7)
    const client = ws()
    router.registerClient(client, 7)

    router.handleDaemonMessage('d1', {
      type: 'session_discovered', session_id: 'ses_managed', agent: 'opencode', cwd: '/repo', status: 'idle',
      control_mode: 'managed', capabilities: ['shared_runtime', 'terminal_coapproval', 'questions'], seq: 20,
    })
    await tick()

    const upsert = db._calls.find((call: any) => /INSERT INTO sessions/i.test(call.sql))
    expect(upsert?.sql).toMatch(/control_mode, capabilities/)
    expect(upsert?.params).toEqual(expect.arrayContaining(['managed', JSON.stringify(['shared_runtime', 'terminal_coapproval', 'questions'])]))
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_discovered', session_id: 'ses_managed', control_mode: 'managed',
      capabilities: ['shared_runtime', 'terminal_coapproval', 'questions'],
    }))
  })

  test('directs resolved_elsewhere to the submitter and broadcasts the final resolution to all devices', async () => {
    const db = pool()
    const router = new Router(db)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 7)
    const first = ws()
    const second = ws()
    router.registerClient(first, 7)
    router.registerClient(second, 7)
    ;(router as any).sessionToDaemon.set('ses_1', 'd1')
    ;(router as any).clients.get(first).subscribedSessions.add('ses_1')
    ;(router as any).clients.get(second).subscribedSessions.add('ses_1')

    await router.handleClientMessage(first, { type: 'approval_response', session_id: 'ses_1', request_id: 'per_1', action: 'once' })
    await router.handleClientMessage(second, { type: 'approval_response', session_id: 'ses_1', request_id: 'per_1', action: 'always' })
    first._sent.length = 0
    second._sent.length = 0

    const idempotent = {
      type: 'interaction_result', session_id: 'ses_1', request_id: 'per_1', operation: 'approval_response',
      status: 'resolved_elsewhere', reason: 'resolved_elsewhere', seq: 30,
    }
    router.handleDaemonMessage('d1', idempotent)
    await tick()

    expect(first._sent).toContainEqual(idempotent)
    expect(second._sent).not.toContainEqual(idempotent)

    const resolution = {
      type: 'approval_resolved', session_id: 'ses_1', request_id: 'per_1', action: 'once', approved: true, seq: 31,
    }
    router.handleDaemonMessage('d1', resolution)
    await tick()
    expect(first._sent).toContainEqual(resolution)
    expect(second._sent).toContainEqual(resolution)
  })

  test('recovers durable interaction feedback to one same-owner client after origin state is lost', async () => {
    const router = new Router(pool())
    const owner = ws()
    const otherOwner = ws()
    router.registerClient(owner, 7)
    router.registerClient(otherOwner, 8)
    const payload = {
      type: 'interaction_result', session_id: 'ses_1', request_id: 'per_1',
      operation: 'approval_response', status: 'ok',
    }

    expect(await router.deliverMaterializedEvent({
      inboxId: 11, daemonId: 'd1', eventId: null, userId: 7,
      audience: 'interaction-origin', sessionId: 'ses_1', requestId: 'per_1',
      ordinal: 0, deliveryKey: 'inbox:11:interaction-origin:per_1:0',
      type: 'interaction_result', payload,
    })).toBe(true)

    expect(owner._sent).toContainEqual(payload)
    expect(otherOwner._sent).not.toContainEqual(payload)
  })

  test('does not claim durable interaction feedback delivered without an eligible owner', async () => {
    const router = new Router(pool())
    const otherOwner = ws()
    router.registerClient(otherOwner, 8)

    expect(await router.deliverMaterializedEvent({
      inboxId: 12, daemonId: 'd1', eventId: null, userId: 7,
      audience: 'interaction-origin', sessionId: 'ses_1', requestId: 'per_1',
      ordinal: 0, deliveryKey: 'inbox:12:interaction-origin:per_1:0',
      type: 'interaction_result',
      payload: { type: 'interaction_result', operation: 'approval_response' },
    })).toBe(false)
    expect(otherOwner._sent).toHaveLength(0)
  })

  test('retries durable quota refresh before marking delivery and does not duplicate business payload', async () => {
    const router = new Router(pool())
    const owner = ws()
    router.registerClient(owner, 7)
    ;(router as any).clients.get(owner).subscribedSessions.add('ses_1')
    const quota = vi.spyOn(router, 'broadcastQuotaStatus')
      .mockRejectedValueOnce(new Error('quota database unavailable'))
      .mockImplementationOnce(async (userId) => {
        ;(router as any).broadcastToUser(userId, { type: 'quota_status', remaining: 1 })
      })
    const delivery: RealtimeOutboxRow = {
      outboxId: 91,
      inboxId: 51,
      daemonId: 'd1',
      eventId: 301,
      userId: 7,
      audience: 'session',
      sessionId: 'ses_1',
      requestId: null,
      ordinal: 0,
      deliveryKey: 'event:301:session:-:0',
      type: 'session_status',
      payload: { type: 'session_status', session_id: 'ses_1', status: 'completed' },
    }
    const makeClaim = (): RealtimeOutboxClaim => ({
      rows: [delivery],
      markDelivered: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    })
    const first = makeClaim()
    const second = makeClaim()
    const repository = {
      claimUndelivered: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    }
    const consumer = new RealtimeOutboxConsumer({
      repository,
      deliver: (row) => router.deliverDurableMaterializedEvent(row),
    })

    await expect(consumer.runOnce()).rejects.toThrow('quota database unavailable')
    expect(first.markDelivered).not.toHaveBeenCalled()
    expect(owner._sent).toHaveLength(0)
    await consumer.runOnce()

    expect(second.markDelivered).toHaveBeenCalledWith(91)
    expect(owner._sent.filter((message: any) => message.type === 'session_status')).toHaveLength(1)
    expect(owner._sent.filter((message: any) => message.type === 'quota_status')).toHaveLength(1)
    expect(quota).toHaveBeenCalledTimes(2)
  })

  test('refreshes persisted control state from session metadata', async () => {
    const db = pool()
    const router = new Router(db)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 7)
    const client = ws()
    router.registerClient(client, 7)
    ;(router as any).clients.get(client).subscribedSessions.add('ses_1')

    const metadata = {
      type: 'session_meta', session_id: 'ses_1', control_mode: 'managed',
      capabilities: ['shared_runtime', 'terminal_coapproval', 'questions'], seq: 40,
    }
    router.handleDaemonMessage('d1', metadata)
    await tick()

    expect(db._calls.some((call: any) => /UPDATE sessions SET control_mode/i.test(call.sql) && call.params[0] === 'managed')).toBe(true)
    expect(client._sent).toContainEqual(metadata)
  })
})
