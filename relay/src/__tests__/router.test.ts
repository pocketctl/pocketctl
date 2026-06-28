import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Router } from '../router.js'

// Mock pg.Pool
function createMockPool() {
  const queries: { sql: string; params: any[] }[] = []
  const mockPool = {
    query: vi.fn((sql: string, params?: any[]) => {
      queries.push({ sql, params: params || [] })
      let result: any = { rows: [], rowCount: 0 }
      if (sql.includes('SELECT column_name')) {
        result = { rows: [{ column_name: 'last_activity_at' }, { column_name: 'exit_reason' }] }
      } else if (sql.includes('ALTER TABLE')) {
        result = { rows: [] }
      } else if (sql.includes('FROM sessions') && sql.includes('SELECT')) {
        result = {
          rows: [{
            session_id: 'test-sid',
            daemon_id: 'daemon-1',
            agent_type: 'claude-code',
            cwd: '/tmp',
            title: 'Test',
            source: 'terminal',
            status: 'running',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            exit_reason: null,
            daemon_status: 'online',
          }]
        }
      } else if (sql.includes('FROM daemons')) {
        result = { rows: [{ daemon_id: 'daemon-1', status: 'online' }] }
      } else if (sql.includes('RETURNING id')) {
        result = { rows: [{ id: 1 }] }
      }
      return Promise.resolve(result)
    }),
    _queries: queries,
    connect: vi.fn(),
    end: vi.fn(),
  }
  return mockPool as any
}

// Mock WebSocket
function createMockWs(): any {
  const sent: any[] = []
  return {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => { sent.push(JSON.parse(data)) }),
    close: vi.fn(),
    _sent: sent,
  }
}

describe('Router - daemon disconnect', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('unregisterDaemon broadcasts daemon_status: offline with hostname', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register',
      daemon_id: 'daemon-1',
      hostname: 'test-macbook',
      agents: ['claude-code'],
    }, null)

    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    router.unregisterDaemon('daemon-1')
    // unregisterDaemon broadcasts inside db.getDaemonAlias().then() — wait for microtask
    await new Promise(r => setTimeout(r, 10))

    const offlineEvent = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offlineEvent).toBeDefined()
    expect(offlineEvent.hostname).toBe('test-macbook')
    expect(offlineEvent.daemon_id).toBe('daemon-1')
    expect(offlineEvent.last_seen_at).toBeDefined()
  })

  test('unregisterDaemon broadcasts session_status: disconnected to subscribed clients', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_discovered', session_id: 'sess-1', cwd: '/tmp', status: 'running', source: 'terminal',
    })

    clientWs._sent.length = 0
    router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    router.unregisterDaemon('daemon-1')

    const discEvent = clientWs._sent.find((m: any) => m.type === 'session_status' && m.status === 'disconnected')
    expect(discEvent).toBeDefined()
    expect(discEvent.session_id).toBe('sess-1')
    expect(discEvent.daemon_id).toBe('daemon-1')
  })

  test('unregisterDaemon does NOT persist disconnected to DB', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)
    router.unregisterDaemon('daemon-1')

    const disconnectUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.params.includes('disconnected')
    )
    expect(disconnectUpdate).toBeUndefined()
  })
})

describe('Router - daemon reconnect', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('registerDaemon broadcasts daemon_status: online with hostname and agents', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-2', hostname: 'mac-pro', agents: ['claude-code', 'opencode'],
    }, null)

    const onlineEvent = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'online')
    expect(onlineEvent).toBeDefined()
    expect(onlineEvent.hostname).toBe('mac-pro')
    expect(onlineEvent.daemon_id).toBe('daemon-2')
    expect(onlineEvent.agents).toEqual(['claude-code', 'opencode'])
  })
})

describe('Router - session_status with exit_reason', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('exit_reason is passed to upsertSession', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-exit', status: 'exited', exit_reason: 'user_interrupt',
    })

    const upsertCall = pool._queries.find((q: any) =>
      q.sql.includes('INSERT INTO sessions') && q.params.includes('user_interrupt')
    )
    expect(upsertCall).toBeDefined()
  })

  test('session_status without exit_reason does not null existing reason', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-2', status: 'exited', exit_reason: 'normal_exit',
    })

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-2', status: 'running',
    })

    const secondUpsert = pool._queries.filter((q: any) =>
      q.sql.includes('INSERT INTO sessions') && q.params.includes('sess-2')
    )
    expect(secondUpsert.length).toBeGreaterThanOrEqual(2)
    expect(secondUpsert[1].params[7]).toBeNull()
  })
})

