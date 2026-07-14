import { describe, test, expect, vi, beforeEach } from 'vitest'
// Short the offline grace window so debounce tests run fast. Read by the Router
// constructor, so this must be set before any `new Router(...)`.
process.env.DAEMON_OFFLINE_GRACE_MS = '20'
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
      } else if (sql.includes('SELECT 1 FROM sessions')) {
        // isSessionOwnedByUser: ownership gate. The mock treats every session as
        // owned by the requesting user (auth-specific behaviour is exercised by
        // a dedicated pool override in the authorization tests below).
        result = { rows: [{ '?column?': 1 }], rowCount: 1 }
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
      } else if (sql.includes('UPDATE sessions')) {
        // Existing-row update path: report one affected row so update-only
        // helpers (updateSessionStatus) treat the session as real.
        result = { rows: [], rowCount: 1 }
      }
      return Promise.resolve(result)
    }),
    _queries: queries,
    connect: vi.fn(async () => ({
      query: (sql: string, params?: any[]) => mockPool.query(sql, params),
      release: vi.fn(),
    })),
    end: vi.fn(),
  }
  return mockPool as any
}

// Flush pending microtasks/timers so async persists (and the markPersisted that
// follows them) settle before assertions on the ack water-mark.
const tick = () => new Promise((r) => setTimeout(r, 20))

// Mock WebSocket
function createMockWs(): any {
  const sent: any[] = []
  return {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => { sent.push(JSON.parse(data)) }),
    close: vi.fn(),
    terminate: vi.fn(),
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
    // Offline is now deferred behind the grace window (20ms), then broadcast
    // inside db.getDaemonAlias().then() — wait past the window + microtask.
    await new Promise(r => setTimeout(r, 80))

    const offlineEvent = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offlineEvent).toBeDefined()
    expect(offlineEvent.hostname).toBe('test-macbook')
    expect(offlineEvent.daemon_id).toBe('daemon-1')
    expect(offlineEvent.last_seen_at).toBeDefined()
  })

  test('unregisterDaemon broadcasts session_status: disconnected to subscribed clients', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_discovered', session_id: 'sess-1', cwd: '/tmp', status: 'running', source: 'terminal',
    })

    clientWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    router.unregisterDaemon('daemon-1')
    // Disconnected broadcast is deferred behind the grace window (20ms).
    await new Promise(r => setTimeout(r, 80))

    const discEvent = clientWs._sent.find((m: any) => m.type === 'session_status' && m.status === 'disconnected')
    expect(discEvent).toBeDefined()
    expect(discEvent.session_id).toBe('sess-1')
    expect(discEvent.daemon_id).toBe('daemon-1')
  })

  test('unregisterDaemon does NOT persist disconnected to DB', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)
    router.unregisterDaemon('daemon-1')
    await new Promise(r => setTimeout(r, 80))

    const disconnectUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.params.includes('disconnected')
    )
    expect(disconnectUpdate).toBeUndefined()
  })

  test('session_id_changed ensures real Codex id remains a daemon session', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, 7)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_id_changed',
      session_id: 'real-codex-id',
      old_session_id: 'temp-id',
    })
    await tick()

    const identityInsert = pool._queries.find((q: any) =>
      q.sql.includes('INSERT INTO sessions') &&
      q.sql.includes("source = 'daemon'") &&
      q.params[0] === 'real-codex-id'
    )
    expect(identityInsert).toBeDefined()
    expect(identityInsert.params).toEqual(['real-codex-id', 'daemon-1', 7])
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
    // registerDaemon composes agents as objects {type,version,latest,manageable}
    // (the web client consumes this shape), not a bare string array.
    expect(onlineEvent.agents.map((a: any) => a.type)).toEqual(['claude-code', 'opencode'])
  })
})

