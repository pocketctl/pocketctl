import { describe, test, expect, vi, beforeEach } from 'vitest'

process.env.DAEMON_OFFLINE_GRACE_MS = '20'

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    persistEvent: vi.fn().mockResolvedValue(1),
    getUserPlanAndWhitelist: vi.fn().mockResolvedValue({ plan: 'pro', whitelist: false }),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    setDaemonOnline: vi.fn().mockResolvedValue(undefined),
    getDaemonAlias: vi.fn().mockResolvedValue(null),
    getDaemonOwner: vi.fn().mockResolvedValue(null),
    activateDaemonRegistration: vi.fn().mockResolvedValue(null),
    restoreDaemonRegistration: vi.fn().mockResolvedValue(undefined),
    recordSubagentUsage: actual.recordSubagentUsage,
  }
})
import * as db from '../db.js'
import { Router } from '../router.js'

function createMockPool(): any {
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
}
function createMockWs(): any {
  const sent: any[] = []
  return { readyState: 1, send: vi.fn((d: string) => sent.push(JSON.parse(d))), close: vi.fn(), _sent: sent }
}
async function setupDaemon(router: Router, daemonId = 'd1') {
  const ws = createMockWs()
  await router.registerDaemon(ws, { type: 'register', daemon_id: daemonId, hostname: 'h', agents: [] }, null)
  return { ws, daemonId }
}

describe('router subagent_usage durable identity and ack', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  test('passes stable event_id and all token fields to one transactional DB call', async () => {
    const usageSpy = vi.spyOn(db, 'recordSubagentUsage').mockResolvedValue(true)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    router.handleDaemonMessage(daemonId, {
      type: 'subagent_usage', session_id: 'root', agent_id: 'child',
      event_id: 'jsonl:file:3:0:usage', seq: 1,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_create_tokens: 5 },
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(usageSpy).toHaveBeenCalledWith(expect.anything(), {
      daemonId, seq: 1, eventId: 'jsonl:file:3:0:usage',
      parentSessionId: 'root', agentId: 'child',
      inputTokens: 100, outputTokens: 20, cacheRead: 50, cacheCreate: 5,
    })
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(1)
  })

  test('passes an empty event id to preserve legacy Claude usage fingerprints', async () => {
    const usageSpy = vi.spyOn(db, 'recordSubagentUsage').mockResolvedValue(false)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    router.handleDaemonMessage(daemonId, {
      type: 'subagent_usage', session_id: 'root', agent_id: 'claude-child', seq: 1,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_create_tokens: 5 },
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(usageSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      daemonId, eventId: '', parentSessionId: 'root', agentId: 'claude-child',
    }))
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(1)
  })

  test('withholds ack on transaction failure and accepts retry', async () => {
    const usageSpy = vi.spyOn(db, 'recordSubagentUsage')
      .mockRejectedValueOnce(new Error('db failed'))
      .mockResolvedValueOnce(true)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)
    const event = {
      type: 'subagent_usage', session_id: 'root', agent_id: 'child',
      event_id: 'event-1', seq: 1,
      usage: { input_tokens: 1, output_tokens: 2 },
    }

    router.handleDaemonMessage(daemonId, event)
    await new Promise((r) => setTimeout(r, 30))
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(0)

    router.handleDaemonMessage(daemonId, event)
    await new Promise((r) => setTimeout(r, 30))
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(1)
    expect(usageSpy).toHaveBeenCalledTimes(2)
  })

  test('keeps identical token amounts distinct when event_id differs', async () => {
    const usageSpy = vi.spyOn(db, 'recordSubagentUsage').mockResolvedValue(true)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)
    const usage = { input_tokens: 100, output_tokens: 20 }

    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'turn-1', seq: 1, usage })
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'turn-2', seq: 2, usage })
    await new Promise((r) => setTimeout(r, 30))

    expect(usageSpy.mock.calls.map((call) => call[1].eventId)).toEqual(['turn-1', 'turn-2'])
  })
})
