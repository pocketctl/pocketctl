import { describe, test, expect, vi, beforeEach } from 'vitest'
// Short the offline grace window (read by the Router constructor).
process.env.DAEMON_OFFLINE_GRACE_MS = '20'

import { generateTitle } from '../title.js'

// Mock the GLM-backed title generator so the test exercises router dispatch,
// not the network. Hoisted above the Router import by vitest.
vi.mock('../title.js', () => ({
  generateTitle: vi.fn(),
}))

import { Router } from '../router.js'

// Minimal pool: hasDefaultTitle → true (default placeholder), updateTitleIfDefault → updated.
function createMockPool(): any {
  return {
    query: vi.fn((sql: string) => {
      let result: any = { rows: [], rowCount: 0 }
      if (sql.includes('SELECT 1 FROM sessions')) {
        result = { rows: [{ '?column?': 1 }], rowCount: 1 }
      } else if (sql.includes('UPDATE sessions')) {
        result = { rows: [], rowCount: 1 }
      }
      return Promise.resolve(result)
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

// P1 fix: session_title_update used to filter by subscribedSessions.has(sid),
// but the list view never subscribes — so it never received title updates.
// Now it broadcasts to all of the owner's online clients (sameUser), matching
// session_created/discovered. These tests pin that behaviour.
describe('Router - session_title_update broadcasts to unsubscribed same-user clients (P1)', () => {
  beforeEach(() => {
    vi.mocked(generateTitle).mockReset()
  })

  test('generate_title_request 成功 → 未订阅的同用户 client 收到 session_title_update', async () => {
    vi.mocked(generateTitle).mockResolvedValue('AI标题')
    const router = new Router(createMockPool())

    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'd1', hostname: 'h', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1) // same userId=1, NOT subscribed to sess-1

    router.handleDaemonMessage('d1', {
      type: 'generate_title_request',
      session_id: 'sess-1',
      user_message: 'u',
      assistant_message: 'a',
      seq: 1,
    })

    // generateTitle + DB checks are async (chained .then); let them settle.
    await new Promise((r) => setTimeout(r, 100))

    const evt = clientWs._sent.find((m: any) => m.type === 'session_title_update')
    expect(evt).toBeDefined()
    expect(evt.title).toBe('AI标题')
    expect(evt.session_id).toBe('sess-1')
  })

  test('不同用户的 client 收不到 title 更新（sameUser 隔离）', async () => {
    vi.mocked(generateTitle).mockResolvedValue('AI标题')
    const router = new Router(createMockPool())

    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'd1', hostname: 'h', agents: [] }, 1)
    const otherClientWs = createMockWs()
    router.registerClient(otherClientWs, 2) // different userId=2

    router.handleDaemonMessage('d1', {
      type: 'generate_title_request',
      session_id: 'sess-1',
      user_message: 'u',
      assistant_message: 'a',
      seq: 1,
    })

    await new Promise((r) => setTimeout(r, 100))

    const evt = otherClientWs._sent.find((m: any) => m.type === 'session_title_update')
    expect(evt).toBeUndefined()
  })

  test('generateTitle 失败（返回空串）→ 不下发、不写库（commit 1 的语义）', async () => {
    vi.mocked(generateTitle).mockResolvedValue('')
    const pool = createMockPool()
    const router = new Router(pool)

    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'd1', hostname: 'h', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.handleDaemonMessage('d1', {
      type: 'generate_title_request',
      session_id: 'sess-1',
      user_message: 'u',
      assistant_message: 'a',
      seq: 1,
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(clientWs._sent.find((m: any) => m.type === 'session_title_update')).toBeUndefined()
    // 失败时不应该走 updateTitleIfDefault（不会有 title LIKE 'Terminal Session-%' 的 UPDATE）
    const titleUpdate = pool.query.mock.calls.find((c: any) =>
      typeof c[0] === 'string' && c[0].includes('UPDATE sessions') && c[0].includes('Terminal Session-%'))
    expect(titleUpdate).toBeUndefined()
  })
})
