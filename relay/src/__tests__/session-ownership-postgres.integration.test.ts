import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import type { MaterializationInput } from '../materialization/types.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const VICTIM_SESSION = 'own-victim-session'
const DAEMON_A = 'own-daemon-a'
const DAEMON_B = 'own-daemon-b'

interface TenantFixture {
  userA: number
  userB: number
}

describeWithDatabase('daemon session ownership PostgreSQL integration', () => {
  let pool: pg.Pool
  let tenant: TenantFixture
  let materializer: EventMaterializer

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
    await pool.query(`
      TRUNCATE users, daemons, sessions, events, subagents, subagent_usage_seen,
               request_push_effect, token_usage_facts, realtime_outbox, event_inbox,
               deleted_sessions, quota_reservations
      RESTART IDENTITY CASCADE
    `)
    const users = await pool.query<{ id: number; email: string }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('owner-a@test.invalid', 'x'), ('owner-b@test.invalid', 'x')
       RETURNING id, email`,
    )
    const userA = users.rows.find((row) => row.email === 'owner-a@test.invalid')!.id
    const userB = users.rows.find((row) => row.email === 'owner-b@test.invalid')!.id
    tenant = { userA, userB }
    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, status, user_id)
       VALUES ($1, 'host-a', 'online', $3), ($2, 'host-b', 'online', $4)`,
      [DAEMON_A, DAEMON_B, userA, userB],
    )
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, title, source, status, user_id)
       VALUES ($1, $2, 'codex', '/victim', 'Victim Title', 'terminal', 'running', $3)`,
      [VICTIM_SESSION, DAEMON_A, userA],
    )
    await pool.query(
      `INSERT INTO events (session_id, event_type, payload, event_hash, effect_status)
       VALUES
         ($1, 'user_text', '{"type":"user_text","text":"first"}', 'own-victim-h1', 'completed'),
         ($1, 'agent_text', '{"type":"agent_text","text":"second"}', 'own-victim-h2', 'completed')`,
      [VICTIM_SESSION],
    )
    materializer = new EventMaterializer({ pool })
  })

  function attackerInput(
    eventType: string,
    payload: Record<string, unknown>,
    overrides: Partial<MaterializationInput> = {},
  ): MaterializationInput {
    return {
      inboxId: 510,
      userId: tenant.userB,
      daemonId: DAEMON_B,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : VICTIM_SESSION,
      eventType,
      payload: { type: eventType, session_id: VICTIM_SESSION, ...payload },
      context: {
        agentType: 'codex',
        cwd: '/attacker',
        requestId: typeof payload.request_id === 'string' ? payload.request_id : undefined,
        hostname: 'host-b',
      },
      ...overrides,
    }
  }

  async function victimSnapshot() {
    const session = await pool.query(
      `SELECT session_id, daemon_id, user_id, status, title, is_subagent, parent_session_id,
              total_tokens, updated_at
       FROM sessions WHERE session_id = $1`,
      [VICTIM_SESSION],
    )
    const events = await pool.query(
      `SELECT id, event_type, payload FROM events WHERE session_id = $1 ORDER BY id`,
      [VICTIM_SESSION],
    )
    return { session: session.rows[0], events: events.rows }
  }

  test('attacker session_created cannot take over the victim session', async () => {
    const before = await victimSnapshot()

    await expect(materializer.materialize(attackerInput('session_created', {
      title: 'Hijacked', model: 'gpt-5',
    }))).rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })
    await expect(materializer.materialize(attackerInput('session_created', {
      title: 'Hijacked inline',
    }, { inboxId: 0 }))).rejects.toMatchObject({ code: 'session_ownership_violation' })

    expect(await victimSnapshot()).toEqual(before)
  })

  test('attacker session_discovered cannot rebind the victim session', async () => {
    const before = await victimSnapshot()

    await expect(materializer.materialize(attackerInput('session_discovered', {
      agent: 'claude-code', cwd: '/attacker', status: 'idle',
    }))).rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })
    await expect(materializer.materialize(attackerInput('session_discovered', {
      agent: 'claude-code',
    }, { inboxId: 0 }))).rejects.toMatchObject({ code: 'session_ownership_violation' })

    expect(await victimSnapshot()).toEqual(before)
  })

  test('attacker session_status cannot mutate the victim session and is not treated as unknown', async () => {
    const before = await victimSnapshot()

    await expect(materializer.materialize(attackerInput('session_status', {
      status: 'completed', exit_reason: 'hijack',
    }))).rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })
    await expect(materializer.materialize(attackerInput('session_status', {
      status: 'error',
    }, { inboxId: 0 }))).rejects.toMatchObject({ code: 'session_ownership_violation' })

    expect(await victimSnapshot()).toEqual(before)
  })

  test('attacker session_id_changed cannot move the victim session or its history', async () => {
    const before = await victimSnapshot()

    await expect(materializer.materialize(attackerInput('session_id_changed', {
      old_session_id: VICTIM_SESSION, session_id: 'attacker-renamed-session',
    }, { sessionId: 'attacker-renamed-session' }))).rejects.toMatchObject({
      code: 'session_ownership_violation', permanent: true,
    })

    expect(await victimSnapshot()).toEqual(before)
    const renamed = await pool.query(
      `SELECT 1 FROM sessions WHERE session_id = 'attacker-renamed-session'`,
    )
    expect(renamed.rowCount ?? 0).toBe(0)
    const moved = await pool.query(
      `SELECT 1 FROM events WHERE session_id = 'attacker-renamed-session'`,
    )
    expect(moved.rowCount ?? 0).toBe(0)
  })

  test('attacker rename into an existing foreign session id is rejected', async () => {
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, status, user_id)
       VALUES ('attacker-owned-session', $1, 'codex', 'running', $2)`,
      [DAEMON_B, tenant.userB],
    )
    const before = await victimSnapshot()

    await expect(materializer.materialize(attackerInput('session_id_changed', {
      old_session_id: 'attacker-owned-session', session_id: VICTIM_SESSION,
    }, { sessionId: VICTIM_SESSION }))).rejects.toMatchObject({
      code: 'session_ownership_violation', permanent: true,
    })

    expect(await victimSnapshot()).toEqual(before)
    const attackerRow = await pool.query(
      `SELECT session_id FROM sessions WHERE session_id = 'attacker-owned-session'`,
    )
    expect(attackerRow.rowCount ?? 0).toBe(1)
  })

  test.each([
    ['agent_text', { text: 'injected', usage: { input_tokens: 11, output_tokens: 7 } }],
    ['approval_request', { request_id: 'own-approval-1', tool: 'Bash', input: { command: 'rm -rf /' } }],
    ['question_request', { request_id: 'own-question-1', questions: [{ question: 'stolen?' }] }],
    ['subagent_discovered', { agent: 'codex', agent_id: 'own-child', root_session_id: VICTIM_SESSION }],
  ])('attacker %s cannot inject into the victim session', async (eventType, extra) => {
    const before = await victimSnapshot()

    await expect(materializer.materialize(attackerInput(eventType, extra)))
      .rejects.toMatchObject({ code: 'session_ownership_violation', permanent: true })
    await expect(materializer.materialize(attackerInput(eventType, extra, { inboxId: 0 })))
      .rejects.toMatchObject({ code: 'session_ownership_violation' })

    expect(await victimSnapshot()).toEqual(before)
    const pushEffects = await pool.query(
      `SELECT 1 FROM request_push_effect WHERE request_id LIKE 'own-%'`,
    )
    expect(pushEffects.rowCount ?? 0).toBe(0)
    const subagents = await pool.query(
      `SELECT 1 FROM subagents WHERE parent_session_id = $1`,
      [VICTIM_SESSION],
    )
    expect(subagents.rowCount ?? 0).toBe(0)
  })

  test('attacker replay of a rejected event remains forbidden', async () => {
    const before = await victimSnapshot()
    const attack = attackerInput('agent_text', { text: 'injected' })

    await expect(materializer.materialize(attack)).rejects.toMatchObject({
      code: 'session_ownership_violation',
    })
    await expect(materializer.materialize(attack)).rejects.toMatchObject({
      code: 'session_ownership_violation',
    })

    expect(await victimSnapshot()).toEqual(before)
  })

  test('attacker title events cannot change victim titles', async () => {
    await pool.query(
      `UPDATE sessions SET title = 'Terminal Session-1' WHERE session_id = $1`,
      [VICTIM_SESSION],
    )

    for (const eventType of ['generate_title_request', 'generate_subagent_title_request', 'session_title_update']) {
      await expect(materializer.materialize(attackerInput(eventType, {
        title: 'Hijacked Title', agent_id: 'child', user_message: 'hi', assistant_message: 'there',
      }))).rejects.toMatchObject({ name: 'EphemeralMaterializationError' })
    }

    const title = await pool.query(
      `SELECT title FROM sessions WHERE session_id = $1`,
      [VICTIM_SESSION],
    )
    expect(title.rows[0].title).toBe('Terminal Session-1')
  })

  test('legitimate owner creation, rebind, claim, and rename still work', async () => {
    const result = await materializer.materialize({
      inboxId: 511,
      userId: tenant.userA,
      daemonId: DAEMON_A,
      sessionId: 'own-fresh-session',
      eventType: 'session_created',
      payload: { type: 'session_created', session_id: 'own-fresh-session', title: 'Fresh' },
      context: { agentType: 'codex', cwd: '/new', requestId: 'req-fresh', hostname: 'host-a' },
    })
    expect(result.eventId).not.toBeNull()
    const fresh = await pool.query(
      `SELECT daemon_id, user_id FROM sessions WHERE session_id = 'own-fresh-session'`,
    )
    expect(fresh.rows[0]).toMatchObject({ daemon_id: DAEMON_A, user_id: tenant.userA })

    await pool.query(
      `INSERT INTO daemons (daemon_id, hostname, status, user_id)
       VALUES ('own-daemon-a2', 'host-a2', 'online', $1)`,
      [tenant.userA],
    )
    await expect(materializer.materialize({
      inboxId: 512,
      userId: tenant.userA,
      daemonId: 'own-daemon-a2',
      sessionId: VICTIM_SESSION,
      eventType: 'session_discovered',
      payload: { type: 'session_discovered', session_id: VICTIM_SESSION, agent: 'codex', status: 'busy' },
      context: { hostname: 'host-a2' },
    })).resolves.toBeTruthy()
    const rebound = await pool.query(
      `SELECT daemon_id, user_id FROM sessions WHERE session_id = $1`,
      [VICTIM_SESSION],
    )
    expect(rebound.rows[0]).toMatchObject({ daemon_id: 'own-daemon-a2', user_id: tenant.userA })

    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, status, user_id)
       VALUES ('own-legacy-null', $1, 'codex', 'idle', NULL)`,
      [DAEMON_A],
    )
    await expect(materializer.materialize({
      inboxId: 513,
      userId: tenant.userA,
      daemonId: DAEMON_A,
      sessionId: 'own-legacy-null',
      eventType: 'session_discovered',
      payload: { type: 'session_discovered', session_id: 'own-legacy-null', agent: 'codex' },
      context: { hostname: 'host-a' },
    })).resolves.toBeTruthy()
    const claimed = await pool.query(
      `SELECT user_id FROM sessions WHERE session_id = 'own-legacy-null'`,
    )
    expect(claimed.rows[0].user_id).toBe(tenant.userA)

    const renameEventsBefore = await pool.query(
      `SELECT COUNT(*)::int AS count FROM events WHERE session_id = $1`,
      [VICTIM_SESSION],
    )
    await expect(materializer.materialize({
      inboxId: 514,
      userId: tenant.userA,
      daemonId: 'own-daemon-a2',
      sessionId: 'own-victim-renamed',
      eventType: 'session_id_changed',
      payload: {
        type: 'session_id_changed', session_id: 'own-victim-renamed',
        old_session_id: VICTIM_SESSION,
      },
      context: { hostname: 'host-a2' },
    })).resolves.toBeTruthy()
    const renamedRow = await pool.query(
      `SELECT daemon_id, user_id FROM sessions WHERE session_id = 'own-victim-renamed'`,
    )
    expect(renamedRow.rows[0]).toMatchObject({ daemon_id: 'own-daemon-a2', user_id: tenant.userA })
    const oldRow = await pool.query(
      `SELECT 1 FROM sessions WHERE session_id = $1`,
      [VICTIM_SESSION],
    )
    expect(oldRow.rowCount ?? 0).toBe(0)
    const renamedEvents = await pool.query(
      `SELECT COUNT(*)::int AS count FROM events WHERE session_id = 'own-victim-renamed'`,
    )
    expect(renamedEvents.rows[0].count).toBe(renameEventsBefore.rows[0].count + 1)
  })

  test('legacy null-owner session rejects a different daemon without claiming', async () => {
    await pool.query(
      `INSERT INTO sessions (session_id, daemon_id, agent_type, status, user_id)
       VALUES ('own-legacy-null-b', $1, 'codex', 'idle', NULL)`,
      [DAEMON_A],
    )

    await expect(materializer.materialize(attackerInput('session_discovered', {
      session_id: 'own-legacy-null-b', agent: 'codex',
    }, { sessionId: 'own-legacy-null-b' }))).rejects.toMatchObject({
      code: 'session_ownership_violation', permanent: true,
    })
    await expect(materializer.materialize(attackerInput('session_discovered', {
      session_id: 'own-legacy-null-b', agent: 'codex',
    }, { sessionId: 'own-legacy-null-b', userId: null }))).rejects.toMatchObject({
      code: 'session_ownership_violation',
    })

    const row = await pool.query(
      `SELECT daemon_id, user_id FROM sessions WHERE session_id = 'own-legacy-null-b'`,
    )
    expect(row.rows[0]).toMatchObject({ daemon_id: DAEMON_A, user_id: null })
  })

  test('unknown session_status stays suppressed while ordinary missing-session events are rejected', async () => {
    const statusResult = await materializer.materialize({
      inboxId: 515,
      userId: tenant.userA,
      daemonId: DAEMON_A,
      sessionId: 'own-ghost-session',
      eventType: 'session_status',
      payload: { type: 'session_status', session_id: 'own-ghost-session', status: 'busy' },
      context: { hostname: 'host-a' },
    })
    expect(statusResult.deliveries).toEqual([])
    const ghostRows = await pool.query(
      `SELECT 1 FROM sessions WHERE session_id = 'own-ghost-session'`,
    )
    expect(ghostRows.rowCount ?? 0).toBe(0)

    await expect(materializer.materialize({
      inboxId: 516,
      userId: tenant.userA,
      daemonId: DAEMON_A,
      sessionId: 'own-ghost-session',
      eventType: 'agent_text',
      payload: { type: 'agent_text', session_id: 'own-ghost-session', text: 'orphan' },
      context: { hostname: 'host-a' },
    })).rejects.toMatchObject({ code: 'unknown_daemon_session', permanent: true })
    const ghostEvents = await pool.query(
      `SELECT 1 FROM events WHERE session_id = 'own-ghost-session' AND event_type = 'agent_text'`,
    )
    expect(ghostEvents.rowCount ?? 0).toBe(0)
  })

  test('concurrent creation of one session id yields exactly one owner', async () => {
    const attempts = await Promise.allSettled([
      materializer.materialize({
        inboxId: 520,
        userId: tenant.userA,
        daemonId: DAEMON_A,
        sessionId: 'own-race-session',
        eventType: 'session_created',
        payload: { type: 'session_created', session_id: 'own-race-session', title: 'A' },
        context: { agentType: 'codex', cwd: '/a', requestId: 'req-race-a', hostname: 'host-a' },
      }),
      materializer.materialize({
        inboxId: 521,
        userId: tenant.userB,
        daemonId: DAEMON_B,
        sessionId: 'own-race-session',
        eventType: 'session_created',
        payload: { type: 'session_created', session_id: 'own-race-session', title: 'B' },
        context: { agentType: 'codex', cwd: '/b', requestId: 'req-race-b', hostname: 'host-b' },
      }),
    ])

    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const losers = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'session_ownership_violation',
    })

    const winnerInput = attempts[0].status === 'fulfilled' ? 'A' : 'B'
    const owner = await pool.query(
      `SELECT daemon_id, user_id, title FROM sessions WHERE session_id = 'own-race-session'`,
    )
    expect(owner.rows[0]).toMatchObject({
      daemon_id: winnerInput === 'A' ? DAEMON_A : DAEMON_B,
      user_id: winnerInput === 'A' ? tenant.userA : tenant.userB,
    })
    const raceEvents = await pool.query(
      `SELECT payload->>'title' AS title FROM events
       WHERE session_id = 'own-race-session' AND event_type = 'session_created'`,
    )
    expect(raceEvents.rows).toHaveLength(1)
    expect(raceEvents.rows[0].title).toBe(winnerInput)
  })
})