describe('Router - session_status with exit_reason', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('session_status is UPDATE-only and never INSERTs a (phantom) session row', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-exit', status: 'exited', exit_reason: 'user_interrupt',
    })

    // The status + exit_reason go out as an UPDATE...
    const updateCall = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('exit_reason') && q.params.includes('user_interrupt')
    )
    expect(updateCall).toBeDefined()
    // ...and crucially, no INSERT (which would materialise a phantom session).
    const insertCall = pool._queries.find((q: any) =>
      q.sql.includes('INSERT INTO sessions') && q.params.includes('sess-exit')
    )
    expect(insertCall).toBeUndefined()
    // Regression guard: user_id must use an explicit cast (COALESCE($5::int)),
    // NOT `CASE WHEN $5 IS NOT NULL` — that pattern left $5's type un-inferrable
    // for Postgres ("could not determine data type of parameter $5") whenever a
    // session_status arrived without a userId, silently dropping the status update.
    expect(updateCall!.sql).not.toMatch(/CASE\s+WHEN\s+\$5/i)
    expect(updateCall!.sql).toMatch(/COALESCE\(\$5::int/i)
  })

  test('session_status without exit_reason does not null existing reason (COALESCE)', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [] }, null)

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-2', status: 'exited', exit_reason: 'normal_exit',
    })

    router.handleDaemonMessage('daemon-1', {
      type: 'session_status', session_id: 'sess-2', status: 'running',
    })

    const statusUpdates = pool._queries.filter((q: any) =>
      q.sql.includes('UPDATE sessions') && q.sql.includes('exit_reason') && q.params.includes('sess-2')
    )
    expect(statusUpdates.length).toBeGreaterThanOrEqual(2)
    // updateSessionStatus params: [sessionId, daemonId, status, exitReason||null, userId||null]
    // The second call carried no exit_reason → null, and COALESCE keeps the old value.
    expect(statusUpdates[1].params[3]).toBeNull()
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

  test('OpenCode Part revisions are persisted and broadcast unchanged', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: ['opencode'] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'test-sid', last_seq: 0 })
    clientWs._sent.length = 0

    const reasoning = {
      type: 'agent_reasoning', session_id: 'test-sid', text: 'checking', streaming: true,
      message_id: 'msg_1', part_id: 'prt_reason', revision: 2, replace: false,
    }
    const replacement = {
      type: 'agent_text', session_id: 'test-sid', text: 'final answer', streaming: false,
      message_id: 'msg_1', part_id: 'prt_text', revision: 3, replace: true,
    }

    router.handleDaemonMessage('daemon-1', reasoning)
    router.handleDaemonMessage('daemon-1', replacement)
    await tick()

    expect(clientWs._sent).toContainEqual(reasoning)
    expect(clientWs._sent).toContainEqual(replacement)
    const inserts = pool._queries.filter((q: any) => q.sql.includes('INSERT INTO events'))
    expect(inserts.some((q: any) => q.params[1] === 'agent_reasoning' && q.params[2]?.includes('"part_id":"prt_reason"'))).toBe(true)
    expect(inserts.some((q: any) => q.params[1] === 'agent_text' && q.params[2]?.includes('"replace":true'))).toBe(true)
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

  test('handleListSessions supports daemon scoped pagination', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    router.handleClientMessage(clientWs, {
      type: 'list_sessions',
      daemon_id: 'daemon-1',
      limit: 1,
      cursor: '0',
    })

    await new Promise(r => setTimeout(r, 50))

    const listEvent = clientWs._sent.find((m: any) => m.type === 'session_list')
    expect(listEvent).toBeDefined()
    expect(listEvent.daemon_id).toBe('daemon-1')
    expect(listEvent.has_more).toBe(false)
    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes('s.daemon_id = $1') &&
      sql.includes('s.session_id DESC') &&
      sql.includes('LIMIT $2') &&
      !sql.includes('OFFSET') &&
      params[0] === 'daemon-1' && params[1] === 2 && params[2] === 1
    )).toBe(true)
  })

  test('handleListSessions uses keyset cursor for next page', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    const cursor = Buffer.from(JSON.stringify({
      pinned: 0,
      pinnedAt: '1970-01-01T00:00:00.000Z',
      activityAt: '2026-01-02T03:04:05.000Z',
      sessionId: 'sess-20',
    }), 'utf8').toString('base64url')

    router.handleClientMessage(clientWs, {
      type: 'list_sessions',
      daemon_id: 'daemon-1',
      limit: 20,
      cursor,
    })

    await new Promise(r => setTimeout(r, 50))

    expect(pool.query.mock.calls.some(([sql, params]: [string, any[]]) =>
      sql.includes(') < ($4, $5::timestamptz, $6::timestamptz, $7)') &&
      !sql.includes('OFFSET') &&
      params[0] === 'daemon-1' &&
      params[1] === 21 &&
      params[2] === 1 &&
      params[3] === 0 &&
      params[6] === 'sess-20'
    )).toBe(true)
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
    router.registerClient(clientWs, 1)

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
    router.registerClient(clientWs, 1)

    // 'test-sid' was NOT in active_session_ids, but the DB mock maps it to daemon-1.
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'test-sid' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt')).toBe(true)
  })

  test('error for unroutable session includes session_id', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)

    // Unknown session: DB returns no rows → falls through to the error.
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'no-such-session' })
    await new Promise(r => setTimeout(r, 10))

    // session_not_found code distinguishes "session doesn't exist" from
    // "daemon unreachable" so the client can avoid pointless retries.
    const errEvent = clientWs._sent.find((m: any) => m.code === 'session_not_found')
    expect(errEvent).toBeDefined()
    expect(errEvent.session_id).toBe('no-such-session')
    expect(errEvent.error).toBe('session not found')
  })

  test('unregisterDaemon drops the daemon\'s session→daemon routes', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, {
      type: 'register', daemon_id: 'daemon-1', hostname: 'test', agents: [],
      active_session_ids: ['sess-a'],
    }, null)
    await new Promise(r => setTimeout(r, 20))

    router.unregisterDaemon('daemon-1')
    // Routes are pruned when the offline transition finalizes (after grace).
    await new Promise(r => setTimeout(r, 80))

    // After disconnect, sess-a is no longer in the routing map (pruned), so a
    // message to it does NOT get forwarded to the dead daemon socket.
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    daemonWs._sent.length = 0
    await router.handleClientMessage(clientWs, { type: 'session_interrupt', session_id: 'sess-a' })

    expect(daemonWs._sent.some((m: any) => m.type === 'session_interrupt')).toBe(false)
  })
})

