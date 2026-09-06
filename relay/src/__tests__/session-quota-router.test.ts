import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quota.js')>()
  return {
    ...actual,
    claimBoundDaemonSlot: vi.fn(async () => ({ allowed: true, reconnect: false, used: 1, limit: 2 })),
    claimQuotaReservationSession: vi.fn(async () => ({ matched: true, changed: true })),
    reserveConcurrentSession: vi.fn(),
    releaseQuotaReservation: vi.fn(async () => undefined),
    settleQuotaReservation: vi.fn(async () => ({ matched: true, changed: true })),
    markQuotaReservationUncertain: vi.fn(async () => ({ matched: true, changed: true })),
    getQuotaSnapshot: vi.fn(async () => ({
      resources: {
        bound_hosts: { used: 1, limit: 2, over_limit: false },
        concurrent_sessions: { used: 2, reserved: 0, limit: 2, over_limit: false },
      },
    })),
  }
})

vi.mock('../session-message-admissions.js', async (original) => ({
  ...await original<typeof import('../session-message-admissions.js')>(),
  admitSessionMessage: vi.fn(),
}))

import { admitSessionMessage } from '../session-message-admissions.js'
import { Router } from '../router.js'
import {
  claimQuotaReservationSession,
  getQuotaSnapshot,
  markQuotaReservationUncertain,
  releaseQuotaReservation,
  reserveConcurrentSession,
  settleQuotaReservation,
} from '../quota.js'

process.env.QUOTA_ENFORCEMENT = 'enforce'

function ws(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    _sent: sent,
  }
}

