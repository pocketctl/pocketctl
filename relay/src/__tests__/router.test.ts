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

  test('unregisterDaemon broadcasts daemon_status: offline with hostname', () => {
    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, {
      type: 'register',
      daemon_id: 'daemon-1',
      hostname: 'test-macbook',
      agents: ['claude-code'],
    }, null)

    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    router.unregisterDaemon('daemon-1')

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

  test('registerDaemon broadcasts daemon_status: online with hostname and agents', () => {
    const clientWs = createMockWs()
    router.registerClient(clientWs, null)

    const daemonWs = createMockWs()
    router.registerDaemon(daemonWs, {
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