describe('Router - offline debounce', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    // Longer grace so a reconnect can race inside the window deterministically.
    process.env.DAEMON_OFFLINE_GRACE_MS = '80'
    router = new Router(pool)
  })

  test('reconnect within the grace window cancels the offline transition', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    // Disconnect, then reconnect well within the 80ms window.
    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 20))
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    // Wait past where the original timer would have fired.
    await new Promise(r => setTimeout(r, 120))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeUndefined()
    // No offline push lookup happened either.
    const pushQuery = pool._queries.find((q: any) => q.sql.includes('FROM devices'))
    expect(pushQuery).toBeUndefined()
  })

  test('daemon_shutdown declares offline immediately without waiting for grace', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    router.handleDaemonMessage('daemon-1', { type: 'daemon_shutdown', seq: 1 })
    await new Promise(r => setTimeout(r, 20))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeDefined()
    expect(offline.daemon_id).toBe('daemon-1')
    expect(offline.hostname).toBe('host')
    const offlineUpdate = pool._queries.find((q: any) =>
      q.sql.includes('UPDATE daemons') && q.params.includes('daemon-1')
    )
    expect(offlineUpdate).toBeDefined()
  })

  test('past the grace window the daemon is declared offline and pushed', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 160))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeDefined()
    const pushQuery = pool._queries.find((q: any) => q.sql.includes('FROM devices'))
    expect(pushQuery).toBeDefined()
  })

  test('graceful shutdown suppresses the offline push (but still broadcasts)', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    pool._queries.length = 0

    router.beginShutdown()
    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 160))

    // No APNs push lookup while shutting down...
    const pushQuery = pool._queries.find((q: any) => q.sql.includes('FROM devices'))
    expect(pushQuery).toBeUndefined()
  })

  test('stale-socket close does not schedule an offline transition for the live connection', async () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, 42)

    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)
    // Reconnect on a new socket BEFORE the old one's close arrives.
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)

    clientWs._sent.length = 0
    // Late close from the superseded socket — must be ignored.
    router.unregisterDaemon('daemon-1', ws1)
    await new Promise(r => setTimeout(r, 160))

    const offline = clientWs._sent.find((m: any) => m.type === 'daemon_status' && m.status === 'offline')
    expect(offline).toBeUndefined()
  })

  test('broadcastRelayRestarting notifies connected daemons', async () => {
    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [] }, 42)
    ws1._sent.length = 0
    router.broadcastRelayRestarting()
    expect(ws1._sent.some((m: any) => m.type === 'relay_restarting')).toBe(true)
  })
})

