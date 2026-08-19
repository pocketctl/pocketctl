import { describe, expect, test, vi } from 'vitest'
import {
  countBoundDaemonsLocked,
  claimBoundDaemonSlot,
  getQuotaSnapshot,
  markQuotaReservationUncertain,
  releaseQuotaReservation,
  reserveConcurrentSession,
  settleQuotaReservation,
} from '../quota.js'

function createBinding(reservationId = 'res-1', sessionId: string | null = 'session-new') {
  return {
    reservationId, userId: 7, daemonId: 'daemon-1', requestId: 'request-1',
    operation: 'create' as const, sessionId,
  }
}

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
      daemonId: 'daemon-1',
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
      if (sql.includes('SELECT id, expires_at')) return { rows: [{
        id: 'existing-id', expires_at: expiresAt, operation: 'create', daemon_id: 'daemon-1', session_id: null,
      }] }
      return { rows: [] }
    })

    const decision = await reserveConcurrentSession(pool, {
      userId: 7,
      requestId: 'same-request',
      operation: 'create',
      daemonId: 'daemon-1',
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

  test('non-enforcing users still receive a durable restart-safe reservation', async () => {
    const { pool, client } = fakePool(() => ({ rows: [] }))
    const decision = await reserveConcurrentSession(pool, {
      userId: 9,
      requestId: 'unlimited',
      operation: 'create',
      daemonId: 'daemon-1',
      limit: null,
      now: new Date('2026-08-18T00:00:00Z'),
      agentType: 'codex',
      cwd: '/repo',
    })
    expect(decision).toEqual(expect.objectContaining({
      allowed: true, reservationId: expect.stringMatching(/[0-9a-f-]{36}/), reused: false,
    }))
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO quota_reservations'))).toBe(true)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('AS active_count'))).toBe(false)
  })
})

describe('quota helpers', () => {
  test('does not release the synthetic unlimited grant as a UUID reservation', async () => {
    const { pool, client } = fakePool(() => ({ rows: [] }))

    await releaseQuotaReservation(pool, createBinding('unlimited-018f6f58-38d0-7a32-a444-0123456789ab', null))

    expect(client.query).not.toHaveBeenCalled()
  })

  test('claims only ownership without publishing contender activation metadata', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('SELECT user_id FROM daemons')) return { rows: [{ user_id: 7 }] }
      if (sql.includes('COUNT(*)::int AS count')) return { rows: [{ count: 1 }] }
      if (sql.includes('WITH target AS MATERIALIZED')) return { rows: [{ matched: true, changed: true }] }
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

    // M-4: releasing is now an explicit settlement — never a physical DELETE.
    await releaseQuotaReservation(pool, createBinding('reservation-1'), 'session_created')
    expect(client.query.mock.calls.some(([sql, params]) => String(sql).includes("SET state = 'settled'") && params?.[0] === 'reservation-1')).toBe(true)
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM quota_reservations WHERE id'))).toBe(false)
  })
})


