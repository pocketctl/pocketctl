import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, persistOwnedClientEvent } from '../db.js'
import { projectFeedBatch } from '../extensions/feed-projector.js'
import { countSourceBacklog } from '../extensions/feed-repository.js'
import { createPostgresExtensionJournalSink } from '../extensions/journal.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension feed projector (PostgreSQL)', () => {
  let pool: pg.Pool
  let userIdA: number
  let userIdB: number

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
    userIdA = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('feed-a@example.test', 'x') RETURNING id
    `)).rows[0].id
    userIdB = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('feed-b@example.test', 'x') RETURNING id
    `)).rows[0].id
    for (const [sessionId, owner] of [['feed-session-a', userIdA], ['feed-session-b', userIdB]] as const) {
      await pool.query(`
        INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
        VALUES ($1, 'h', '[]'::jsonb, 'online', $2)
      `, [`${sessionId}-daemon`, owner])
      await pool.query(`
        INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
        VALUES ($1, $2, 'codex', '/repo', 'running', $3)
      `, [sessionId, `${sessionId}-daemon`, owner])
    }
  })

  async function journalEvent(sessionId: string, owner: number, text: string): Promise<void> {
    await persistOwnedClientEvent(
      pool, owner, sessionId, 'agent_text',
      { type: 'agent_text', session_id: sessionId, text },
      createPostgresExtensionJournalSink(),
    )
  }

  test('projects claimed sources to feed rows and deletes them atomically', async () => {
    await journalEvent('feed-session-a', userIdA, 'one')
    await journalEvent('feed-session-a', userIdA, 'two')
    await journalEvent('feed-session-b', userIdB, 'other-owner')
    expect(await countSourceBacklog(pool)).toBe(3)

    const result = await projectFeedBatch(pool, { batchSize: 50 })

    expect(result).toEqual({ projected: 3, skipped: false })
    expect(await countSourceBacklog(pool)).toBe(0)
    const feed = await pool.query(
      `SELECT owner_user_id, topic, source_kind, source_id, session_id, payload
       FROM extension_feed ORDER BY feed_id`,
    )
    expect(feed.rowCount).toBe(3)
    expect(feed.rows.map(row => row.topic)).toEqual([
      'session.event.v1', 'session.event.v1', 'session.event.v1',
    ])
    expect(new Set(feed.rows.map(row => Number(row.owner_user_id))))
      .toEqual(new Set([userIdA, userIdB]))
    const stored = feed.rows[0].payload as Record<string, unknown>
    expect(stored.envelope_version).toBe(1)
    expect((stored.source as Record<string, unknown>).kind).toBe('canonical_event')
    expect('feed_id' in stored).toBe(false)
  })

  test('re-projecting the same source identity stays idempotent', async () => {
    await journalEvent('feed-session-a', userIdA, 'dup')
    // Re-insert the same source identity directly, simulating a retried
    // journal append racing the projector.
    await pool.query(`
      INSERT INTO extension_source_outbox (source_kind, source_id, owner_user_id, session_id, event_type, payload)
      SELECT source_kind, source_id, owner_user_id, session_id, event_type, payload
      FROM extension_source_outbox
      ON CONFLICT (source_kind, source_id) DO NOTHING
    `)
    await projectFeedBatch(pool, { batchSize: 50 })

    // Replaying the identical feed insert conflicts away.
    await pool.query(`
      INSERT INTO extension_feed (owner_user_id, topic, source_kind, source_id, session_id, payload)
      SELECT owner_user_id, topic, source_kind, source_id, session_id, payload
      FROM extension_feed
      ON CONFLICT (source_kind, source_id, topic, envelope_version) DO NOTHING
    `)
    const feed = await pool.query(`SELECT COUNT(*)::int AS count FROM extension_feed`)
    expect(feed.rows[0].count).toBe(1)
  })

  test('a failed batch leaves sources intact for retry', async () => {
    await journalEvent('feed-session-a', userIdA, 'keepme')
    await expect(pool.query(`ALTER TABLE extension_feed RENAME TO extension_feed_off`)).resolves.toBeDefined()
    await expect(projectFeedBatch(pool, { batchSize: 50 })).rejects.toThrow()
    await pool.query(`ALTER TABLE extension_feed_off RENAME TO extension_feed`)

    expect(await countSourceBacklog(pool)).toBe(1)
    const result = await projectFeedBatch(pool, { batchSize: 50 })
    expect(result.projected).toBe(1)
    expect(await countSourceBacklog(pool)).toBe(0)
  })

  test('concurrent projectors serialize through the advisory lock', async () => {
    await journalEvent('feed-session-a', userIdA, 'race')
    const [first, second] = await Promise.all([
      projectFeedBatch(pool, { batchSize: 50 }),
      projectFeedBatch(pool, { batchSize: 50 }),
    ])
    const productive = [first, second].filter(result => result.projected > 0)
    expect(productive.length).toBe(1)
    const feed = await pool.query(`SELECT COUNT(*)::int AS count FROM extension_feed`)
    expect(feed.rows[0].count).toBe(1)
  })

  test('batches keep source order and respect the batch size bound', async () => {
    for (let index = 0; index < 5; index++) {
      await journalEvent('feed-session-a', userIdA, `ordered-${index}`)
    }
    const firstBatch = await projectFeedBatch(pool, { batchSize: 2 })
    expect(firstBatch.projected).toBe(2)
    const afterFirst = await pool.query<{ source_id: string }>(
      `SELECT source_id FROM extension_source_outbox ORDER BY source_seq`,
    )
    expect(afterFirst.rows.map(row => row.source_id)).toEqual([
      'event:3', 'event:4', 'event:5',
    ].map(id => id))
    const feedOrder = await pool.query(
      `SELECT payload->'data'->>'text' AS text FROM extension_feed ORDER BY feed_id`,
    )
    expect(feedOrder.rows.map(row => row.text)).toEqual(['ordered-0', 'ordered-1'])
  })
})
