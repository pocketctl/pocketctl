import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { deleteSession, deleteUserAccount, initDB } from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import {
  getSessionTokenTrendV2,
  getTodayTokenUsageByAgentV2,
  getTokenDashboardV2,
} from '../token-usage/dashboard-v2.js'
import { closeEligibleTokenUsageDays, closeTokenUsageDay } from '../token-usage/day-closer.js'
import { migrateTokenUsageAccounting } from '../token-usage/migration.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe.sequential : describe.skip
const schema = `token_usage_task2_${process.pid}`

describeWithDatabase('token usage Task 2 PostgreSQL contracts', () => {
  let admin: pg.Pool
  let pool: pg.Pool

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl })
    const database = await admin.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing token accounting integration test against a non-test database')
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    })
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin?.end()
  })

  test('upgrades the earlier source_event primary key before making it nullable', async () => {
    const upgradeSchema = `${schema}_upgrade`
    await admin.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`)
    await admin.query(`CREATE SCHEMA ${upgradeSchema}`)
    const upgradePool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${upgradeSchema}`,
    })
    const concurrentUpgradePool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${upgradeSchema}`,
    })
    try {
      await initDB(upgradePool)
      await upgradePool.query(`DROP TABLE token_usage_facts`)
      await upgradePool.query(`
        CREATE TABLE token_usage_facts (
          source_event_id BIGINT PRIMARY KEY,
          user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          daemon_id VARCHAR(64) NOT NULL,
          session_id VARCHAR(64) NOT NULL,
          agent_type VARCHAR(64) NOT NULL DEFAULT 'unknown',
          model VARCHAR(128) NOT NULL DEFAULT 'unknown',
          usage_date DATE NOT NULL,
          recorded_at TIMESTAMPTZ NOT NULL,
          input BIGINT NOT NULL DEFAULT 0,
          output BIGINT NOT NULL DEFAULT 0,
          cache_read BIGINT NOT NULL DEFAULT 0,
          cache_create BIGINT NOT NULL DEFAULT 0,
          reasoning BIGINT NOT NULL DEFAULT 0,
          reported_total BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      const user = await upgradePool.query<{ id: number }>(`
        INSERT INTO users (email, password_hash) VALUES ('upgrade@example.test', '') RETURNING id
      `)
      await upgradePool.query(
        `INSERT INTO token_usage_facts (
           source_event_id, user_id, daemon_id, session_id, usage_date, recorded_at
         ) VALUES (7, $1, 'd', 's', CURRENT_DATE, NOW())`,
        [user.rows[0].id],
      )
      await upgradePool.query(`DROP TABLE token_session_daily_stats`)
      await upgradePool.query(`
        CREATE TABLE token_session_daily_stats (
          session_id VARCHAR(64) NOT NULL,
          date DATE NOT NULL,
          input BIGINT NOT NULL DEFAULT 0,
          output BIGINT NOT NULL DEFAULT 0,
          cache_read BIGINT NOT NULL DEFAULT 0,
          cache_create BIGINT NOT NULL DEFAULT 0,
          requests BIGINT NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, date)
        )
      `)
      await upgradePool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('upgrade-daemon', $1)`, [user.rows[0].id])
      await upgradePool.query(`
        INSERT INTO sessions (session_id, daemon_id, user_id)
        VALUES ('upgrade-session', 'upgrade-daemon', $1)
      `, [user.rows[0].id])
      await upgradePool.query(`
        INSERT INTO token_session_daily_stats (session_id, date, input, requests)
        VALUES ('upgrade-session', CURRENT_DATE - 1, 9, 1)
      `)

      await Promise.all([initDB(upgradePool), initDB(concurrentUpgradePool)])

      const columns = await upgradePool.query<{ column_name: string; is_nullable: string }>(`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'token_usage_facts'
          AND column_name IN ('fact_key', 'source_event_id', 'requests')
        ORDER BY column_name
      `)
      expect(columns.rows).toEqual([
        { column_name: 'fact_key', is_nullable: 'NO' },
        { column_name: 'requests', is_nullable: 'NO' },
        { column_name: 'source_event_id', is_nullable: 'YES' },
      ])
      const migrated = await upgradePool.query(
        `SELECT fact_key, source_event_id, requests FROM token_usage_facts WHERE source_event_id = 7`,
      )
      expect(migrated.rows[0]).toMatchObject({ fact_key: 'event:7', source_event_id: '7', requests: '1' })
      const sessionRollup = await upgradePool.query(`
        SELECT user_id, session_id, input, requests
        FROM token_session_daily_stats WHERE session_id = 'upgrade-session'
      `)
      expect(sessionRollup.rows[0]).toEqual({
        user_id: user.rows[0].id, session_id: 'upgrade-session', input: '9', requests: '1',
      })
      const sessionPrimaryKey = await upgradePool.query<{ columns: string[] }>(`
        SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[] AS columns
        FROM pg_constraint constraint_row
        CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
        WHERE constraint_row.conrelid = 'token_session_daily_stats'::regclass
          AND constraint_row.contype = 'p'
      `)
      expect(sessionPrimaryKey.rows[0].columns).toEqual(['user_id', 'session_id', 'date'])
    } finally {
      await concurrentUpgradePool.end()
      await upgradePool.end()
      await admin.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`)
    }
  }, 30_000)

  test('closes facts into sealed global and session history, then reads them without events', async () => {
    const date = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('close@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('close-daemon', $1)`, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('close-session', 'close-daemon', $1, 'gpt-test', 'codex')
    `, [userId])
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, output, cache_read, cache_create, requests
      ) VALUES
        ('close:1', $1, 'close-daemon', 'close-session', 'codex', 'gpt-test', $2, $2::date, 5, 3, 2, 1, 2),
        ('close:2', $1, 'close-daemon', 'close-session', 'codex', 'gpt-test', $2, $2::date, 4, 2, 1, 0, 1)
    `, [userId, date])

    await expect(closeTokenUsageDay(pool, date)).resolves.toMatchObject({
      date, status: 'sealed', factCount: 2, total: 18,
    })
    const closure = await pool.query(`
      SELECT status, source_fact_count, source_request_count, rollup_request_count,
             session_source_request_count, session_rollup_request_count,
             source_total, rollup_total, session_source_total, session_rollup_total
      FROM token_daily_closures WHERE date = $1
    `, [date])
    expect(closure.rows[0]).toMatchObject({
      status: 'sealed', source_fact_count: '2', source_request_count: '3',
      rollup_request_count: '3', session_source_request_count: '3',
      session_rollup_request_count: '3', source_total: '18', rollup_total: '18',
      session_source_total: '18', session_rollup_total: '18',
    })

    const dashboard = await getTokenDashboardV2(pool, userId, 'all', 30)
    expect(dashboard.dailySeries).toContainEqual({
      date, input: 9, output: 5, cache_read: 3, requests: 3,
    })
    await expect(getSessionTokenTrendV2(pool, userId, 'close-session', 30)).resolves.toContainEqual({
      date, input: 9, output: 5, cache_read: 3, requests: 3,
    })
  })

  test('projects pending inbox usage before session deletion and records direct subagent facts', async () => {
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('delete@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('delete-daemon', $1)`, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('delete-session', 'delete-daemon', $1, 'gpt-test', 'codex'),
             ('subagent-root', 'delete-daemon', $1, 'gpt-test', 'codex')
    `, [userId])
    const inbox = await pool.query<{ inbox_id: string }>(`
      INSERT INTO event_inbox (
        user_id, daemon_id, daemon_generation, seq, dedup_key, session_id,
        event_type, priority_class, received_at, payload
      ) VALUES (
        $1, 'delete-daemon', 1, 1, 'delete-pending', 'delete-session',
        'agent_text', 0, NOW(), '{"type":"agent_text","usage":{"input_tokens":11,"output_tokens":2}}'
      ) RETURNING inbox_id
    `, [userId])
    const duplicate = await pool.query<{ inbox_id: string }>(`
      INSERT INTO event_inbox (
        user_id, daemon_id, daemon_generation, seq, dedup_key, session_id,
        event_type, priority_class, received_at, payload, status
      ) VALUES (
        $1, 'delete-daemon', 1, 2, 'delete-subagent-usage', 'delete-session',
        'subagent_usage', 0, NOW(),
        '{"type":"subagent_usage","usage":{"input_tokens":11,"output_tokens":2}}', 1
      ) RETURNING inbox_id
    `, [userId])
    await pool.query(`
      INSERT INTO token_session_daily_stats (user_id, session_id, date, input, requests)
      VALUES ($1, 'delete-session', CURRENT_DATE - 1, 4, 1)
    `, [userId])

    await deleteSession(pool, 'delete-session', {
      usageFactsAuthoritative: true,
      writeUsageFacts: true,
    })
    const projected = await pool.query(
      `SELECT input, output, requests FROM token_usage_facts WHERE fact_key = $1`,
      [`inbox:${inbox.rows[0].inbox_id}`],
    )
    expect(projected.rows[0]).toMatchObject({ input: '11', output: '2', requests: '1' })
    const projectedTotals = await pool.query(
      `SELECT COUNT(*) AS facts, COALESCE(SUM(requests), 0) AS requests
       FROM token_usage_facts WHERE session_id = 'delete-session'`,
    )
    expect(projectedTotals.rows[0]).toEqual({ facts: '1', requests: '1' })
    expect((await pool.query(
      `SELECT 1 FROM token_usage_facts WHERE fact_key = $1`,
      [`inbox:${duplicate.rows[0].inbox_id}`],
    )).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM event_inbox WHERE inbox_id = $1`, [inbox.rows[0].inbox_id])).rowCount).toBe(0)
    expect((await pool.query(
      `SELECT 1 FROM token_session_daily_stats WHERE session_id = 'delete-session'`,
    )).rowCount).toBe(0)

    const materializer = new EventMaterializer({ pool, writeTokenUsageFacts: true })
    await materializer.materialize({
      inboxId: 987654,
      userId,
      daemonId: 'delete-daemon',
      sessionId: 'subagent-root',
      eventType: 'agent_text',
      receivedAt: new Date(),
      payload: {
        type: 'agent_text', session_id: 'subagent-root', is_subagent: true,
        agent: 'codex', model: 'gpt-test', usage: { input_tokens: 7, output_tokens: 3 },
      },
    })
    const subagent = await pool.query(
      `SELECT input, output FROM token_usage_facts WHERE fact_key = 'inbox:987654'`,
    )
    expect(subagent.rows[0]).toEqual({ input: '7', output: '3' })
  })

  test('reclassifies only one Desktop session token dimension without changing totals or source facts', async () => {
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('desktop-reclass@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('desktop-reclass-daemon', $1)`, [userId])
    await pool.query(`
      INSERT INTO sessions (
        session_id, daemon_id, user_id, model, agent_type, source,
        total_tokens, tok_input, tok_output, tok_cache_read, tok_cache_create, cost_usd
      )
      VALUES
        ('desktop-reclass-session', 'desktop-reclass-daemon', $1, 'gpt-test', 'codex', 'terminal',
         26, 11, 7, 5, 3, 0.0125),
        ('cli-control-session', 'desktop-reclass-daemon', $1, 'gpt-test', 'codex', 'terminal',
         13, 13, 0, 0, 0, 0.0025)
    `, [userId])
    const sourcePayload = {
      type: 'agent_text', event_id: 'desktop-original-turn', text: 'unchanged',
      usage: {
        input_tokens: 11, output_tokens: 7, cache_read_tokens: 5,
        cache_create_tokens: 3, reasoning_tokens: 2, total_tokens: 28,
      },
    }
    const sourceEvent = await pool.query<{ id: string }>(`
      INSERT INTO events (session_id, event_type, payload, event_hash, effect_status, effect_step)
      VALUES ('desktop-reclass-session', 'agent_text', $1::jsonb, 'desktop-original-hash', 'completed', 1)
      RETURNING id
    `, [JSON.stringify(sourcePayload)])
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, source_event_id, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, output, cache_read, cache_create,
        reasoning, reported_total, requests
      ) VALUES
        ('desktop-original-fact', $1, $2, 'desktop-reclass-daemon',
         'desktop-reclass-session', 'codex', 'gpt-test', CURRENT_DATE,
         TIMESTAMPTZ '2026-09-04 01:02:03+00', 11, 7, 5, 3, 2, 28, 4),
        ('cli-control-fact', NULL, $2, 'desktop-reclass-daemon',
         'cli-control-session', 'codex', 'gpt-test', CURRENT_DATE,
         TIMESTAMPTZ '2026-09-04 01:02:03+00', 13, 0, 0, 0, 0, 13, 1)
    `, [sourceEvent.rows[0].id, userId])

    const factBefore = (await pool.query(`
      SELECT fact_key, source_event_id::text, user_id, daemon_id, session_id, model,
             usage_date::text, recorded_at, input::text, output::text, cache_read::text,
             cache_create::text, reasoning::text, reported_total::text, requests::text,
             session_attribution_revoked
      FROM token_usage_facts WHERE fact_key = 'desktop-original-fact'
    `)).rows[0]
    const sessionAccountingBefore = (await pool.query(`
      SELECT total_tokens::text, tok_input::text, tok_output::text,
             tok_cache_read::text, tok_cache_create::text, cost_usd
      FROM sessions WHERE session_id = 'desktop-reclass-session'
    `)).rows[0]
    const dashboardBefore = await getTokenDashboardV2(pool, userId, 'desktop-reclass-daemon', 30)

    const materializer = new EventMaterializer({ pool, writeTokenUsageFacts: true })
    const discovery = {
      inboxId: 700_001,
      userId,
      daemonId: 'desktop-reclass-daemon',
      sessionId: 'desktop-reclass-session',
      eventType: 'session_discovered',
      receivedAt: new Date('2026-09-04T02:03:04.000Z'),
      payload: {
        type: 'session_discovered', event_id: 'desktop-discovery',
        agent: 'codex-desktop', status: 'idle', cwd: '/repo', title: 'Desktop observer',
      },
      context: { hostname: 'desktop.local' },
    }
    await materializer.materialize(discovery)
    await materializer.materialize(discovery)

    const factAfter = (await pool.query(`
      SELECT fact_key, source_event_id::text, user_id, daemon_id, session_id, model,
             usage_date::text, recorded_at, input::text, output::text, cache_read::text,
             cache_create::text, reasoning::text, reported_total::text, requests::text,
             session_attribution_revoked
      FROM token_usage_facts WHERE fact_key = 'desktop-original-fact'
    `)).rows[0]
    expect(factAfter).toEqual(factBefore)
    expect((await pool.query(`
      SELECT fact_key, agent_type FROM token_usage_facts
      WHERE fact_key IN ('desktop-original-fact', 'cli-control-fact') ORDER BY fact_key
    `)).rows).toEqual([
      { fact_key: 'cli-control-fact', agent_type: 'codex' },
      { fact_key: 'desktop-original-fact', agent_type: 'codex-desktop' },
    ])
    expect((await pool.query(`SELECT payload FROM events WHERE id = $1`, [sourceEvent.rows[0].id])).rows[0].payload)
      .toEqual(sourcePayload)
    expect((await pool.query(`
      SELECT total_tokens::text, tok_input::text, tok_output::text,
             tok_cache_read::text, tok_cache_create::text, cost_usd
      FROM sessions WHERE session_id = 'desktop-reclass-session'
    `)).rows[0]).toEqual(sessionAccountingBefore)

    const dashboardAfter = await getTokenDashboardV2(pool, userId, 'desktop-reclass-daemon', 30)
    expect(dashboardAfter.summary).toEqual(dashboardBefore.summary)
    expect((await getTodayTokenUsageByAgentV2(pool, userId, 'desktop-reclass-daemon'))
      .sort((a, b) => a.agent_type.localeCompare(b.agent_type))).toEqual([
      { agent_type: 'codex', today: 13 },
      { agent_type: 'codex-desktop', today: 26 },
    ])
  })

  test('serializes concurrent close attempts and waits for pre-cutoff inbox work', async () => {
    const closeDate = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10)
    const waitDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('concurrent@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, requests
      ) VALUES
        ('concurrent-close', $1, 'concurrent-daemon', 'concurrent-session', 'codex', 'gpt-test', $2, $2::date, 9, 1),
        ('waiting-close', $1, 'concurrent-daemon', 'waiting-session', 'codex', 'gpt-test', $3, $3::date, 5, 1)
    `, [userId, closeDate, waitDate])
    const concurrent = await Promise.all([
      closeTokenUsageDay(pool, closeDate),
      closeTokenUsageDay(pool, closeDate),
    ])
    expect(concurrent.map((item) => item.status).sort()).toEqual(['already_sealed', 'sealed'])

    const inbox = await pool.query<{ inbox_id: string }>(`
      INSERT INTO event_inbox (
        user_id, daemon_id, daemon_generation, seq, dedup_key, session_id,
        event_type, priority_class, received_at, payload, status
      ) VALUES (
        $1, 'concurrent-daemon', 1, 1, 'waiting-inbox', 'waiting-session',
        'agent_text', 0, ($2::date + TIME '12:00') AT TIME ZONE 'UTC',
        '{"type":"agent_text"}', 0
      ) RETURNING inbox_id
    `, [userId, waitDate])
    await expect(closeTokenUsageDay(pool, waitDate)).resolves.toMatchObject({
      date: waitDate, status: 'waiting', pendingRows: 1,
    })
    await pool.query(`DELETE FROM event_inbox WHERE inbox_id = $1`, [inbox.rows[0].inbox_id])
    await expect(closeTokenUsageDay(pool, waitDate)).resolves.toMatchObject({
      date: waitDate, status: 'sealed', total: 5,
    })
  })

  test('does not let old sealed facts starve a newer unsealed close candidate', async () => {
    const sealedDate = new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10)
    const pendingDate = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('candidate@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, requests
      ) VALUES
        ('candidate-sealed', $1, 'candidate-daemon', 'candidate-session', 'codex', 'gpt-test', $2, $2::date, 1, 1),
        ('candidate-pending', $1, 'candidate-daemon', 'candidate-session', 'codex', 'gpt-test', $3, $3::date, 2, 1)
    `, [userId, sealedDate, pendingDate])
    await expect(closeTokenUsageDay(pool, sealedDate)).resolves.toMatchObject({ status: 'sealed' })

    await expect(closeEligibleTokenUsageDays(pool, new Date(), 1)).resolves.toEqual([
      expect.objectContaining({ date: pendingDate, status: 'sealed' }),
    ])
  })

  test('deletes user-owned session rollups and cannot expose them after session id reuse', async () => {
    const date = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10)
    const oldUser = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('session-owner-old@example.test', '') RETURNING id
    `)
    const oldUserId = oldUser.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('session-owner-old-daemon', $1)`, [oldUserId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('reused-session-id', 'session-owner-old-daemon', $1, 'gpt-test', 'codex')
    `, [oldUserId])
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, requests
      ) VALUES ('session-owner-old-fact', $1, 'session-owner-old-daemon',
                'reused-session-id', 'codex', 'gpt-test', $2, $2::date, 13, 1)
    `, [oldUserId, date])
    await expect(closeTokenUsageDay(pool, date)).resolves.toMatchObject({ status: 'sealed' })
    expect((await pool.query(
      `SELECT 1 FROM token_session_daily_stats WHERE user_id = $1`, [oldUserId],
    )).rowCount).toBe(1)

    await expect(deleteUserAccount(pool, oldUserId)).resolves.toBe(true)
    expect((await pool.query(
      `SELECT 1 FROM token_session_daily_stats WHERE user_id = $1`, [oldUserId],
    )).rowCount).toBe(0)

    const newUser = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('session-owner-new@example.test', '') RETURNING id
    `)
    const newUserId = newUser.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('session-owner-new-daemon', $1)`, [newUserId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('reused-session-id', 'session-owner-new-daemon', $1, 'gpt-test', 'codex')
    `, [newUserId])

    await expect(getSessionTokenTrendV2(pool, newUserId, 'reused-session-id', 30)).resolves.toEqual([])
  })

  test('keeps deleted-session usage in global history without rebuilding session attribution', async () => {
    const date = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('session-delete-close@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('session-delete-close-daemon', $1)`, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('session-delete-close-id', 'session-delete-close-daemon', $1, 'gpt-test', 'codex')
    `, [userId])
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, output, requests
      ) VALUES (
        'session-delete-close-fact', $1, 'session-delete-close-daemon',
        'session-delete-close-id', 'codex', 'gpt-test', $2, $2::date, 19, 5, 1
      )
    `, [userId, date])

    await expect(deleteSession(pool, 'session-delete-close-id', {
      usageFactsAuthoritative: true,
      writeUsageFacts: true,
    })).resolves.toBeUndefined()
    expect((await pool.query(`
      SELECT session_attribution_revoked
      FROM token_usage_facts WHERE fact_key = 'session-delete-close-fact'
    `)).rows[0]).toEqual({ session_attribution_revoked: true })

    // Simulate tombstone expiry, then reuse the external session id.
    await pool.query(`DELETE FROM deleted_sessions WHERE session_id = 'session-delete-close-id'`)
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('session-delete-close-id', 'session-delete-close-daemon', $1, 'gpt-test', 'codex')
    `, [userId])
    await expect(closeTokenUsageDay(pool, date)).resolves.toMatchObject({
      date, status: 'sealed', factCount: 1, total: 24,
    })

    expect((await pool.query(`
      SELECT input, output, requests FROM token_daily_stats
      WHERE user_id = $1 AND date = $2
    `, [userId, date])).rows[0]).toMatchObject({ input: '19', output: '5', requests: 1 })
    expect((await pool.query(`
      SELECT 1 FROM token_session_daily_stats
      WHERE user_id = $1 AND session_id = 'session-delete-close-id' AND date = $2
    `, [userId, date])).rowCount).toBe(0)
    await expect(getSessionTokenTrendV2(pool, userId, 'session-delete-close-id', 30)).resolves.toEqual([])
  })

  test('adopts legacy history and restores only owner-scoped retained session history', async () => {
    const date = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('baseline-real@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('baseline-real-daemon', $1)`, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('baseline-real-session', 'baseline-real-daemon', $1, 'gpt-test', 'codex')
    `, [userId])
    await pool.query(`
      INSERT INTO token_daily_stats (
        user_id, daemon_id, date, model, input, output, cache_read, cache_create, requests
      ) VALUES ($1, 'baseline-real-daemon', $2, 'gpt-test', 6, 2, 1, 0, 1)
    `, [userId, date])
    await pool.query(`
      INSERT INTO events (session_id, event_type, payload, created_at)
      VALUES ('baseline-real-session', 'agent_text',
              '{"type":"agent_text","usage":{"input_tokens":6,"output_tokens":2,"cache_read_tokens":1}}',
              ($1::date + TIME '12:00') AT TIME ZONE 'UTC')
    `, [date])

    const migrated = await migrateTokenUsageAccounting(pool)
    expect(migrated.adoptedHistoricalDays).toBe(1)
    expect(migrated.backfilledSessionRollups).toBe(1)
    expect((await pool.query(
      `SELECT status FROM token_daily_closures WHERE date = $1`, [date],
    )).rows[0]).toEqual({ status: 'sealed' })
    expect((await pool.query(`
      SELECT user_id, input, output, cache_read, requests
      FROM token_session_daily_stats
      WHERE user_id = $1 AND session_id = 'baseline-real-session' AND date = $2
    `, [userId, date])).rows[0]).toEqual({
      user_id: userId, input: '6', output: '2', cache_read: '1', requests: '1',
    })
  })

  test('refuses to seal completed post-baseline usage when the worker omitted its fact', async () => {
    const date = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
    const baselineAt = new Date(Date.now() - 10 * 86_400_000)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('missing-fact@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`
      INSERT INTO token_usage_accounting_state (key, completed_at)
      VALUES ('baseline-v1', $1)
      ON CONFLICT (key) DO UPDATE SET completed_at = EXCLUDED.completed_at
    `, [baselineAt])
    await pool.query(`
      INSERT INTO event_inbox (
        user_id, daemon_id, daemon_generation, seq, dedup_key, session_id,
        event_type, priority_class, received_at, payload, status
      ) VALUES (
        $1, 'missing-fact-daemon', 1, 1, 'missing-fact-inbox', 'missing-fact-session',
        'agent_text', 0, ($2::date + TIME '12:00') AT TIME ZONE 'UTC',
        '{"type":"agent_text","usage":{"input_tokens":17}}', 2
      )
    `, [userId, date])

    await expect(closeTokenUsageDay(pool, date)).resolves.toEqual({
      date, status: 'failed', reason: 'missing_usage_facts',
    })
    expect((await pool.query(
      `SELECT status, last_error FROM token_daily_closures WHERE date = $1`, [date],
    )).rows[0]).toEqual({ status: 'failed', last_error: 'missing_usage_facts' })
  })

  test('accepts a replay receipt linked to a pre-baseline event fact', async () => {
    const date = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
    const baselineAt = new Date(Date.now() - 30 * 86_400_000)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('event-fact-replay@example.test', '') RETURNING id
    `)
    const userId = user.rows[0].id
    await pool.query(`
      INSERT INTO token_usage_accounting_state (key, completed_at)
      VALUES ('baseline-v1', $1)
      ON CONFLICT (key) DO UPDATE SET completed_at = EXCLUDED.completed_at
    `, [baselineAt])
    await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ('event-fact-replay-daemon', $1)`, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, user_id, model, agent_type)
      VALUES ('event-fact-replay-session', 'event-fact-replay-daemon', $1, 'gpt-test', 'codex')
    `, [userId])
    const event = await pool.query<{ id: string }>(`
      INSERT INTO events (session_id, event_type, payload, event_hash, effect_status, effect_step, created_at)
      VALUES ('event-fact-replay-session', 'agent_text',
              '{"type":"agent_text","event_id":"replayed-turn","usage":{"input_tokens":13,"output_tokens":2}}',
              'event-fact-replay', 'completed', 1,
              ($1::date + TIME '12:00') AT TIME ZONE 'UTC')
      RETURNING id
    `, [date])
    await pool.query(`
      INSERT INTO token_usage_facts (
        fact_key, source_event_id, user_id, daemon_id, session_id, agent_type, model,
        usage_date, recorded_at, input, output, requests
      ) VALUES ('event:' || $1::text, $1::bigint, $2, 'event-fact-replay-daemon',
                'event-fact-replay-session', 'codex', 'gpt-test', $3,
                ($3::date + TIME '12:00') AT TIME ZONE 'UTC', 13, 2, 1)
    `, [event.rows[0].id, userId, date])
    await pool.query(`
      INSERT INTO event_inbox (
        user_id, daemon_id, daemon_generation, seq, dedup_key, session_id,
        event_type, priority_class, received_at, payload, status, completed_at,
        materialized_event_id
      ) VALUES (
        $1, 'event-fact-replay-daemon', 1, 1, 'event-fact-replay-inbox',
        'event-fact-replay-session', 'agent_text', 0,
        ($2::date + TIME '12:05') AT TIME ZONE 'UTC',
        '{"type":"agent_text","event_id":"replayed-turn","usage":{"input_tokens":13,"output_tokens":2}}',
        2, NOW(), $3
      )
    `, [userId, date, event.rows[0].id])

    await expect(closeTokenUsageDay(pool, date)).resolves.toEqual({
      date, status: 'sealed', factCount: 1, total: 15,
    })
  })
})
