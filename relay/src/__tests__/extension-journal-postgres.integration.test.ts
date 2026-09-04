import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import type { MaterializationInput } from '../materialization/types.js'
import {
  createPostgresExtensionJournalSink,
  CANONICAL_EVENT_SOURCE_KIND,
} from '../extensions/journal.js'
import { ensureAppReviewDemoData } from '../config/app-review-demo.js'
import { persistOwnedClientEvent, ClientEventOwnershipError } from '../db.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension source journal atomicity (PostgreSQL)', () => {
  let pool: pg.Pool
  let userId: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await pool.query(`
      INSERT INTO users (email, password_hash) VALUES ('journal-owner@example.test', 'x')
    `)
    userId = (await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = 'journal-owner@example.test'`,
    )).rows[0].id
    await pool.query(`
      INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
      VALUES ('journal-daemon', 'h', '[]'::jsonb, 'online', $1)
    `, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
      VALUES ('journal-session', 'journal-daemon', 'codex', '/repo', 'running', $1)
    `, [userId])
  })

  function ownedInput(overrides: Partial<MaterializationInput> = {}): MaterializationInput {
    return {
      inboxId: 0,
      userId,
      daemonId: 'journal-daemon',
      sessionId: 'journal-session',
      eventType: 'agent_text',
      payload: { type: 'agent_text', session_id: 'journal-session', text: 'hello', event_id: 'journal-evt-1' },
      receivedAt: new Date(),
      ...overrides,
    }
  }

  async function sourceRows(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      `SELECT source_kind, source_id, owner_user_id, session_id, event_type, payload
       FROM extension_source_outbox WHERE session_id = $1 ORDER BY source_seq`,
      [sessionId],
    )
    return result.rows
  }

  test('canonical event and source journal row commit atomically', async () => {
    const materializer = new EventMaterializer({
      pool,
      extensionJournalSink: createPostgresExtensionJournalSink(),
    })
    await materializer.materialize(ownedInput())

    const events = await pool.query(
      `SELECT id FROM events WHERE session_id = 'journal-session'`,
    )
    expect(events.rowCount).toBe(1)
    const rows = await sourceRows('journal-session')
    expect(rows.length).toBe(1)
    expect(rows[0].source_kind).toBe(CANONICAL_EVENT_SOURCE_KIND)
    expect(rows[0].source_id).toBe(`event:${events.rows[0].id}`)
    expect(Number(rows[0].owner_user_id)).toBe(userId)
    expect(rows[0].event_type).toBe('agent_text')
  })

  test('a journal failure rolls the canonical event back with it', async () => {
    const failingSink = {
      appendCanonicalEvent: async () => {
        throw new Error('journal unavailable')
      },
    }
    const materializer = new EventMaterializer({ pool, extensionJournalSink: failingSink })

    await expect(materializer.materialize(ownedInput({
      payload: { type: 'agent_text', session_id: 'journal-session', text: 'x', event_id: 'journal-evt-2' },
    }))).rejects.toThrow('journal unavailable')

    const events = await pool.query(`SELECT id FROM events WHERE session_id = 'journal-session'`)
    expect(events.rowCount).toBe(0)
    expect((await sourceRows('journal-session')).length).toBe(0)
  })

  test('dedup replay repairs a missing journal row without duplicating it', async () => {
    const sink = createPostgresExtensionJournalSink()
    const materializer = new EventMaterializer({ pool, extensionJournalSink: sink })
    await materializer.materialize(ownedInput())
    const eventId = (await pool.query<{ id: string }>(
      `SELECT id FROM events WHERE session_id = 'journal-session'`,
    )).rows[0].id

    await pool.query(`DELETE FROM extension_source_outbox WHERE session_id = 'journal-session'`)
    expect((await sourceRows('journal-session')).length).toBe(0)

    await materializer.materialize(ownedInput())

    const eventsAfter = await pool.query(`SELECT id FROM events WHERE session_id = 'journal-session'`)
    expect(eventsAfter.rowCount).toBe(1)
    expect(eventsAfter.rows[0].id).toBe(eventId)
    const rows = await sourceRows('journal-session')
    expect(rows.length).toBe(1)
    expect(rows[0].source_id).toBe(`event:${eventId}`)
  })

  test('no sink (off mode) writes events but never journal rows', async () => {
    const materializer = new EventMaterializer({ pool, extensionJournalSink: null })
    await materializer.materialize(ownedInput())

    const events = await pool.query(`SELECT id FROM events WHERE session_id = 'journal-session'`)
    expect(events.rowCount).toBe(1)
    expect((await sourceRows('journal-session')).length).toBe(0)
  })

  test('persistOwnedClientEvent journals local command log events with ownership', async () => {
    const sink = createPostgresExtensionJournalSink()
    const result = await persistOwnedClientEvent(
      pool, userId, 'journal-session', 'user_text',
      { type: 'user_text', session_id: 'journal-session', text: 'before\u0000after' },
      sink,
    )
    expect(result.inserted).toBe(true)
    const rows = await sourceRows('journal-session')
    expect(rows.length).toBe(1)
    expect(rows[0].event_type).toBe('user_text')
    expect((rows[0].payload as Record<string, unknown>).text).toBe('before\uFFFDafter')

    // Cross-tenant write is rejected before any event or journal row lands.
    const other = (await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('journal-other@example.test', 'x') RETURNING id`,
    )).rows[0].id
    await expect(persistOwnedClientEvent(
      pool, other, 'journal-session', 'user_text',
      { type: 'user_text', session_id: 'journal-session', text: 'nope' },
      sink,
    )).rejects.toBeInstanceOf(ClientEventOwnershipError)
    const events = await pool.query(
      `SELECT event_type FROM events WHERE session_id = 'journal-session'`,
    )
    expect(events.rowCount).toBe(1)
    expect((await sourceRows('journal-session')).length).toBe(1)
  })

  test('app-review demo fixtures never reach the journal, even with a sink', async () => {
    await ensureAppReviewDemoData(pool, userId)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM extension_source_outbox`)).rows[0].count).toBe(0)

    const sink = createPostgresExtensionJournalSink()
    const result = await persistOwnedClientEvent(
      pool, userId, 'app-review-demo-ios-release', 'user_text',
      { type: 'user_text', session_id: 'app-review-demo-ios-release', text: 'demo input' },
      sink,
    )
    expect(result.inserted).toBe(true)
    const demoJournal = await pool.query(
      `SELECT COUNT(*)::int AS count FROM extension_source_outbox WHERE session_id LIKE 'app-review-demo-%'`,
    )
    expect(demoJournal.rows[0].count).toBe(0)
  })

  test('extension journal enrichment leaves the event identity hash unchanged', async () => {
    const withSink = new EventMaterializer({ pool, extensionJournalSink: createPostgresExtensionJournalSink() })
    await withSink.materialize(ownedInput({
      payload: { type: 'agent_text', session_id: 'journal-session', text: 'same', event_id: 'journal-hash-1' },
    }))
    const first = (await pool.query<{ id: string; event_hash: string }>(
      `SELECT id, event_hash FROM events WHERE session_id = 'journal-session'`,
    )).rows[0]

    const withoutSink = new EventMaterializer({ pool, extensionJournalSink: null })
    await withoutSink.materialize(ownedInput({
      payload: { type: 'agent_text', session_id: 'journal-session', text: 'same', event_id: 'journal-hash-1' },
    }))
    const second = (await pool.query<{ id: string; event_hash: string }>(
      `SELECT id, event_hash FROM events WHERE session_id = 'journal-session'`,
    )).rows

    expect(second.length).toBe(1)
    expect(second[0].id).toBe(first.id)
    expect(second[0].event_hash).toBe(first.event_hash)
  })
})