function pool(): any {
  const value: any = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO events')) {
        return { rows: [{ id: 31, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
      }
      if (sql.includes('SELECT effect_status')) {
        return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
      }
      if (sql.includes('RETURNING daemon_id')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
      if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
      if (sql.includes('SELECT alias FROM daemons')) return { rows: [] }
      if (sql.includes('SELECT daemon_id FROM sessions')) return { rows: [] }
      if (sql.includes('UPDATE sessions') && sql.includes('RETURNING session_id')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    }),
  }
  value.connect = vi.fn(async () => ({ query: (...args: any[]) => value.query(...args), release: vi.fn() }))
  return value
}

function exitedSessionPool(): any {
  const value = pool()
  value.query = vi.fn(async (sql: string) => {
    if (sql.includes('RETURNING daemon_id')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
    if (sql.includes('SELECT 1 FROM sessions')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
    if (sql.includes('SELECT status FROM sessions')) return { rows: [{ status: 'exited' }] }
    if (sql.includes('SELECT daemon_id FROM sessions')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (sql.includes('SELECT alias FROM daemons')) return { rows: [] }
    return { rows: [], rowCount: 0 }
  })
  return value
}

function activeSessionPool(): any {
  const value = pool()
  value.query = vi.fn(async (sql: string) => {
    if (sql.includes('RETURNING daemon_id')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (sql.includes('SELECT 1 FROM sessions')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
    if (sql.includes('SELECT status FROM sessions')) return { rows: [{ status: 'running' }] }
    if (sql.includes('SELECT daemon_id FROM sessions')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (sql.includes('SELECT alias FROM daemons')) return { rows: [] }
    return { rows: [], rowCount: 0 }
  })
  return value
}

function observerSessionPool(): any {
  const value = pool()
  value.query = vi.fn(async (sql: string, params?: any[]) => {
    if (sql.includes('WITH owned_session')) {
      const owned = params?.[0] === 'observer-session' && params?.[1] === 7
      return {
        rows: owned ? [{
          daemon_id: 'd1', agent_type: 'codex-desktop', status: 'exited',
          source: 'observer', control_mode: 'legacy_read_only', capabilities: ['history_sync'],
        }] : [],
        rowCount: owned ? 1 : 0,
      }
    }
    if (sql.includes('RETURNING daemon_id')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
    if (sql.includes('SELECT 1 FROM sessions')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
    if (sql.includes('SELECT status FROM sessions')) return { rows: [{ status: 'exited' }] }
    if (sql.includes('SELECT daemon_id FROM sessions')) return { rows: [{ daemon_id: 'd1' }], rowCount: 1 }
    if (sql.includes('SELECT alias FROM daemons')) return { rows: [] }
    return { rows: [], rowCount: 0 }
  })
  return value
}

describe('Router active-session quota', () => {
  test('admission database failure nacks without forwarding or subscribing', async () => {
    vi.mocked(admitSessionMessage).mockRejectedValueOnce(new Error('database unavailable'))
    const router = new Router(activeSessionPool()), daemon = ws(), client = ws()
    await router.registerDaemon(daemon, { type:'register',daemon_id:'d1',hostname:'host',agents:[],supports_quota_grant:true },7)
    router.registerClient(client,7)
    daemon._sent.length = 0
    await router.handleClientMessage(client,{type:'user_message',session_id:'active-session',msg_id:'failure',content:'continue'})
    expect(daemon._sent).toEqual([])
    expect((router as any).clients.get(client).subscribedSessions.size).toBe(0)
    expect(client._sent).toContainEqual(expect.objectContaining({type:'user_message_nack',reason:'quota_check_failed',retryable:true}))
  })

  beforeEach(() => vi.clearAllMocks())

  test('rejects a third remote create before it reaches the daemon', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: false,
      reason: 'concurrent_session_quota_exceeded',
      used: 2,
      reserved: 0,
      limit: 2,
    })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0

    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-3', agent: 'codex', cwd: '/repo',
    })

    expect(daemon._sent.some((event: any) => event.type === 'session_create')).toBe(false)
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed',
      request_id: 'request-3',
      reason: 'concurrent_session_quota_exceeded',
      used: 2,
      limit: 2,
    }))
  })

  test('forwards an allowed create with its reservation grant and releases on failure', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-1',
      expiresAt: 1_800_000_000_000,
      reused: false,
    })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0

    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-1', agent: 'codex', cwd: '/repo',
    })

    expect(daemon._sent).toContainEqual(expect.objectContaining({
      type: 'session_create',
      request_id: 'request-1',
      quota_grant: { reservation_id: 'reservation-1', expires_at: 1_800_000_000_000, operation: 'create' },
    }))

    router.handleDaemonMessage('d1', {
      type: 'session_create_failed', request_id: 'request-1', reservation_id: 'reservation-1', reason: 'start_fail', error: 'boom',
    })
    await vi.waitFor(() => expect(settleQuotaReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-1', userId: 7, daemonId: 'd1', requestId: 'request-1',
      operation: 'create', sessionId: null,
    }), 'session_create_failed'))
    expect(client._sent).toContainEqual(expect.objectContaining({ type: 'session_create_failed', request_id: 'request-1', error: 'boom' }))
  })

  test('awaits reservation release before reading and broadcasting quota for a durable create', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-ordered',
      expiresAt: 1_800_000_000_000,
      reused: false,
    })
    let release!: () => void
    vi.mocked(settleQuotaReservation).mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ matched: true, changed: true })
    }))
    const value = pool()
    value.query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
      if (sql.includes('INSERT INTO events')) {
        return { rows: [{ id: 11, inserted: true, effect_status: 'pending', effect_step: 0 }] }
      }
      return { rows: [], rowCount: 1 }
    })
    const router = new Router(value)
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true, started_at: 100 }, 7)
    await vi.waitFor(() => expect(getQuotaSnapshot).toHaveBeenCalled())
    vi.mocked(getQuotaSnapshot).mockClear()
    router.registerClient(client, 7)
    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-ordered', agent: 'codex', cwd: '/repo',
    })
    await vi.waitFor(() => expect(getQuotaSnapshot).toHaveBeenCalled())
    vi.mocked(getQuotaSnapshot).mockClear()

    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'sess-1', event_id: 'created-ordered', request_id: 'request-ordered', seq: 1,
    })
    await vi.waitFor(() => expect(settleQuotaReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-ordered', userId: 7, daemonId: 'd1', requestId: 'request-ordered',
      operation: 'create', sessionId: 'sess-1',
    }), 'session_created'))
    expect(getQuotaSnapshot).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(getQuotaSnapshot).toHaveBeenCalled())
  })

  test('coalesces a duplicate create while the original request is pending', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-duplicate',
      expiresAt: 1_800_000_000_000,
      reused: false,
    })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0

    const request = {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-duplicate', agent: 'codex', cwd: '/repo',
    }
    await router.handleClientMessage(client, request)
    await router.handleClientMessage(client, request)

    expect(reserveConcurrentSession).toHaveBeenCalledTimes(1)
    expect(daemon._sent.filter((event: any) => event.type === 'session_create')).toHaveLength(1)
    expect(settleQuotaReservation).not.toHaveBeenCalled()
  })

  test('a durable reused create attaches to the outcome without redispatching the grant', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-reused',
      expiresAt: Date.now() + 60_000,
      reused: true,
    })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [],
      supports_quota_grant: true, started_at: 100,
    }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0

    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-reused',
      agent: 'codex', cwd: '/repo',
    })

    expect(daemon._sent.some((event: any) => event.type === 'session_create')).toBe(false)
    expect(client._sent).toContainEqual({
      type: 'session_create_pending', request_id: 'request-reused',
      reason: 'request_in_progress', retryable: true,
    })
    expect((router as any).materializationContext('d1', {
      type: 'session_created', request_id: 'request-reused', session_id: 'reused-session',
    })).toMatchObject({
      requestId: 'request-reused', reservationId: 'reservation-reused', quotaOperation: 'create',
    })
  })

  test('applies the same quota when a message revives an exited session', async () => {
    vi.mocked(admitSessionMessage).mockResolvedValue({ kind: 'resume', decision: { allowed: false, reason: 'concurrent_session_quota_exceeded', used: 2, reserved: 0, limit: 2 } })
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: false,
      reason: 'concurrent_session_quota_exceeded',
      used: 2,
      reserved: 0,
      limit: 2,
    })
    const router = new Router(exitedSessionPool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0

    await router.handleClientMessage(client, {
      type: 'user_message', session_id: 'exited-session', msg_id: 'message-1', content: 'continue',
    })

    expect(daemon._sent.some((event: any) => event.type === 'user_message')).toBe(false)
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'user_message_nack',
      msg_id: 'message-1',
      reason: 'concurrent_session_quota_exceeded',
      used: 2,
      limit: 2,
    }))
  })

  test('forwards an active-session message without reserving another concurrent slot', async () => {
    vi.mocked(admitSessionMessage).mockResolvedValue({ kind: 'continue', reused: false, admission: { id: '550e8400-e29b-41d4-a716-446655440000', userId: 7, daemonId: 'd1', sessionId: 'active-session', requestId: 'message-active', state: 'issued', expiresAt: new Date(Date.now() + 20000) } })
    const router = new Router(activeSessionPool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0

    await router.handleClientMessage(client, {
      type: 'user_message', session_id: 'active-session', msg_id: 'message-active', content: 'continue',
    })

    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect(daemon._sent).toContainEqual(expect.objectContaining({
      type: 'user_message',
      session_id: 'active-session',
      msg_id: 'message-active',
      request_id: 'message-active',
      quota_grant: expect.objectContaining({
        reservation_id: '550e8400-e29b-41d4-a716-446655440000',
        operation: 'resume',
      }),
    }))
  })

  test.each(['codex-desktop', 'zcode'])('rejects %s create before reserving quota or tracking pending work', async (agent) => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true, reservationId: 'must-not-reserve', expiresAt: Date.now() + 60_000, reused: false,
    })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true,
    }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0
    vi.mocked(reserveConcurrentSession).mockClear()

    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: `create-${agent}`, agent, cwd: '/repo',
    })

    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed', request_id: `create-${agent}`,
      reason: 'observer_read_only', retryable: false,
    }))
  })

  test('rejects an exited observer message before resume quota reservation and pending tracking', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true, reservationId: 'must-not-resume', expiresAt: Date.now() + 60_000, reused: false,
    })
    const router = new Router(observerSessionPool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true,
    }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0
    vi.mocked(reserveConcurrentSession).mockClear()

    await router.handleClientMessage(client, {
      type: 'user_message', session_id: 'observer-session', request_id: 'resume-observer',
      msg_id: 'observer-message', content: 'must not resume',
    })

    expect(reserveConcurrentSession).not.toHaveBeenCalled()
    expect((router as any).pendingSessionOperations.size).toBe(0)
    expect(daemon._sent).toEqual([])
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'user_message_nack', session_id: 'observer-session', request_id: 'resume-observer',
      msg_id: 'observer-message', reason: 'observer_read_only', retryable: false,
    }))
  })
})