describe('Router - event delivery dedup + ack', () => {
  let pool: any
  let router: Router

  beforeEach(() => {
    pool = createMockPool()
    router = new Router(pool)
  })

  test('register_ack advertises supports_event_ack', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null)
    const ack = daemonWs._sent.find((m: any) => m.type === 'register_ack')
    expect(ack).toBeDefined()
    expect(ack.supports_event_ack).toBe(true)
  })

  test('an already-persisted seq is dropped on replay; a new seq is forwarded', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 }) // subscribe

    clientWs._sent.length = 0
    // First delivery (seq 1) forwards, then (once persisted) advances the mark.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hi', seq: 1 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(1)

    // Replay of the same (now-persisted) seq is dropped — not re-forwarded.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'hi', seq: 1 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(1)

    // A higher seq is a new event and is forwarded.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'next', seq: 2 })
    await tick()
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(2)
  })

  test('ping piggybacks event_ack with the highest CONTIGUOUS persisted seq', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null)
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 1 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 2 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'c', seq: 3 })
    await tick() // let the three persists complete and advance persistedHigh

    daemonWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(3)
  })

  test('ack-after-persist: the mark does not advance until the DB write completes', async () => {
    // Pool whose event INSERT stays pending until we release it, so the persist
    // is in flight when we ping.
    let releaseInsert: (() => void) | undefined
    const pendingPool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('INSERT INTO events')) {
          return new Promise((res) => { releaseInsert = () => res({ rows: [{ id: 1 }] }) })
        }
        if (sql.includes('FROM daemons')) return Promise.resolve({ rows: [{ daemon_id: 'daemon-1', status: 'online' }] })
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      connect: vi.fn(), end: vi.fn(),
    }
    const r = new Router(pendingPool)
    const daemonWs = createMockWs()
    await r.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null)

    r.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'x', seq: 1 })
    // Persist still in flight → ack must NOT cover seq 1 yet.
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    expect(daemonWs._sent.find((m: any) => m.type === 'event_ack')).toBeUndefined()

    // Release the DB write → the mark advances and the next ping acks it.
    releaseInsert!()
    await tick()
    daemonWs._sent.length = 0
    r.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(1)
  })

  test('daemon restart (changed started_at) resets the seq cursor', async () => {
    const ws1 = createMockWs()
    await router.registerDaemon(ws1, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 9 })

    // Daemon process restarts: new started_at, seq counter back to 1.
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 200 }, null)

    clientWs._sent.length = 0
    // seq 1 from the new process must NOT be treated as a duplicate of the old 9.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 1 })
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(1)
  })

  test('register acked_seq seeds the mark so a replayed tail acks without a phantom gap', async () => {
    const daemonWs = createMockWs()
    // Daemon reconnected after the grace window (our entry was dropped) reporting
    // it already had seq 50 acked, and replays only its unacked tail 51,52.
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100, acked_seq: 50 }, null)
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 51 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 52 })
    await tick()

    daemonWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(52) // advanced from the seeded baseline 50, no 1..50 stall
  })

  test('a legacy daemon (no acked_seq) replaying a tail still acks via the first-seq floor', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null) // no acked_seq
    // Replays its unacked tail 71,72 — nothing below was resent.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'a', seq: 71 })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'b', seq: 72 })
    await tick()

    daemonWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'ping' })
    const ack = daemonWs._sent.find((m: any) => m.type === 'event_ack')
    expect(ack).toBeDefined()
    expect(ack.up_to_seq).toBe(72) // floored at 70 from the first seq, no 1..70 stall
  })

  test('legacy events without seq are always processed', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [], started_at: 100 }, null)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'sess-1', last_seq: 0 })

    clientWs._sent.length = 0
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'x' })
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'sess-1', text: 'y' })
    expect(clientWs._sent.filter((m: any) => m.type === 'agent_text').length).toBe(2)
  })
})

