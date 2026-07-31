import { describe, test, expect, vi, beforeEach } from 'vitest'

// Short the offline grace window (read by the Router constructor).
process.env.DAEMON_OFFLINE_GRACE_MS = '20'

// Mock DB functions so registerDaemon / persistAndAck don't touch real PG.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    persistEvent: vi.fn().mockResolvedValue(1),
    persistEventWithEffect: vi.fn().mockResolvedValue({
      rowID: 1, inserted: true, completed: false, nextStep: 0,
    }),
    getUserPlanAndWhitelist: vi.fn().mockResolvedValue({ plan: 'pro', whitelist: false }),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    setDaemonOnline: vi.fn().mockResolvedValue(undefined),
    getDaemonAlias: vi.fn().mockResolvedValue(null),
    getDaemonOwner: vi.fn().mockResolvedValue(null),
    activateDaemonRegistration: vi.fn().mockResolvedValue(null),
    restoreDaemonRegistration: vi.fn().mockResolvedValue(undefined),
    // The functions under test — spied via the module, not the mock factory,
    // so the router code path calls the real export which is the spy.
    upsertSubagent: actual.upsertSubagent,
    reconcileSubagent: actual.reconcileSubagent,
    addSubagentUsage: actual.addSubagentUsage,
    incrementSubagentCount: actual.incrementSubagentCount,
  }
})

import * as db from '../db.js'
import { Router } from '../router.js'

// Minimal pool: satisfies Router constructor's type but never used for real queries.
// query returns { rows: [] } by default so pool.query(...).rows[0] never throws.
// Returns rowCount: 1 for subagent_usage_seen INSERTs so the dedup gate passes through.
function createMockPool(): any {
  return {
    query: vi.fn(async (sql: string) => {
      if (/subagent_usage_seen/i.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
  }
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

  test('Claude subagent discovery preserves existing mapping', async () => {
    const reconcileSpy = vi.spyOn(db, 'reconcileSubagent').mockResolvedValue(undefined)
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

    await new Promise((r) => setTimeout(r, 50))

    expect(reconcileSpy).toHaveBeenCalledWith(expect.anything(), {
      parentSessionId: 'parent-1',
      agentId: 'agent-abc',
      rootSessionId: 'parent-1',
      kind: 'claude_subagent',
      toolUseId: 'call_xyz',
      agentType: 'Explore',
      title: 'find foo',
    })
    expect(incrSpy).not.toHaveBeenCalled()
  })

  test('Codex subagent discovery maps internal kind without changing agent type', async () => {
    const reconcileSpy = vi.spyOn(db, 'reconcileSubagent').mockResolvedValue(undefined)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    router.handleDaemonMessage(daemonId, {
      type: 'subagent_discovered', session_id: 'root', root_session_id: 'root',
      agent_id: 'child', agent: 'codex', subagent_type: 'codex',
      subagent_desc: 'Newton', seq: 1,
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(reconcileSpy).toHaveBeenCalledWith(expect.anything(), {
      parentSessionId: 'root', agentId: 'child', rootSessionId: 'root',
      kind: 'codex_subagent', toolUseId: undefined,
      agentType: 'codex', title: 'Newton',
    })
  })

  test('subagent discovery advances ack only after reconciliation succeeds', async () => {
    const reconcileSpy = vi.spyOn(db, 'reconcileSubagent')
      .mockRejectedValueOnce(new Error('reconcile failed'))
      .mockResolvedValueOnce(undefined)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)
    const event = {
      type: 'subagent_discovered', session_id: 'root', root_session_id: 'root',
      agent_id: 'child', agent: 'codex', subagent_type: 'codex',
      subagent_desc: 'Newton', seq: 1,
    }

    router.handleDaemonMessage(daemonId, event)
    await new Promise((r) => setTimeout(r, 50))
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(0)

    router.handleDaemonMessage(daemonId, event)
    await new Promise((r) => setTimeout(r, 50))
    expect((router as any).daemonSeq.get(daemonId).persistedHigh).toBe(1)
    expect(reconcileSpy).toHaveBeenCalledTimes(2)
  })

})
