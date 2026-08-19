import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { cleanRevokedTokens, initDB, revokeToken } from '../db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('token revocation retention (M-5)', () => {
  let pool: pg.Pool
  let userId: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await initDB(pool)
    const inserted = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`revocation-test-${Date.now()}@example.test`],
    )
    userId = inserted.rows[0].id
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM revoked_tokens WHERE user_id = $1`, [userId]).catch(() => {})
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {})
      await pool.end().catch(() => {})
    }
  })

  test('a refresh revocation survives the 25-hour access cleanup boundary', async () => {
    const jti = `refresh-survivor-${Date.now()}`
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000) // refresh TTL
    await revokeToken(pool, jti, userId, 'user_revoke', { tokenType: 'refresh', expiresAt })
    // Pretend 26 hours passed for the revoked_at clock, but expires_at is still future.
    await pool.query(`UPDATE revoked_tokens SET revoked_at = NOW() - interval '26 hours' WHERE jti = $1`, [jti])
    const purged = await cleanRevokedTokens(pool)
    const row = await pool.query(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [jti])
    expect(row.rowCount).toBe(1)
    void purged
  })

  test('an access revocation is purged only after its own expiry plus skew', async () => {
    const jti = `access-purge-${Date.now()}`
    // Expired 30 minutes ago; the 1h skew margin keeps it for now.
    await revokeToken(pool, jti, userId, 'user_revoke', {
      tokenType: 'access',
      expiresAt: new Date(Date.now() - 1800_000),
    })
    await cleanRevokedTokens(pool)
    let row = await pool.query(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [jti])
    expect(row.rowCount).toBe(1) // inside the skew window, retained

    await pool.query(
      `UPDATE revoked_tokens SET expires_at = NOW() - interval '2 hours' WHERE jti = $1`,
      [jti],
    )
    await cleanRevokedTokens(pool)
    row = await pool.query(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [jti])
    expect(row.rowCount).toBe(0) // past expiry + skew, purged
  })

  test('legacy rows without token metadata are backfilled conservatively as refresh', async () => {
    const jti = `legacy-row-${Date.now()}`
    await pool.query(
      `INSERT INTO revoked_tokens (jti, user_id, reason, revoked_at) VALUES ($1, $2, 'user_revoke', NOW())`,
      [jti, userId],
    )
    // Re-running the idempotent migration applies the conservative backfill.
    await initDB(pool)
    const row = await pool.query<{ token_type: string; expires_at: Date }>(
      `SELECT token_type, expires_at FROM revoked_tokens WHERE jti = $1`,
      [jti],
    )
    expect(row.rows[0].token_type).toBe('refresh')
    const expiresAt = new Date(row.rows[0].expires_at).getTime()
    expect(expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000)
  })
})
