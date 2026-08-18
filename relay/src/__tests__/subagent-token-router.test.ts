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
import { BoundedExecutor } from '../ingress/bounded-executor.js'

function createMockPool(): any {
  return {
    query: vi.fn(async (sql: string) => {
      // Daemon-session ownership probe: treat every session as owned.
      if (sql.includes('session_allowed')) return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
  }
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
    const usageSpy = vi.spyOn(db, 'recordSubagentUsageInTransaction').mockResolvedValue(true)
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
    const usageSpy = vi.spyOn(db, 'recordSubagentUsageInTransaction').mockResolvedValue(false)
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
    const usageSpy = vi.spyOn(db, 'recordSubagentUsageInTransaction')
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
    const usageSpy = vi.spyOn(db, 'recordSubagentUsageInTransaction').mockResolvedValue(true)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)
    const usage = { input_tokens: 100, output_tokens: 20 }

    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'turn-1', seq: 1, usage })
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'turn-2', seq: 2, usage })
    await new Promise((r) => setTimeout(r, 30))

    expect(usageSpy.mock.calls.map((call) => call[1].eventId)).toEqual(['turn-1', 'turn-2'])
  })

  test('bounds 10,000 subagent usage transactions and disconnects before ack on overload', async () => {
    let active = 0
    let peak = 0
    const release = { resolve: undefined as (() => void) | undefined, promise: Promise.resolve() as Promise<void> }
    release.promise = new Promise<void>((resolve) => { release.resolve = resolve })
    const ingest = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => {
        active++
        peak = Math.max(peak, active)
        await release.promise
        return {
          query: vi.fn(async (sql: string) => {
            if (sql.includes('session_allowed')) {
              return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
            }
            return sql.includes('RETURNING usage_hash')
              ? { rows: [{ usage_hash: 'seen' }], rowCount: 1 }
              : { rows: [], rowCount: 0 }
          }),
          release: () => { active-- },
        }
      }),
    }
    const control = createMockPool()
    const pools = { control, ingest, query: createMockPool(), worker: createMockPool() } as any
    const router = new Router(pools)
    ;(router as any).legacyPersist = new BoundedExecutor({ maxConcurrent: 2, maxPending: 10_000 })
    const { ws, daemonId } = await setupDaemon(router)

    for (let seq = 1; seq <= 10_000; seq++) {
      router.handleDaemonMessage(daemonId, {
        type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: `event-${seq}`, seq,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peak).toBe(2)
    release.resolve!()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(peak).toBeLessThanOrEqual(2)
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(10_000)

    ;(router as any).legacyPersist = new BoundedExecutor({ maxConcurrent: 1, maxPending: 1 })
    const held = new Promise<boolean>(() => undefined)
    // The ingest pool supports connect(), so usage records inside the session
    // fence through the in-transaction variant — that is what must be held.
    vi.spyOn(db, 'recordSubagentUsageInTransaction').mockReturnValue(held as never)
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'overload-1', seq: 10_001, usage: { input_tokens: 1 } })
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'overload-2', seq: 10_002, usage: { input_tokens: 1 } })
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'root', agent_id: 'child', event_id: 'overload-3', seq: 10_003, usage: { input_tokens: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ws.close).toHaveBeenCalledWith(1013, 'relay_overloaded')
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(10_000)
  })
})
