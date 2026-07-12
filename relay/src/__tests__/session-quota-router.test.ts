import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quota.js')>()
  return {
    ...actual,
    claimBoundDaemonSlot: vi.fn(async () => ({ allowed: true, reconnect: false, used: 1, limit: 2 })),
    reserveConcurrentSession: vi.fn(),
    releaseQuotaReservation: vi.fn(async () => undefined),
    getQuotaSnapshot: vi.fn(async () => ({
      resources: {
        bound_hosts: { used: 1, limit: 2, over_limit: false },
        concurrent_sessions: { used: 2, reserved: 0, limit: 2, over_limit: false },
      },
    })),
  }
})

import { Router } from '../router.js'
import { releaseQuotaReservation, reserveConcurrentSession } from '../quota.js'

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
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
      if (sql.includes('SELECT alias FROM daemons')) return { rows: [] }
      if (sql.includes('SELECT daemon_id FROM sessions')) return { rows: [] }
      if (sql.includes('UPDATE sessions') && sql.includes('RETURNING session_id')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    }),
  }
}

function exitedSessionPool(): any {
  const value = pool()
  value.query = vi.fn(async (sql: string) => {
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
    await vi.waitFor(() => expect(releaseQuotaReservation).toHaveBeenCalledWith(expect.anything(), 'reservation-1'))
    expect(client._sent).toContainEqual(expect.objectContaining({ type: 'session_create_failed', request_id: 'request-1', error: 'boom' }))
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
    expect(releaseQuotaReservation).not.toHaveBeenCalled()
  })

  test('applies the same quota when a message revives an exited session', async () => {
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
})
