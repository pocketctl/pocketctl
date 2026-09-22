import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { createSessionHistoryReadBroker } from '../session-history-read.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = enabled ? describe : describe.skip

describeWithDatabase('session history MCP PostgreSQL authorization', () => {
  let pool: pg.Pool
  let userA: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name')
    if (!/test/i.test(current.rows[0]?.name ?? '')) {
      throw new Error('Refusing session history integration test against a non-test database')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => { await pool?.end() })

  beforeEach(async () => {
    await pool.query('TRUNCATE users, daemons, sessions, events, session_history_read_audit RESTART IDENTITY CASCADE')
    const users = await pool.query<{ id: number; email: string }>(`
      INSERT INTO users (email, password_hash)
      VALUES ('history-a@test.invalid', 'x'), ('history-b@test.invalid', 'x')
      RETURNING id, email
    `)
    userA = users.rows.find((row) => row.email === 'history-a@test.invalid')!.id
    const userB = users.rows.find((row) => row.email === 'history-b@test.invalid')!.id
    await pool.query(`
      INSERT INTO daemons (daemon_id, hostname, status, user_id) VALUES
        ('history-daemon-a', 'a', 'online', $1),
        ('history-daemon-b', 'b', 'offline', $1),
        ('history-daemon-other', 'other', 'offline', $2)
    `, [userA, userB])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, agent_type, status, user_id) VALUES
        ('history-source-a', 'history-daemon-a', 'codex', 'running', $1),
        ('history-target-b', 'history-daemon-b', 'claude-code', 'exited', $1),
        ('history-target-other', 'history-daemon-other', 'codex', 'exited', $2)
    `, [userA, userB])
    await pool.query(`
      INSERT INTO events (session_id, event_type, payload) VALUES
        ('history-target-b', 'user_text', '{"text":"question"}'),
        ('history-target-b', 'agent_reasoning', '{"text":"hidden"}'),
        ('history-target-b', 'agent_text', '{"text":"answer"}'),
        ('history-target-other', 'agent_text', '{"text":"other account"}')
    `)
  })

  test('reads an offline target on another host, denies another account, and audits metadata only', async () => {
    const broker = createSessionHistoryReadBroker({ pool, cursorSecret: 'integration-secret' })
    const allowed = await broker.read(
      { userId: userA, daemonId: 'history-daemon-a' },
      { sourceSessionId: 'history-source-a', targetSessionId: 'history-target-b' },
    )
    expect(allowed.type).toBe('session_history_read_result')
    if (allowed.type === 'session_history_read_result') {
      expect(allowed.messages.map((message) => message.content)).toEqual(['question', 'answer'])
      expect(allowed.possibly_incomplete).toBe(false)
      expect(JSON.stringify(allowed)).not.toContain('hidden')
    }

    await expect(broker.read(
      { userId: userA, daemonId: 'history-daemon-a' },
      { sourceSessionId: 'history-source-a', targetSessionId: 'history-target-other' },
    )).resolves.toEqual({ type: 'session_history_read_error', code: 'not_found_or_not_owned' })

    const audits = await pool.query(`
      SELECT outcome, source_session_id, target_session_id, message_count, response_bytes
      FROM session_history_read_audit ORDER BY id
    `)
    expect(audits.rows).toEqual([
      expect.objectContaining({ outcome: 'allowed', source_session_id: 'history-source-a', target_session_id: 'history-target-b', message_count: 2 }),
      expect.objectContaining({ outcome: 'denied', source_session_id: 'history-source-a', target_session_id: 'history-target-other', message_count: 0 }),
    ])
    expect(JSON.stringify(audits.rows)).not.toContain('question')
    expect(JSON.stringify(audits.rows)).not.toContain('answer')
  })
})