describe('Router - event insertion updates last_activity_at', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('insertEvent triggers last_activity_at update', async () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    router.handleDaemonMessage('daemon-1', {
      type: 'agent_text', session_id: 'sess-3', text: 'hello', streaming: false,
    })

    await new Promise(r => setTimeout(r, 50))

    const activityUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('last_activity_at')
    )
    expect(activityUpdate).toBeDefined()
    expect(activityUpdate.params).toContain('sess-3')
  })
})

describe('Router - list_sessions includes extended fields', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('handleListSessions returns daemon_online field', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    router.handleClientMessage(clientWs, { type: 'list_sessions' })

    await new Promise(r => setTimeout(r, 50))

    const listEvent = clientWs._sent.find((m: any) => m.type === 'session_list')
    expect(listEvent).toBeDefined()
    if (listEvent && listEvent.sessions && listEvent.sessions.length > 0) {
      const s = listEvent.sessions[0]
      expect(s).toHaveProperty('daemon_online')
      expect(s).toHaveProperty('last_activity_at')
      expect(s).toHaveProperty('exit_reason')
      expect(s).not.toHaveProperty('daemon_status')
    }
  })
})

describe('Router - session→daemon routing resilience', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('rebuildSessionRoutes rehydrates routes from reported + DB session IDs on register', async () => {
    const daemonWs = createMockWs()
    // Daemon reports two live sessions; DB mock additionally returns 'test-sid'.
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['sess-a', 'sess-b'],
    }, null)
    // rebuildSessionRoutes fires async on register — let it settle.
    await new Promise(r => setTimeout(r, 20))

    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    // A session never seen in-memory this connection (sess-a) should now route
    // to the daemon without hitting the "session not found" error.
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'sess-a' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt' && m.session_id === 'sess-a')).toBe(true)
    expect(clientWs._sent.some((m: any) => m.error === 'session not found or daemon offline')).toBe(false)
  })

  test('reconciles zombie sessions on register: closes running/busy rows not in active_session_ids and notifies clients', async () => {
    // Custom pool: the reconcile UPDATE returns one zombie that the daemon no
    // longer reports as live. Everything else falls through to empty results.
    const reconcilePool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes("status = 'completed'") && sql.includes('RETURNING session_id')) {
          return Promise.resolve({ rows: [{ session_id: 'zombie-1' }], rowCount: 1 })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      connect: vi.fn(), end: vi.fn(),
    }
    const r = new Router(reconcilePool)

    const clientWs = createMockWs()
    r.registerClient(clientWs, null)

    const daemonWs = createMockWs()
    // Daemon reports only 'live-1' as active; 'zombie-1' is stale running/busy in DB.
    await r.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['live-1'],
    }, null)
    await new Promise(res => setTimeout(res, 20))

    // Reconcile UPDATE ran with the daemon's live set as the exclusion array.
    const reconcileCall = reconcilePool.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'completed'") && c[0].includes('RETURNING session_id')
    )
    expect(reconcileCall).toBeDefined()
    expect(reconcileCall[1]).toEqual(['daemon-1', ['live-1']])

    // The closed session is pushed to the client as completed.
    const evt = clientWs._sent.find((m: any) => m.type === 'session_status' && m.session_id === 'zombie-1')
    expect(evt).toBeDefined()
    expect(evt.status).toBe('completed')
  })

  test('skips reconcile for legacy daemons that do not report active_session_ids', async () => {
    const reconcilePool: any = {
      query: vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
      connect: vi.fn(), end: vi.fn(),
    }
    const r = new Router(reconcilePool)
    const daemonWs = createMockWs()
    // No active_session_ids field → must NOT run the reconcile UPDATE.
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)
    await new Promise(res => setTimeout(res, 20))

    const ranReconcile = reconcilePool.query.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'completed'") && c[0].includes('RETURNING session_id')
    )
    expect(ranReconcile).toBe(false)
  })

  test('routing falls back to DB daemon_id when in-memory map misses', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)
    await new Promise(r => setTimeout(r, 20))

    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    // 'test-sid' was NOT in active_session_ids, but the DB mock maps it to daemon-1.
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'test-sid' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt')).toBe(true)
  })

  test('error for unroutable session includes session_id', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    // Unknown session: DB returns no rows → falls through to the error.
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'no-such-session' })
    await new Promise(r => setTimeout(r, 10))

    const errEvent = clientWs._sent.find((m: any) => m.error === 'session not found or daemon offline')
    expect(errEvent).toBeDefined()
    expect(errEvent.session_id).toBe('no-such-session')
  })

  test('unregisterDaemon drops the daemon\'s session→daemon routes', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['sess-a'],
    }, null)
    await new Promise(r => setTimeout(r, 20))

    router.unregisterDaemon('daemon-1')
    await new Promise(r => setTimeout(r, 20))

    // After disconnect, sess-a is no longer in the routing map (pruned), so a
    // message to it does NOT get forwarded to the dead daemon socket.
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'sess-a' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt')).toBe(false)
  })
})