describe('Router - WS authorization gate (P0-1)', () => {
  // Pool whose ownership check always denies (SELECT 1 FROM sessions → no row),
  // simulating a session that belongs to a different user than the caller.
  function denyingPool(): any {
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('SELECT 1 FROM sessions')) return Promise.resolve({ rows: [], rowCount: 0 })
        if (sql.includes('FROM sessions') && sql.includes('SELECT')) {
          return Promise.resolve({ rows: [{ daemon_id: 'daemon-1' }] })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      end: vi.fn(),
    }
    pool.connect = vi.fn(async () => ({ query: pool.query, release: vi.fn() }))
    return pool
  }

  test('replay on a non-owned session is rejected and leaks no events', async () => {
    const router = new Router(denyingPool())
    const clientWs = createMockWs()
    router.registerClient(clientWs, 2) // attacker

    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'victim-sess', last_seq: 0 })

    const err = clientWs._sent.find((m: any) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err.error).toBe('session not found or not owned')
    expect(clientWs._sent.some((m: any) => m.type === 'replay_batch')).toBe(false)
  })

  test('a control command on a non-owned session is not forwarded to the daemon', async () => {
    const router = new Router(denyingPool())
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 1)

    const clientWs = createMockWs()
    router.registerClient(clientWs, 2) // different user
    daemonWs._sent.length = 0

    await router.handleClientMessage(clientWs, { type: 'set_permission_config', session_id: 'victim-sess', permission: { agent: 'codex', preset: 'custom', approval_policy: 'never', sandbox_mode: 'workspace-write' } })

    expect(daemonWs._sent.some((m: any) => m.type === 'set_permission_config')).toBe(false)
    expect(clientWs._sent.some((m: any) => m.error === 'session not found or not owned')).toBe(true)
  })

  test('owned permission config is routed unchanged through session ownership, ignoring supplied daemon id', async () => {
    const router = new Router(createMockPool())
    const ownerDaemon = createMockWs()
    const otherDaemon = createMockWs()
    await router.registerDaemon(ownerDaemon, { type: 'register', daemon_id: 'daemon-1', hostname: 'owner', agents: [] }, 1)
    await router.registerDaemon(otherDaemon, { type: 'register', daemon_id: 'daemon-2', hostname: 'other', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    ownerDaemon._sent.length = 0
    otherDaemon._sent.length = 0
    const permission = { agent: 'codex', preset: 'custom', approval_policy: 'never', sandbox_mode: 'workspace-write' }

    await router.handleClientMessage(clientWs, { type: 'set_permission_config', session_id: 'test-sid', daemon_id: 'daemon-2', permission })

    expect(ownerDaemon._sent).toContainEqual({ type: 'set_permission_config', session_id: 'test-sid', daemon_id: 'daemon-2', permission })
    expect(otherDaemon._sent.some((m: any) => m.type === 'set_permission_config')).toBe(false)
  })

  test('permission_config_changed is broadcast unchanged to subscribed clients', async () => {
    const router = new Router(createMockPool())
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 1)
    const clientWs = createMockWs()
    router.registerClient(clientWs, 1)
    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'test-sid', last_seq: 0 })
    clientWs._sent.length = 0
    const event = { type: 'permission_config_changed', session_id: 'test-sid', permission: { agent: 'codex', preset: 'custom', approval_policy: 'never', sandbox_mode: 'workspace-write' }, permission_effective: 'next_turn' }

    router.handleDaemonMessage('daemon-1', event)

    expect(clientWs._sent).toContainEqual(event)
  })

  test('a rejected non-owned session does not subscribe the attacker to its event stream', async () => {
    const router = new Router(denyingPool())
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 1)

    const attackerWs = createMockWs()
    router.registerClient(attackerWs, 2)
    await router.handleClientMessage(attackerWs, { type: 'replay', session_id: 'victim-sess', last_seq: 0 })

    attackerWs._sent.length = 0
    // A live event for the victim's session must not reach the attacker.
    router.handleDaemonMessage('daemon-1', { type: 'agent_text', session_id: 'victim-sess', text: 'secret' })
    expect(attackerWs._sent.some((m: any) => m.type === 'agent_text')).toBe(false)
  })

  test('anonymous (userId=null) connection may not act on a specific session', async () => {
    const router = new Router(denyingPool())
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    await router.handleClientMessage(clientWs, { type: 'replay', session_id: 'any-sess', last_seq: 0 })

    const err = clientWs._sent.find((m: any) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err.error).toBe('forbidden')
  })
})

