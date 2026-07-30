import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, SESSION_STATUS_SUPPRESSED_EFFECT_STEP, updateSessionStatus } from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('session status PostgreSQL integration', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE sessions, daemons RESTART IDENTITY CASCADE')
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, status)
       VALUES ('daemon-status-test', 'status-test', 'online')`,
    )
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, status)
       VALUES ('session-status-test', 'daemon-status-test', 'codex', 'idle')`,
    )
  })

  test('uses one typed status value while preserving active turn timing', async () => {
    const startedAt = '2026-07-19T10:00:00.000Z'

    expect(await updateSessionStatus(
      pool,
      'session-status-test',
      'daemon-status-test',
      'busy',
      undefined,
      undefined,
      startedAt,
    )).toBe(true)

    let row = await pool.query(
      `SELECT status, turn_started_at FROM sessions WHERE session_id = 'session-status-test'`,
    )
    expect(row.rows[0].status).toBe('busy')
    expect(new Date(row.rows[0].turn_started_at).toISOString()).toBe(startedAt)

    expect(await updateSessionStatus(
      pool,
      'session-status-test',
      'daemon-status-test',
      'waiting_question',
    )).toBe(true)

    row = await pool.query(
      `SELECT status, turn_started_at FROM sessions WHERE session_id = 'session-status-test'`,
    )
    expect(row.rows[0].status).toBe('waiting_question')
    expect(new Date(row.rows[0].turn_started_at).toISOString()).toBe(startedAt)

    expect(await updateSessionStatus(
      pool,
      'session-status-test',
      'daemon-status-test',
      'completed',
    )).toBe(true)

    row = await pool.query(
      `SELECT status, turn_started_at FROM sessions WHERE session_id = 'session-status-test'`,
    )
    expect(row.rows[0]).toEqual({ status: 'completed', turn_started_at: null })
  })

  test('keeps session_status update-only semantics', async () => {
    expect(await updateSessionStatus(
      pool,
      'unknown-session',
      'daemon-status-test',
      'running',
    )).toBe(false)

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions WHERE session_id = 'unknown-session'`,
    )
    expect(result.rows[0].count).toBe(0)
  })

  test('persists an unknown session_status suppression decision across later session creation', async () => {
    const materializer = new EventMaterializer({ pool })
    const input = {
      inboxId: 91,
      userId: null,
      daemonId: 'daemon-status-test',
      sessionId: 'late-session',
      eventType: 'session_status',
      payload: { type: 'session_status', session_id: 'late-session', status: 'busy' },
    }

    expect((await materializer.materialize(input)).deliveries).toEqual([])
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, status)
       VALUES ('late-session', 'daemon-status-test', 'codex', 'idle')`,
    )
    expect((await materializer.materialize(input)).deliveries).toEqual([])

    const ledger = await pool.query(
      `SELECT effect_status, effect_step
       FROM events
       WHERE session_id = 'late-session' AND event_type = 'session_status'`,
    )
    expect(ledger.rows).toEqual([{
      effect_status: 'completed',
      effect_step: SESSION_STATUS_SUPPRESSED_EFFECT_STEP,
    }])
    const session = await pool.query(
      `SELECT status FROM sessions WHERE session_id = 'late-session'`,
    )
    expect(session.rows[0].status).toBe('idle')
  })
})
