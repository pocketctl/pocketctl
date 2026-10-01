import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// auth.ts (pulled in through routes.ts) validates JWT_SECRET at module load
// and exits without it. CI and the release preflight run this suite with a
// bare environment, so seed the fixture before the dynamic imports below.
process.env.JWT_SECRET ||= 'cursor-postgres-integration-test-secret'

const { initDB } = await import('../db.js')
const { signAccessToken } = await import('../auth.js')
const { registerSessionOrganizationRoutes } = await import('./routes.js')
const { assertDurableIngressTestDatabase } = await import('../__tests__/durable-ingress-test-db.js')

const databaseUrl = process.env.TEST_DATABASE_URL
const integration = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
integration('organized session cursor preserves PostgreSQL timestamp precision', () => {
  let pool: pg.Pool
  let app: ReturnType<typeof Fastify>
  const users: number[] = []
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await initDB(pool)
    app = Fastify()
    registerSessionOrganizationRoutes(app, { pool, broadcast: () => {} })
    await app.ready()
  }, 30_000)
  afterAll(async () => {
    await app?.close()
    if (pool) {
      await pool.query('DELETE FROM users WHERE id=ANY($1::int[])', [users])
      await pool.end()
    }
  })

  // Removing microseconds from the cursor would skip the second row in all
  // three orderings. Timestamps deliberately differ within one millisecond.
  test.each(['activity', 'pinned', 'archived'] as const)('%s pagination includes each same-millisecond row exactly once', async ordering => {
    const nonce = randomUUID(), email = `cursor-${nonce}@example.test`
    const userId = Number((await pool.query(`INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id`, [email])).rows[0].id)
    users.push(userId)
    const daemonId = `cursor-${nonce}`
    await pool.query('INSERT INTO daemons(daemon_id,user_id) VALUES($1,$2)', [daemonId, userId])
    const ids = [`cursor-old-${nonce}`, `cursor-new-${nonce}`]
    for (const [index, stamp] of ['2026-01-01T00:00:00.123400Z', '2026-01-01T00:00:00.123900Z'].entries()) {
      await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,source,status,created_at,last_activity_at,
        membership_changed_at,pinned,pinned_at,archived_at)
        VALUES($1,$2,$3,'terminal','running',$4,$4,$4,$5,$6,$7)`,
      [ids[index], daemonId, userId,
        ordering === 'activity' ? stamp : '2026-01-01T00:00:00.000000Z',
        ordering === 'pinned', ordering === 'pinned' ? stamp : null, ordering === 'archived' ? stamp : null])
    }
    const token = await signAccessToken(userId, email)
    const path = '/api/organized-sessions?limit=1&' + (ordering === 'archived' ? 'view=archived' : 'bucket=ungrouped')
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    const firstResponse = await get(path)
    expect(firstResponse.statusCode).toBe(200)
    const first = firstResponse.json()
    expect(first.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([ids[1]])
    expect(first.has_more).toBe(true)
    const secondResponse = await get(path + '&cursor=' + encodeURIComponent(first.next_cursor))
    expect(secondResponse.statusCode).toBe(200)
    const second = secondResponse.json()
    expect(second.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([ids[0]])
    expect(second.has_more).toBe(false)
    expect(second.next_cursor).toBeNull()
    expect(first.sessions[0]).not.toHaveProperty('cursor_key')
    expect(first.sessions[0]).not.toHaveProperty('cursor_pin_at')
  })
})