describe('Router - force kick revokes the daemon-specific token (P0-2)', () => {
  test('handleForceKick revokes daemons.active_token_jti, not an empty jti', async () => {
    const revokeInserts: any[][] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        if (sql.includes('SELECT active_token_jti')) {
          return Promise.resolve({ rows: [{ active_token_jti: 'jti-abc' }], rowCount: 1 })
        }
        if (sql.includes('INSERT INTO revoked_tokens')) {
          revokeInserts.push(params || [])
          return Promise.resolve({ rows: [], rowCount: 1 })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      end: vi.fn(),
    }
    pool.connect = vi.fn(async () => ({ query: pool.query, release: vi.fn() }))
    const router = new Router(pool)
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'daemon-1', hostname: 'h', agents: [] }, 7)

    const res = await router.handleForceKick('daemon-1', 7)
    expect(res.success).toBe(true)

    // The revocation row must carry the daemon's real jti — the old code inserted
    // an empty jti that isTokenRevoked (WHERE jti=$1) could never match.
    expect(revokeInserts.length).toBe(1)
    expect(revokeInserts[0][0]).toBe('jti-abc')      // jti
    expect(revokeInserts[0][1]).toBe(7)              // userId
    expect(revokeInserts[0][2]).toBe('force_kick')   // reason
  })
})

describe('Router - shutdown connections', () => {
  let pool: any
  let router: Router
  beforeEach(() => { pool = createMockPool(); router = new Router(pool) })

  test('terminateAllConnections terminates every daemon and client socket', async () => {
    const daemonWs = createMockWs()
    await router.registerDaemon(daemonWs, { type: 'register', daemon_id: 'd1', hostname: 'h', agents: [] }, null)
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    router.terminateAllConnections()

    expect(daemonWs.terminate).toHaveBeenCalledTimes(1)
    expect(clientWs.terminate).toHaveBeenCalledTimes(1)
  })

  test('broadcastRelayRestarting notifies clients too', () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    router.broadcastRelayRestarting()

    expect(clientWs._sent.find((m: any) => m.type === 'relay_restarting')).toBeDefined()
  })
})

describe('Router - list_daemons restart grace', () => {
  let pool: any
  let router: Router
  beforeEach(() => { pool = createMockPool(); router = new Router(pool) })

  test('DB-online daemon not in memory is optimistic online within startup grace', async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM daemons')) {
        return { rows: [{ daemon_id: 'd-db', hostname: 'host-db', agents: [], alias: null, status: 'online', last_heartbeat: new Date().toISOString(), user_id: 1 }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const clientWs = createMockWs()
    await (router as any).handleListDaemons(clientWs, 1)
    const list = clientWs._sent.find((m: any) => m.type === 'daemon_list')
    expect(list.daemons).toHaveLength(1)
    expect(list.daemons[0].daemon_online).toBe(true)
    expect(list.daemons[0].status).toBe('online')
  })

  test('DB-online daemon not in memory goes offline after startup grace elapses', async () => {
    process.env.RELAY_LIST_GRACE_MS = '0'
    const router2 = new Router(pool)
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM daemons')) {
        return { rows: [{ daemon_id: 'd-db', hostname: 'host-db', agents: [], alias: null, status: 'online', last_heartbeat: new Date().toISOString(), user_id: 1 }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const clientWs = createMockWs()
    await (router2 as any).handleListDaemons(clientWs, 1)
    const list = clientWs._sent.find((m: any) => m.type === 'daemon_list')
    expect(list.daemons[0].daemon_online).toBe(false)
    expect(list.daemons[0].status).toBe('offline')
    delete process.env.RELAY_LIST_GRACE_MS
  })
})
