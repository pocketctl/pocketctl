import { describe, test, expect, vi } from 'vitest'
import { handleRefreshReuse } from '../db.js'

// handleRefreshReuse decides what the refresh endpoint does when a client
// presents an already-rotated refresh token (reuse). Reuse is most often a
// stale local token (daemon SaveAuth failed), not theft — so the tolerance
// policy must NOT permanently breach. A real breach (reuse) used to revoke the
// token and return 401, which after 3 retries triggers the daemon's
// authRejectStopThreshold and silently parks the host (the m3-pro incident).

describe('handleRefreshReuse — tolerance policy', () => {
  function mockPool() {
    const queries: { sql: string; params: any[] }[] = []
    const pool: any = {
      query: vi.fn((sql: string, params?: any[]) => {
        queries.push({ sql, params: params || [] })
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
    }
    return { pool, queries }
  }

  test('reused jti: tolerate — allow refresh to continue (no breach)', async () => {
    const { pool, queries } = mockPool()
    const block = await handleRefreshReuse(pool, 3, 'g_kl9Gmv')
    expect(block).toBe(false) // false = do NOT block; let a new token be issued
  })

  test('records an audit entry so reuse stays observable for theft detection', async () => {
    const { pool, queries } = mockPool()
    await handleRefreshReuse(pool, 3, 'g_kl9Gmv')
    const audit = queries.find((q) => q.sql.includes('audit_log') && q.sql.includes('INSERT'))
    expect(audit).toBeTruthy()
    expect(audit!.params).toEqual(expect.arrayContaining([3, expect.stringMatching(/refresh_reuse/)]))
  })

  test('does NOT insert into revoked_tokens (no permanent breach)', async () => {
    const { pool, queries } = mockPool()
    await handleRefreshReuse(pool, 3, 'g_kl9Gmv')
    const revoke = queries.find((q) => q.sql.includes('revoked_tokens') && q.sql.includes('INSERT'))
    expect(revoke).toBeUndefined()
  })
})