describe('quota reservation accounting state machine (M-4)', () => {
  test('maintenance deletes only settled history rows, never unsettled ones by expiry', async () => {
    const { pool, client } = fakePool(() => ({ rows: [] }))
    await reserveConcurrentSession(pool, {
      userId: 7, requestId: 'cleanup-probe', operation: 'create', daemonId: 'daemon-1', limit: 2,
      now: new Date('2026-08-17T00:00:00Z'),
    })
    const deleteSql = String(client.query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM quota_reservations'))?.[0])
    expect(deleteSql).toBeDefined()
    expect(deleteSql).toContain("state = 'settled'")
    expect(deleteSql).not.toMatch(/DELETE FROM quota_reservations\s+WHERE user_id = \$1 AND expires_at/)
  })

  test('duplicate request reuse matches unsettled rows regardless of grant expiry', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('SELECT id, expires_at')) return { rows: [] }
      return { rows: [] }
    })
    await reserveConcurrentSession(pool, {
      userId: 7, requestId: 'dup', operation: 'create', daemonId: 'daemon-1', limit: 2,
      now: new Date('2026-08-17T00:00:00Z'),
    })
    const reuseSql = String(client.query.mock.calls.find(([sql]) => String(sql).includes('SELECT id, expires_at'))?.[0])
    expect(reuseSql).toContain('state')
    expect(reuseSql).not.toContain("state <> 'settled'")
    expect(reuseSql).not.toContain('expires_at >')
  })

  test('the reservation budget counts pending and uncertain rows regardless of grant expiry', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('AS reservation_count')) return { rows: [{ reservation_count: 2 }] }
      if (sql.includes('AS active_count')) return { rows: [{ active_count: 0 }] }
      return { rows: [] }
    })
    const decision = await reserveConcurrentSession(pool, {
      userId: 7, requestId: 'budget', operation: 'create', daemonId: 'daemon-1', limit: 2,
      now: new Date('2026-08-17T00:00:00Z'),
    })
    expect(decision.allowed).toBe(false)
    const countSql = String(client.query.mock.calls.find(([sql]) => String(sql).includes('AS reservation_count'))?.[0])
    expect(countSql).toContain("state IN ('pending', 'uncertain')")
    expect(countSql).not.toContain('expires_at >')
  })

  test('settleQuotaReservation requires an explicit reason and is idempotent', async () => {
    const { pool, client } = fakePool(() => ({ rows: [{ matched: true, changed: true }] }))
    await expect(settleQuotaReservation(pool, createBinding(), undefined as unknown as import('../quota.js').QuotaSettlementReason)).rejects.toThrow('reason')
    await expect(settleQuotaReservation(pool, createBinding(), 'not-a-reason' as unknown as import('../quota.js').QuotaSettlementReason)).rejects.toThrow('reason')

    await expect(settleQuotaReservation(pool, createBinding(), 'session_created')).resolves.toEqual({ matched: true, changed: true })
    const sql = String(client.query.mock.calls[0][0])
    expect(sql).toContain("state = 'settled'")
    expect(sql).toContain("state <> 'settled'")
    expect(sql).toContain('settled_at')

    // A second settle of the same reservation is a no-op, not an error.
    const { pool: pool2, client: client2 } = fakePool(() => ({ rows: [{ matched: true, changed: false }] }))
    await expect(settleQuotaReservation(pool2, createBinding(), 'session_created')).resolves.toEqual({ matched: true, changed: false })
    expect(String(client2.query.mock.calls[0][0])).toContain("state <> 'settled'")
  })

  test('settlement SQL cannot identify a reservation by UUID alone', async () => {
    const { pool, client } = fakePool(() => ({ rows: [{ matched: true, changed: true }] }))

    await settleQuotaReservation(pool, createBinding('res-bound'), 'session_created')

    const sql = String(client.query.mock.calls[0][0])
    expect(sql).toContain('user_id =')
    expect(sql).toContain('daemon_id =')
    expect(sql).toContain('request_id =')
    expect(sql).toContain('operation =')
    expect(sql).toContain('session_id')
  })

  test('settleQuotaReservation ignores the synthetic unlimited grant', async () => {
    const { pool, client } = fakePool(() => ({ rows: [] }))
    await expect(settleQuotaReservation(pool, createBinding('unlimited-xyz'), 'session_created')).resolves.toEqual({ matched: true, changed: false })
    expect(client.query).not.toHaveBeenCalled()
  })

  test('markQuotaReservationUncertain transitions pending once and never overrides settled', async () => {
    const { pool, client } = fakePool(() => ({ rows: [{ matched: true, changed: true }] }))
    await markQuotaReservationUncertain(pool, createBinding('res-1', null), 'grant_timeout')
    const sql = String(client.query.mock.calls[0][0])
    expect(sql).toContain("state = 'uncertain'")
    expect(sql).toContain("state = 'pending'")
    expect(sql).not.toContain("SET state = 'settled'")

    // Idempotent: an already-uncertain row simply matches zero rows.
    const { pool: pool2 } = fakePool(() => ({ rows: [{ matched: true, changed: false }] }))
    await expect(markQuotaReservationUncertain(pool2, createBinding('res-1', null), 'daemon_offline')).resolves.toEqual({ matched: true, changed: false })
  })

  test('snapshot reserved count reads unsettled rows', async () => {
    const { pool, client } = fakePool((sql) => {
      if (sql.includes('FROM daemons')) return { rows: [{ count: 1 }] }
      if (sql.includes('AS active_count')) return { rows: [{ active_count: 1 }] }
      if (sql.includes('AS reservation_count')) return { rows: [{ reservation_count: 1 }] }
      return { rows: [] }
    })
    const snapshot = await getQuotaSnapshot(pool, 7, { maxBoundDaemons: 2, maxConcurrentSessions: 2 })
    expect(snapshot.resources.concurrent_sessions.reserved).toBe(1)
    const countSql = String(client.query.mock.calls.find(([sql]) => String(sql).includes('AS reservation_count'))?.[0])
    expect(countSql).toContain("state IN ('pending', 'uncertain')")
    expect(countSql).not.toContain('expires_at >')
  })
})
