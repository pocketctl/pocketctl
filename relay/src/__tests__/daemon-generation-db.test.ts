import { describe, expect, test, vi } from 'vitest'
import {
  activateDaemonRegistration,
  revokeToken,
  restoreDaemonRegistration,
  reconcileDaemonSessions,
} from '../db.js'

function transactionalPool(handler: (sql: string, params?: any[]) => any) {
  const query = vi.fn(async (sql: string, params?: any[]) => handler(sql, params))
  const client = { query, release: vi.fn() }
  return { pool: { query, connect: vi.fn(async () => client) } as any, query }
}

describe('daemon registration generation DB guards', () => {
  test('takes the token advisory fence and rechecks revocation before daemon mutation', async () => {
    const { pool, query } = transactionalPool((sql) => {
      if (sql.includes('revoked_tokens')) return { rows: [], rowCount: 0 }
      if (sql.includes('FOR UPDATE')) return { rows: [] }
      if (sql.includes('RETURNING daemon_id')) return { rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })

    await activateDaemonRegistration(pool, {
      daemonId: 'daemon-1', userId: 7, hostname: 'new', agents: [], startedAt: 200,
      tokenJti: 'token-1', registrationId: 'generation-1',
    })

    const sql = query.mock.calls.map(([statement]) => String(statement))
    const fence = sql.findIndex((statement) => statement.includes('pg_advisory_xact_lock'))
    const revoked = sql.findIndex((statement) => statement.includes('FROM revoked_tokens'))
    const mutation = sql.findIndex((statement) => statement.includes('INSERT INTO daemons'))
    expect(fence).toBeGreaterThan(0)
    expect(fence).toBeLessThan(revoked)
    expect(revoked).toBeLessThan(mutation)
  })

  test('serializes revocation with activation so revoke-first registration cannot come online', async () => {
    let held = false
    const waiters: Array<() => void> = []
    const revoked = new Set<string>()
    let online = false
    let revokeHasFence!: () => void
    const revokeFence = new Promise<void>((resolve) => { revokeHasFence = resolve })
    let allowRevokeInsert!: () => void
    const revokeInsertGate = new Promise<void>((resolve) => { allowRevokeInsert = resolve })

    const acquire = async () => {
      if (!held) { held = true; return }
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    const release = () => {
      const next = waiters.shift()
      if (next) next()
      else held = false
    }
    const makePool = (role: 'activate' | 'revoke') => ({
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM revoked_tokens')) return { rows: revoked.has(params?.[0]) ? [{ '?column?': 1 }] : [], rowCount: revoked.has(params?.[0]) ? 1 : 0 }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (sql === 'BEGIN') return {}
          if (sql.includes('pg_advisory_xact_lock')) {
            await acquire()
            if (role === 'revoke') revokeHasFence()
            return { rows: [], rowCount: 1 }
          }
          if (role === 'revoke' && sql.includes('INSERT INTO revoked_tokens')) {
            await revokeInsertGate
            revoked.add(params?.[0])
            return { rows: [], rowCount: 1 }
          }
          if (sql.includes('FROM revoked_tokens')) {
            const found = revoked.has(params?.[0])
            return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 }
          }
          if (sql.includes('FROM daemons') && sql.includes('FOR UPDATE')) return { rows: [], rowCount: 0 }
          if (sql.includes('INSERT INTO daemons')) { online = true; return { rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 } }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') { release(); return {} }
          return { rows: [], rowCount: 1 }
        }),
        release: vi.fn(),
      })),
    }) as any

    const revoking = revokeToken(makePool('revoke'), 'token-1', 7, 'force_kick')
    await revokeFence
    const activating = activateDaemonRegistration(makePool('activate'), {
      daemonId: 'daemon-1', userId: 7, hostname: 'new', agents: [],
      tokenJti: 'token-1', registrationId: 'generation-1',
    })
    allowRevokeInsert()

    await revoking
    await expect(activating).rejects.toThrow(/token revoked/i)
    expect(revoked.has('token-1')).toBe(true)
    expect(online).toBe(false)
  })

  test('linearizes activation-first before a waiting revoke and leaves the token revoked', async () => {
    let releaseFence!: () => void
    const fenceReleased = new Promise<void>((resolve) => { releaseFence = resolve })
    let activationHasFence!: () => void
    const activationFence = new Promise<void>((resolve) => { activationHasFence = resolve })
    let allowActivationCommit!: () => void
    const activationCommitGate = new Promise<void>((resolve) => { allowActivationCommit = resolve })
    let revoked = false
    let online = false
    let revokeInserted = false

    const activationPool: any = {
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('pg_advisory_xact_lock')) { activationHasFence(); return {} }
          if (sql.includes('FROM revoked_tokens')) return { rows: [], rowCount: 0 }
          if (sql.includes('FROM daemons') && sql.includes('FOR UPDATE')) return { rows: [], rowCount: 0 }
          if (sql.includes('INSERT INTO daemons')) { online = true; return { rows: [{ daemon_id: 'daemon-1' }], rowCount: 1 } }
          if (sql === 'COMMIT') { await activationCommitGate; releaseFence(); return {} }
          return { rows: [], rowCount: 1 }
        }),
        release: vi.fn(),
      })),
    }
    const revokePool: any = {
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (sql.includes('pg_advisory_xact_lock')) { await fenceReleased; return {} }
          if (sql.includes('INSERT INTO revoked_tokens')) { revoked = true; revokeInserted = true; return { rows: [], rowCount: 1 } }
          return { rows: [], rowCount: 1 }
        }),
        release: vi.fn(),
      })),
    }

    const activating = activateDaemonRegistration(activationPool, {
      daemonId: 'daemon-1', userId: 7, hostname: 'new', agents: [],
      tokenJti: 'token-1', registrationId: 'generation-1',
    })
    await activationFence
    const revoking = revokeToken(revokePool, 'token-1', 7, 'force_kick')
    await Promise.resolve()
    expect(revokeInserted).toBe(false)
    allowActivationCommit()

    await activating
    await revoking
    expect(online).toBe(true)
    expect(revoked).toBe(true)
  })

  test('revokeToken uses the same transaction-scoped token fence', async () => {
    const { pool, query } = transactionalPool(() => ({ rows: [], rowCount: 1 }))
    await revokeToken(pool, 'token-1', 7, 'force_kick')
    const sql = query.mock.calls.map(([statement]) => String(statement))
    expect(sql[0]).toBe('BEGIN')
    expect(sql[1]).toContain('pg_advisory_xact_lock')
    expect(sql[2]).toContain('INSERT INTO revoked_tokens')
    expect(sql[3]).toBe('COMMIT')
  })

  test('activates metadata and token together and restores only the expected generation', async () => {
    const previous = {
      hostname: 'old', agents: [], status: 'online', started_at: 100,
      active_token_jti: 'old-token', registration_id: 'old-generation',
    }
    const { pool, query } = transactionalPool((sql) => {
      if (sql.includes('FROM revoked_tokens')) return { rows: [], rowCount: 0 }
      if (sql.includes('FOR UPDATE')) return { rows: [previous] }
      if (sql.includes('RETURNING daemon_id')) return { rows: [{ daemon_id: 'daemon-1' }] }
      return { rows: [], rowCount: 1 }
    })
    const snapshot = await activateDaemonRegistration(pool, {
      daemonId: 'daemon-1', userId: 7, hostname: 'new', agents: [], startedAt: 200,
      arch: 'arm64', version: 'v2', tokenJti: 'new-token', machineId: 'machine', registrationId: 'generation-2',
    })
    expect(snapshot).toMatchObject(previous)
    const activationSql = String(query.mock.calls.find(([sql]) => String(sql).includes('active_token_jti'))?.[0])
    expect(activationSql).toContain('registration_id')
    expect(activationSql).toContain('active_token_jti')

    await expect(restoreDaemonRegistration(pool, 'daemon-1', 'generation-2', snapshot))
      .resolves.toEqual({ status: 'confirmed_restored' })
    const restoreCall = query.mock.calls.find(([sql]) => String(sql).includes('WHERE daemon_id') && String(sql).includes('registration_id ='))
    expect(restoreCall?.[1]).toContain('generation-2')
  })

  test('distinguishes a successor CAS miss from a restoration SQL failure', async () => {
    const casMiss: any = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
    await expect(restoreDaemonRegistration(casMiss, 'daemon-1', 'old', null))
      .resolves.toEqual({ status: 'stale_successor' })

    const failure = new Error('database unavailable')
    const broken: any = { query: vi.fn(async () => { throw failure }) }
    await expect(restoreDaemonRegistration(broken, 'daemon-1', 'old', null))
      .resolves.toEqual({ status: 'sql_failure', error: failure })
  })

  test('sets offline only for the expected registration generation', async () => {
    const { setDaemonOffline } = await import('../db.js')
    const pool: any = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
    await expect(setDaemonOffline(pool, 'daemon-1', 'generation-1')).resolves.toBe(false)
    expect(pool.query.mock.calls[0][0]).toContain('registration_id')
    expect(pool.query.mock.calls[0][1]).toEqual(['daemon-1', 'generation-1'])
  })

  test('bounds generation offline CAS with transaction-local statement timeout and releases the client', async () => {
    const dbModule = await import('../db.js')
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("status = 'offline'")) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const release = vi.fn()
    const pool: any = { connect: vi.fn(async () => ({ query, release })) }

    await expect((dbModule as any).setDaemonOfflineWithTimeout(pool, 'daemon-1', 'generation-1', 250))
      .resolves.toBe(true)

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringContaining("set_config('statement_timeout'"),
      expect.stringContaining("UPDATE daemons SET status = 'offline'"),
      'COMMIT',
    ])
    expect(query.mock.calls[1][1]).toEqual(['250'])
    expect(query.mock.calls[2][1]).toEqual(['daemon-1', 'generation-1'])
    expect(release).toHaveBeenCalledOnce()
  })

  test('rolls back and releases the offline CAS client on statement timeout', async () => {
    const dbModule = await import('../db.js')
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("status = 'offline'")) throw timeout
      return { rows: [], rowCount: 0 }
    })
    const release = vi.fn()
    const pool: any = { connect: vi.fn(async () => ({ query, release })) }

    await expect((dbModule as any).setDaemonOfflineWithTimeout(pool, 'daemon-1', 'generation-1', 250))
      .rejects.toBe(timeout)
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  test('bounds revocation lookup with transaction-local statement timeout and releases the client', async () => {
    const dbModule = await import('../db.js')
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes('FROM revoked_tokens')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const release = vi.fn()
    const pool: any = { connect: vi.fn(async () => ({ query, release })) }

    await expect((dbModule as any).isTokenRevokedWithTimeout(pool, 'token-1', 250)).resolves.toBe(true)
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringContaining("set_config('statement_timeout'"),
      expect.stringContaining('SELECT 1 FROM revoked_tokens'),
      'COMMIT',
    ])
    expect(query.mock.calls[1][1]).toEqual(['250'])
    expect(query.mock.calls[2][1]).toEqual(['token-1'])
    expect(release).toHaveBeenCalledOnce()
  })

  test('rolls back and releases the revocation lookup client on statement timeout', async () => {
    const dbModule = await import('../db.js')
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM revoked_tokens')) throw timeout
      return { rows: [], rowCount: 0 }
    })
    const release = vi.fn()
    const pool: any = { connect: vi.fn(async () => ({ query, release })) }

    await expect((dbModule as any).isTokenRevokedWithTimeout(pool, 'token-1', 250)).rejects.toBe(timeout)
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  test('refuses stale reconcile before updating sessions', async () => {
    const { pool, query } = transactionalPool((sql) => {
      if (sql.includes('registration_id') && sql.includes('FOR UPDATE')) return { rows: [] }
      return { rows: [], rowCount: 1 }
    })
    await expect(reconcileDaemonSessions(pool, 'daemon-1', ['B'], 'old-generation')).resolves.toEqual([])
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE sessions SET status'))).toBe(false)
  })
})