describe('Router unresolved quota grants fail closed (M-4)', () => {
  beforeEach(() => vi.clearAllMocks())

  async function setupPendingCreate(expiresAt: number) {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-m4',
      expiresAt,
      reused: false,
    })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0
    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-m4', agent: 'codex', cwd: '/repo',
    })
    return { router, daemon, client }
  }

  test('a silent daemon grant timeout marks the reservation uncertain instead of releasing it', async () => {
    const { client } = await setupPendingCreate(Date.now() + 40)
    await new Promise((r) => setTimeout(r, 80))
    await vi.waitFor(() => expect(markQuotaReservationUncertain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-m4', userId: 7, daemonId: 'd1', requestId: 'request-m4',
      operation: 'create', sessionId: null,
    }), 'grant_timeout'))
    expect(settleQuotaReservation).not.toHaveBeenCalled()
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed',
      request_id: 'request-m4',
      reason: 'timeout',
    }))
  })

  test('a daemon disconnect mid-create marks the reservation uncertain, not settled', async () => {
    const { router, client } = await setupPendingCreate(Date.now() + 60_000)
    router.unregisterDaemon('d1')
    await vi.waitFor(() => expect(markQuotaReservationUncertain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-m4', userId: 7, daemonId: 'd1', requestId: 'request-m4',
      operation: 'create', sessionId: null,
    }), 'daemon_offline'))
    expect(settleQuotaReservation).not.toHaveBeenCalled()
    expect(settleQuotaReservation).not.toHaveBeenCalled()
    expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed',
      reason: 'daemon_offline',
    }))
  })

  test('an explicit daemon failure settles the reservation with a reason', async () => {
    const { router, client } = await setupPendingCreate(Date.now() + 60_000)
    router.handleDaemonMessage('d1', {
      type: 'session_create_failed', request_id: 'request-m4', reason: 'start_fail', error: 'boom',
    })
    await vi.waitFor(() => expect(settleQuotaReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-m4', userId: 7, daemonId: 'd1', requestId: 'request-m4',
      operation: 'create', sessionId: null,
    }), 'session_create_failed'))
    expect(markQuotaReservationUncertain).not.toHaveBeenCalled()
    expect(releaseQuotaReservation).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(client._sent).toContainEqual(expect.objectContaining({
      type: 'session_create_failed', request_id: 'request-m4',
    })))
  })

  test('a mismatched request cannot borrow another create reservation on the same daemon', async () => {
    const { router } = await setupPendingCreate(Date.now() + 60_000)

    const context = (router as any).materializationContext('d1', {
      type: 'session_status',
      session_id: 'already-running-session',
      status: 'running',
      request_id: 'attacker-request',
      reservation_id: 'reservation-m4',
    })

    expect(context).toMatchObject({
      requestId: 'attacker-request',
      reservationId: null,
    })
  })

  test('a daemon-reported reservation id is never accepted without a server-side pending request', async () => {
    const router = new Router(pool())

    const context = (router as any).materializationContext('d1', {
      type: 'session_created',
      session_id: 'forged-session',
      request_id: 'forged-request',
      reservation_id: 'forged-reservation',
    })

    expect(context).toMatchObject({
      requestId: 'forged-request',
      reservationId: null,
    })
  })

  test('materialized session_created settles the reservation as session_created', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-ok',
      expiresAt: Date.now() + 60_000,
      reused: false,
    })
    const value = pool()
    value.query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
      if (sql.includes('INSERT INTO events')) {
        return { rows: [{ id: 21, inserted: true, effect_status: 'pending', effect_step: 0 }] }
      }
      return { rows: [], rowCount: 1 }
    })
    const router = new Router(value)
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'host', agents: [], supports_quota_grant: true, started_at: 100 }, 7)
    await vi.waitFor(() => expect(getQuotaSnapshot).toHaveBeenCalled())
    vi.mocked(getQuotaSnapshot).mockClear()
    router.registerClient(client, 7)
    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-ok', agent: 'codex', cwd: '/repo',
    })
    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'sess-m4', event_id: 'created-m4', request_id: 'request-ok', seq: 1,
    })
    await vi.waitFor(() => expect(settleQuotaReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reservationId: 'reservation-ok', userId: 7, daemonId: 'd1', requestId: 'request-ok',
      operation: 'create', sessionId: 'sess-m4',
    }), 'session_created'))
    expect(markQuotaReservationUncertain).not.toHaveBeenCalled()
  })

  test('a contradictory legacy quota outcome is ACKed and the daemon is permanently rejected', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-conflict',
      expiresAt: Date.now() + 60_000,
      reused: false,
    })
    vi.mocked(claimQuotaReservationSession).mockResolvedValueOnce({ matched: false, changed: false })
    const router = new Router(pool())
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [],
      supports_quota_grant: true, started_at: 100,
    }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0
    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-conflict',
      agent: 'codex', cwd: '/repo',
    })

    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'conflicting-session',
      event_id: 'conflicting-event', request_id: 'request-conflict', seq: 1,
    })

    await vi.waitFor(() => expect(daemon.close).toHaveBeenCalledWith(
      1008, 'quota_reservation_binding_mismatch',
    ))
    expect(daemon._sent).toContainEqual({ type: 'event_ack', up_to_seq: 1 })
    expect(daemon._sent).toContainEqual({
      type: 'kicked', reason: 'quota_reservation_binding_mismatch', retryable: false,
    })
    expect(settleQuotaReservation).not.toHaveBeenCalled()
  })

  test('an effect-stage ownership race is ACKed and permanently rejected', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-ownership-race',
      expiresAt: Date.now() + 60_000,
      reused: false,
    })
    const value = pool()
    const baseQuery = value.query
    value.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sessions') && sql.includes('RETURNING session_id')) {
        // Authorization observed the id as free, but another tenant claimed it
        // before this deferred upsert reached the ownership-guarded conflict.
        return { rows: [], rowCount: 0 }
      }
      return baseQuery(sql, params)
    })
    const router = new Router(value)
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [],
      supports_quota_grant: true, started_at: 100,
    }, 7)
    router.registerClient(client, 7)
    daemon._sent.length = 0
    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'request-ownership-race',
      agent: 'codex', cwd: '/repo',
    })

    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'contended-session',
      event_id: 'contended-event', request_id: 'request-ownership-race', seq: 1,
    })

    await vi.waitFor(() => expect(daemon.close).toHaveBeenCalledWith(
      1008, 'session_ownership_violation',
    ))
    expect(daemon._sent).toContainEqual({ type: 'event_ack', up_to_seq: 1 })
    expect(daemon._sent).toContainEqual({
      type: 'kicked', reason: 'session_ownership_violation', retryable: false,
    })
    expect(settleQuotaReservation).not.toHaveBeenCalled()
  })

  test('an initial recovery mismatch is explicitly ACKed before permanent disconnect', async () => {
    const value = pool()
    const baseQuery = value.query
    value.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM quota_reservations reservation')) {
        return {
          rows: [{
            id: '00000000-0000-0000-0000-000000000777',
            resource: 'concurrent_session', operation: 'create', daemon_id: 'd1',
            session_id: null, state: 'settled', settlement_reason: 'session_create_failed',
            agent_type: 'codex', cwd: '/repo', hostname: 'host',
          }],
          rowCount: 1,
        }
      }
      return baseQuery(sql, params)
    })
    const router = new Router(value)
    const daemon = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [],
      supports_quota_grant: true, started_at: 100,
    }, 7)
    daemon._sent.length = 0

    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'recovery-conflict-session',
      request_id: 'recovery-conflict-request', event_id: 'recovery-conflict-event', seq: 1,
    })

    await vi.waitFor(() => expect(daemon.close).toHaveBeenCalledWith(
      1008, 'quota_reservation_binding_mismatch',
    ))
    expect(daemon._sent).toContainEqual({ type: 'event_ack', up_to_seq: 1 })
  })

  test('a queued recovery mismatch waits for the lower durable effect before ACK and disconnect', async () => {
    vi.mocked(reserveConcurrentSession).mockResolvedValue({
      allowed: true,
      reservationId: 'reservation-seq-1',
      expiresAt: Date.now() + 60_000,
      reused: false,
    })
    let releaseClaim!: () => void
    vi.mocked(claimQuotaReservationSession).mockImplementationOnce(() => new Promise(resolve => {
      releaseClaim = () => resolve({ matched: true, changed: true })
    }))
    const value = pool()
    const baseQuery = value.query
    value.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM quota_reservations reservation')
        && params?.[1] === 'queued-recovery-conflict') {
        return {
          rows: [{
            id: '00000000-0000-0000-0000-000000000778',
            resource: 'concurrent_session', operation: 'create', daemon_id: 'd1',
            session_id: null, state: 'settled', settlement_reason: 'session_create_failed',
            agent_type: 'codex', cwd: '/repo', hostname: 'host',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO sessions') && sql.includes('RETURNING session_id')) {
        return { rows: [{ session_id: 'seq-1-session' }], rowCount: 1 }
      }
      return baseQuery(sql, params)
    })
    const router = new Router(value)
    const daemon = ws()
    const client = ws()
    await router.registerDaemon(daemon, {
      type: 'register', daemon_id: 'd1', hostname: 'host', agents: [],
      supports_quota_grant: true, started_at: 100,
    }, 7)
    router.registerClient(client, 7)
    await router.handleClientMessage(client, {
      type: 'session_create', daemon_id: 'd1', request_id: 'seq-1-request',
      agent: 'codex', cwd: '/repo',
    })
    daemon._sent.length = 0

    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'seq-1-session',
      request_id: 'seq-1-request', event_id: 'seq-1-event', seq: 1,
    })
    await vi.waitFor(() => expect(claimQuotaReservationSession).toHaveBeenCalled())
    router.handleDaemonMessage('d1', {
      type: 'session_created', session_id: 'queued-conflict-session',
      request_id: 'queued-recovery-conflict', event_id: 'queued-conflict-event', seq: 2,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(daemon.close).not.toHaveBeenCalled()
    expect(daemon._sent).not.toContainEqual({ type: 'event_ack', up_to_seq: 2 })

    releaseClaim()
    await vi.waitFor(() => expect(daemon.close).toHaveBeenCalledWith(
      1008, 'quota_reservation_binding_mismatch',
    ))
    expect(daemon._sent).toContainEqual({ type: 'event_ack', up_to_seq: 2 })
  })
})
