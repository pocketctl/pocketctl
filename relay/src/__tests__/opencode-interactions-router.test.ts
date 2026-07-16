import { describe, expect, test, vi } from 'vitest'
import { Router } from '../router.js'

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
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, null)
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
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, null)
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
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, null)
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
})
