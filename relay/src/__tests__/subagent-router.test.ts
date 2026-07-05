import { describe, test, expect, vi, beforeEach } from 'vitest'

// Short the offline grace window (read by the Router constructor).
process.env.DAEMON_OFFLINE_GRACE_MS = '20'

// Mock DB functions so registerDaemon / persistAndAck don't touch real PG.
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
    // The functions under test — spied via the module, not the mock factory,
    // so the router code path calls the real export which is the spy.
    upsertSubagent: actual.upsertSubagent,
    addSubagentUsage: actual.addSubagentUsage,
    incrementSubagentCount: actual.incrementSubagentCount,
  }
})

import * as db from '../db.js'
import { Router } from '../router.js'

// Minimal pool: satisfies Router constructor's type but never used for real queries.
// query returns { rows: [] } by default so pool.query(...).rows[0] never throws.
function createMockPool(): any {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
}

function createMockWs(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((data: string) => { sent.push(JSON.parse(data)) }),
    close: vi.fn(),
    _sent: sent,
  }
}

/**
 * Register a daemon and return its daemonId and ws.
 * Uses userId=null so registerDaemon skips the getUserPlanAndWhitelist path.
 */
async function setupDaemon(router: Router, daemonId = 'd1') {
  const ws = createMockWs()
  await router.registerDaemon(ws, {
    type: 'register',
    daemon_id: daemonId,
    hostname: 'h',
    agents: [],
  }, null)
  return { ws, daemonId }
}

describe('router subagent event → db (through handleDaemonMessage)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('subagent_discovered → upsertSubagent called with mapped fields', async () => {
    const upsertSpy = vi.spyOn(db, 'upsertSubagent').mockResolvedValue(undefined)
    const incrSpy = vi.spyOn(db, 'incrementSubagentCount').mockResolvedValue(undefined)

    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    // Route a subagent_discovered message through the router
    router.handleDaemonMessage(daemonId, {
      type: 'subagent_discovered',
      session_id: 'parent-1',
      agent_id: 'agent-abc',
      call_id: 'call_xyz',
      subagent_type: 'Explore',
      subagent_desc: 'find foo',
      seq: 1,
    })

    // Let async promises settle (persistAndAck → persistEvent, upsertSubagent, incrementSubagentCount)
    await new Promise((r) => setTimeout(r, 50))

    // Assert the router mapped fields correctly to db.upsertSubagent
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    const call = upsertSpy.mock.calls[0]
    // call[0] = pool, call[1] = parentSessionId, call[2] = agentId, call[3] = kind, call[4] = toolUseId, call[5] = agentType, call[6] = title
    expect(call[1]).toBe('parent-1')   // session_id → parentSessionId
    expect(call[2]).toBe('agent-abc')   // agent_id → agentId
    expect(call[3]).toBe('claude_subagent') // kind constant
    expect(call[4]).toBe('call_xyz')    // call_id → toolUseId
    expect(call[5]).toBe('Explore')      // subagent_type → agentType
    expect(call[6]).toBe('find foo')     // subagent_desc → title

    // Assert incrementSubagentCount was called (was dead code in old test)
    expect(incrSpy).toHaveBeenCalledTimes(1)
    expect(incrSpy).toHaveBeenCalledWith(expect.anything(), 'parent-1')

    upsertSpy.mockRestore()
    incrSpy.mockRestore()
  })

  test('subagent_usage → addSubagentUsage called with mapped token fields', async () => {
    const usageSpy = vi.spyOn(db, 'addSubagentUsage').mockResolvedValue(undefined)

    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    router.handleDaemonMessage(daemonId, {
      type: 'subagent_usage',
      session_id: 'parent-1',
      agent_id: 'agent-abc',
      usage: { input_tokens: 100, output_tokens: 200, cache_read_tokens: 50 },
      seq: 2,
    })

    await new Promise((r) => setTimeout(r, 50))

    expect(usageSpy).toHaveBeenCalledTimes(1)
    const call = usageSpy.mock.calls[0]
    // call[0] = pool, call[1] = parentSessionId, call[2] = agentId, call[3] = inputTokens, call[4] = outputTokens, call[5] = cacheRead
    expect(call[1]).toBe('parent-1')  // session_id → parentSessionId
    expect(call[2]).toBe('agent-abc')  // agent_id → agentId
    expect(call[3]).toBe(100)          // input_tokens
    expect(call[4]).toBe(200)          // output_tokens
    expect(call[5]).toBe(50)           // cache_read_tokens

    usageSpy.mockRestore()
  })
})
