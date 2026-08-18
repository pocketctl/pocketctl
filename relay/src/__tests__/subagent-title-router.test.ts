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
    hasDefaultSubagentTitle: actual.hasDefaultSubagentTitle,
    updateSubagentTitleIfDefault: actual.updateSubagentTitleIfDefault,
  }
})

// Mock title module so DeepSeek is never called in tests.
// CRITICAL: vi.mock replaces the module at resolution time, so the router's
// named import (`import { generateSubagentTitle } from './title.js'`) receives
// the mock. vi.spyOn on a named-imported function would NOT intercept the
// router's already-bound reference — that's why we use vi.mock here.
vi.mock('../title.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../title.js')>()
  return {
    ...actual,
    generateSubagentTitle: vi.fn().mockResolvedValue(''),
  }
})

import * as db from '../db.js'
import * as titleMod from '../title.js'
import { Router } from '../router.js'

// Minimal pool: satisfies Router constructor's type but never used for real queries.
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

describe('router generate_subagent_title_request → db/title/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('success path: generates title, writes to db, broadcasts subagent_title_update', async () => {
    const hasDefaultSpy = vi.spyOn(db, 'hasDefaultSubagentTitle').mockResolvedValue(true)
    const genSpy = vi.mocked(titleMod.generateSubagentTitle).mockResolvedValue('审查 · compose.prod.yml')
    const updateSpy = vi.spyOn(db, 'updateSubagentTitleIfDefault').mockResolvedValue(true)

    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    // Subscribe a mock client to the parent session so broadcast reaches it
    const clientWs = createMockWs()
    // Simulate client subscription (access private clients Map via any cast)
    ;(router as any).clients.set(clientWs, {
      subscribedSessions: new Set(['parent-1']),
      userId: 1,
      locale: 'zh',
    })

    router.handleDaemonMessage(daemonId, {
      type: 'generate_subagent_title_request',
      session_id: 'parent-1',
      agent_id: 'agent-x',
      parent_session_id: 'parent-1',
      user_message: 'Review compose for security',
      subagent_type: 'security-review',
      seq: 1,
    })

    await new Promise((r) => setTimeout(r, 100))

    // Assert hasDefaultSubagentTitle called with correct args
    expect(hasDefaultSpy).toHaveBeenCalledTimes(1)
    expect(hasDefaultSpy).toHaveBeenCalledWith(expect.anything(), 'parent-1', 'agent-x')

    // Assert generateSubagentTitle called with userMessage, agentType, locale
    expect(genSpy).toHaveBeenCalledTimes(1)
    expect(genSpy).toHaveBeenCalledWith('Review compose for security', 'security-review', 'zh')

    // Assert updateSubagentTitleIfDefault called with correct args
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), 'parent-1', 'agent-x', '审查 · compose.prod.yml')

    // Assert broadcast: clientWs received subagent_title_update
    const sent = clientWs._sent as any[]
    const titleMsg = sent.find((m) => m.type === 'subagent_title_update')
    expect(titleMsg).toBeDefined()
    expect(titleMsg!.session_id).toBe('parent-1')
    expect(titleMsg!.agent_id).toBe('agent-x')
    expect(titleMsg!.parent_session_id).toBe('parent-1')
    expect(titleMsg!.title).toBe('审查 · compose.prod.yml')

    hasDefaultSpy.mockRestore()
    genSpy.mockReset()
    updateSpy.mockRestore()
  })

  test('skip path: hasDefaultSubagentTitle returns false → no generation, no db write, no broadcast', async () => {
    const hasDefaultSpy = vi.spyOn(db, 'hasDefaultSubagentTitle').mockResolvedValue(false)
    const genSpy = vi.mocked(titleMod.generateSubagentTitle)
    const updateSpy = vi.spyOn(db, 'updateSubagentTitleIfDefault')

    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    const clientWs = createMockWs()
    ;(router as any).clients.set(clientWs, {
      subscribedSessions: new Set(['parent-1']),
      userId: 1,
      locale: 'en',
    })

    router.handleDaemonMessage(daemonId, {
      type: 'generate_subagent_title_request',
      session_id: 'parent-1',
      agent_id: 'agent-x',
      parent_session_id: 'parent-1',
      user_message: 'Review compose for security',
      subagent_type: 'security-review',
      seq: 1,
    })

    await new Promise((r) => setTimeout(r, 100))

    // Assert hasDefaultSubagentTitle was called but the rest were skipped
    expect(hasDefaultSpy).toHaveBeenCalledTimes(1)
    expect(genSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()

    // No broadcast
    const sent = clientWs._sent as any[]
    expect(sent.find((m) => m.type === 'subagent_title_update')).toBeUndefined()

    hasDefaultSpy.mockRestore()
    updateSpy.mockRestore()
  })

  test('missing agent_id → returns early without calling db or title', async () => {
    const hasDefaultSpy = vi.spyOn(db, 'hasDefaultSubagentTitle')
    const genSpy = vi.mocked(titleMod.generateSubagentTitle)

    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    router.handleDaemonMessage(daemonId, {
      type: 'generate_subagent_title_request',
      session_id: 'parent-1',
      agent_id: '',
      parent_session_id: 'parent-1',
      user_message: 'Review compose for security',
      subagent_type: 'security-review',
      seq: 1,
    })

    await new Promise((r) => setTimeout(r, 50))

    expect(hasDefaultSpy).not.toHaveBeenCalled()
    expect(genSpy).not.toHaveBeenCalled()

    hasDefaultSpy.mockRestore()
  })

  test('generateSubagentTitle returns empty → no db write, no broadcast', async () => {
    vi.spyOn(db, 'hasDefaultSubagentTitle').mockResolvedValue(true)
    vi.mocked(titleMod.generateSubagentTitle).mockResolvedValue('')
    const updateSpy = vi.spyOn(db, 'updateSubagentTitleIfDefault')

    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    const clientWs = createMockWs()
    ;(router as any).clients.set(clientWs, {
      subscribedSessions: new Set(['parent-1']),
      userId: 1,
      locale: 'en',
    })

    router.handleDaemonMessage(daemonId, {
      type: 'generate_subagent_title_request',
      session_id: 'parent-1',
      agent_id: 'agent-x',
      parent_session_id: 'parent-1',
      user_message: 'Review compose for security',
      subagent_type: 'security-review',
      seq: 1,
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(updateSpy).not.toHaveBeenCalled()
    const sent = clientWs._sent as any[]
    expect(sent.find((m) => m.type === 'subagent_title_update')).toBeUndefined()

    updateSpy.mockRestore()
  })
})
