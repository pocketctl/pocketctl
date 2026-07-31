import { describe, expect, test, vi } from 'vitest'
import {
  countBoundDaemonsLocked,
  claimBoundDaemonSlot,
  getQuotaSnapshot,
  releaseQuotaReservation,
  reserveConcurrentSession,
} from '../quota.js'

function fakePool(handler: (sql: string, params?: any[]) => any) {
  const client = {
    query: vi.fn(async (sql: string, params?: any[]) => handler(sql, params)),
    release: vi.fn(),
  }
  return {
    pool: { connect: vi.fn(async () => client), query: client.query } as any,
    client,
  }
}

describe('reserveConcurrentSession', () => {
  test('locks the user and reserves the last available root-session slot', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('SELECT id, expires_at')) return { rows: [] }
      if (sql.includes('AS active_count')) return { rows: [{ active_count: 1 }] }
      if (sql.includes('AS reservation_count')) return { rows: [{ reservation_count: 0 }] }
      if (sql.includes('INSERT INTO quota_reservations')) return { rows: [] }
      return { rows: [] }
    })

    const decision = await reserveConcurrentSession(pool, {
      userId: 7,
      requestId: 'request-1',
      operation: 'create',
      daemonId: 'daemon-1',
      limit: 2,
      now: new Date('2026-07-12T00:00:00Z'),
    })

    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.reservationId).toMatch(/[0-9a-f-]{36}/)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toBe(true)
    const activeSql = String(client.query.mock.calls.find(([sql]) => String(sql).includes('AS active_count'))?.[0])
    expect(activeSql).toContain("'idle'")
    expect(activeSql).toContain('COALESCE(is_subagent, false) = false')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('rejects when confirmed sessions plus reservations reach the limit', async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes('SELECT id, expires_at')) return { rows: [] }
      if (sql.includes('AS active_count')) return { rows: [{ active_count: 1 }] }
      if (sql.includes('AS reservation_count')) return { rows: [{ reservation_count: 1 }] }
      return { rows: [] }
    })

    await expect(reserveConcurrentSession(pool, {
      userId: 7,
      requestId: 'request-2',
      operation: 'resume',
      sessionId: 'session-old',
      limit: 2,
    })).resolves.toEqual({
      allowed: false,
      reason: 'concurrent_session_quota_exceeded',
      used: 1,
      reserved: 1,
      limit: 2,
    })
  })

  test('returns an existing unexpired reservation for a duplicate request', async () => {
    const expiresAt = new Date(Date.now() + 10_000)
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('SELECT id, expires_at')) return { rows: [{ id: 'existing-id', expires_at: expiresAt }] }
      return { rows: [] }
    })

    const decision = await reserveConcurrentSession(pool, {
      userId: 7,
      requestId: 'same-request',
      operation: 'create',
      limit: 2,
    })

    expect(decision).toEqual({
      allowed: true,
      reservationId: 'existing-id',
      expiresAt: expiresAt.getTime(),
      reused: true,
    })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO quota_reservations'))).toBe(false)
  })

  test('unlimited users do not need a reservation', async () => {
    const { pool } = fakePool(() => ({ rows: [] }))
    await expect(reserveConcurrentSession(pool, {
      userId: 9,
      requestId: 'unlimited',
      operation: 'create',
      limit: null,
    })).resolves.toEqual({ allowed: true, reservationId: null, expiresAt: null, reused: false })
  })
})

describe('quota helpers', () => {
  test('claims only ownership without publishing contender activation metadata', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('SELECT user_id FROM daemons')) return { rows: [{ user_id: 7 }] }
      if (sql.includes('COUNT(*)::int AS count')) return { rows: [{ count: 1 }] }
      return { rows: [] }
    })
    await expect(claimBoundDaemonSlot(pool, {
      userId: 7, daemonId: 'daemon-1', hostname: 'contender', agents: [{ type: 'opencode' }],
      arch: 'arm64', version: 'new', startedAt: 200, limit: 2,
    })).resolves.toMatchObject({ allowed: true, reconnect: true })
    const mutation = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO daemons'))
    expect(mutation).toBeUndefined()
  })

  test('counts offline and online bound daemons', async () => {
    const query = vi.fn(async (_sql: string, _params?: any[]) => ({ rows: [{ count: 2 }] }))
    await expect(countBoundDaemonsLocked({ query } as any, 3)).resolves.toBe(2)
    expect(String(query.mock.calls[0][0])).not.toContain('status')
  })

  test('builds a snapshot and releases reservations', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('FROM daemons')) return { rows: [{ count: 2 }] }
      if (sql.includes('AS active_count')) return { rows: [{ active_count: 3 }] }
      if (sql.includes('AS reservation_count')) return { rows: [{ reservation_count: 0 }] }
      return { rows: [] }
    })

    const snapshot = await getQuotaSnapshot(pool, 4, {
      maxBoundDaemons: 2,
      maxConcurrentSessions: 2,
    })
    expect(snapshot.resources.bound_hosts).toEqual({ used: 2, limit: 2, over_limit: false })
    expect(snapshot.resources.concurrent_sessions).toEqual({ used: 3, reserved: 0, limit: 2, over_limit: true })

    await releaseQuotaReservation(pool, 'reservation-1')
    expect(client.query.mock.calls.some(([sql, params]) => String(sql).includes('DELETE FROM quota_reservations') && params?.[0] === 'reservation-1')).toBe(true)
  })
})
