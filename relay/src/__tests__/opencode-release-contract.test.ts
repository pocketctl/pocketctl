import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Router } from '../router.js'

type ReleaseCase = { id: string; payload: Record<string, any>; web_type: string; status: string; dedup_key: string }

function socket(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(), terminate: vi.fn(), _sent: sent,
  }
}

function deduplicatingPool(): any {
  const hashes = new Map<string, number>()
  let nextID = 1
  const calls: Array<{ sql: string; params: any[] }> = []
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    if (/SELECT 1 FROM sessions/i.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 }
    if (/SELECT daemon_id FROM sessions/i.test(sql)) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (/INSERT INTO events/i.test(sql)) {
      const hash = String(params[3])
      const existing = hashes.get(hash)
      if (existing) return { rows: [{ id: existing, inserted: false, effect_status: 'completed', effect_step: 0 }], rowCount: 1 }
      const id = nextID++
      hashes.set(hash, id)
      return { rows: [{ id, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
    }
    if (/SELECT effect_status/i.test(sql)) return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  const pool: any = { _calls: calls, query }
  pool.connect = vi.fn(async () => ({ query, release: vi.fn() }))
  return pool
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function expectedContract(item: ReleaseCase, sessionID: string): { webType: string; status: string; dedupKey: string } {
  const payload = item.payload
  if (payload.type === 'command_receipt') return { webType: payload.type, status: payload.receipt_status, dedupKey: `command:${payload.command}` }
  if (payload.type === 'session_agent_changed') return { webType: payload.type, status: payload.current_agent, dedupKey: `agent:${payload.current_agent}` }
  if (payload.type === 'approval_request' || payload.type === 'question_request') return { webType: payload.type, status: 'pending', dedupKey: `request:${payload.request_id}` }
  if (payload.type === 'approval_resolved') return { webType: 'approval_request', status: 'resolved', dedupKey: `request:${payload.request_id}` }
  if (payload.type === 'question_resolved') return { webType: 'question_request', status: 'resolved', dedupKey: `request:${payload.request_id}` }
  if (payload.type === 'session_status') return { webType: payload.type, status: payload.status, dedupKey: `status:${sessionID}:${payload.status}` }
  if (payload.type === 'replay_batch') {
    const part = payload.events[0]
    return { webType: part.type, status: 'deduped', dedupKey: `part:${part.part_id}` }
  }
  return { webType: payload.type, status: 'present', dedupKey: `part:${payload.part_id}` }
}

describe('OpenCode shared release contract', () => {
  test('production Router persists and fans out every durable case only once on replay', async () => {
    const contract = JSON.parse(readFileSync(resolve(process.cwd(), '../internal/e2e/testdata/opencode_release_gate.json'), 'utf8')) as { session_id: string; cases: ReleaseCase[] }
    const db = deduplicatingPool()
    const router = new Router(db)
    const daemon = socket()
    const client = socket()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: ['opencode'] }, 1)
    router.registerClient(client, 7)
    ;(router as any).clients.get(client).subscribedSessions.add(contract.session_id)
    ;(router as any).sessionToDaemon.set(contract.session_id, 'd1')
    client._sent.length = 0

    const durableCases = contract.cases.filter(item => item.payload.type !== 'replay_batch')
    for (const item of contract.cases) {
      expect({ webType: item.web_type, status: item.status, dedupKey: item.dedup_key }, item.id).toEqual(expectedContract(item, contract.session_id))
    }
    for (const [index, item] of durableCases.entries()) {
      // replay_batch is a relay->client envelope, not a durable daemon event.
      const event = { ...item.payload, session_id: contract.session_id, event_id: `opencode:release:${item.id}`, seq: index + 1 }
      router.handleDaemonMessage('d1', event)
    }
    await waitFor(
      () => client._sent.filter((event: any) => typeof event.event_id === 'string' && event.event_id.startsWith('opencode:release:')).length === durableCases.length,
      'initial durable fanout',
    )
    for (const [index, item] of durableCases.entries()) {
      router.handleDaemonMessage('d1', { ...item.payload, session_id: contract.session_id, event_id: `opencode:release:${item.id}`, seq: durableCases.length + index + 1 })
    }
    await waitFor(
      () => db._calls.filter((call: any) => /INSERT INTO events/i.test(call.sql) && String(call.params[2]).includes('opencode:release:')).length === durableCases.length * 2,
      'replay persistence attempts',
    )

    for (const item of durableCases) {
      const eventID = `opencode:release:${item.id}`
      const inserts = db._calls.filter((call: any) => /INSERT INTO events/i.test(call.sql) && String(call.params[2]).includes(eventID))
      expect(inserts, `${item.id} persisted through production Router`).toHaveLength(2)
      expect(client._sent.filter((event: any) => event.event_id === eventID), `${item.id} live fanout`).toHaveLength(1)
    }
  })
})
