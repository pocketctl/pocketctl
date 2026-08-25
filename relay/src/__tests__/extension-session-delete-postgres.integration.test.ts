import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  deleteSession,
  deleteUserAccount,
  initDB,
  persistOwnedClientEvent,
} from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { createPostgresExtensionJournalSink, CANONICAL_EVENT_SOURCE_KIND } from '../extensions/journal.js'
import { projectFeedBatch } from '../extensions/feed-projector.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension session deletion tombstone (PostgreSQL)', () => {
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
    await upsertProviderDefinitions(pool)
    userId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('delete-owner@example.test', 'x') RETURNING id
    `)).rows[0].id
    await pool.query(`
      INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
      VALUES ('delete-daemon', 'h', '[]'::jsonb, 'online', $1)
    `, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
      VALUES ('delete-session', 'delete-daemon', 'codex', '/repo', 'running', $1)
    `, [userId])
  })

  async function journal(text: string) {
    await persistOwnedClientEvent(pool, userId, 'delete-session', 'agent_text',
      { type: 'agent_text', text }, createPostgresExtensionJournalSink())
  }

  test('deleting a session clears feed content and journals a unique tombstone', async () => {
    await journal('one')
    await journal('two')
    await projectFeedBatch(pool, { batchSize: 100 })
    await journal('three') // still unprojected in the journal

    expect((await pool.query(`SELECT COUNT(*)::int AS c FROM extension_feed WHERE session_id = 'delete-session'`)).rows[0].c).toBe(2)
    expect((await pool.query(`SELECT COUNT(*)::int AS c FROM extension_source_outbox WHERE session_id = 'delete-session'`)).rows[0].c).toBe(1)

    await deleteSession(pool, 'delete-session', { extensionMode: 'enabled' })

    // No content remains in either surface.
    expect((await pool.query(`
      SELECT COUNT(*)::int AS c FROM extension_feed
      WHERE session_id = 'delete-session' AND source_kind = '${CANONICAL_EVENT_SOURCE_KIND}'
    `)).rows[0].c).toBe(0)
    expect((await pool.query(`
      SELECT COUNT(*)::int AS c FROM extension_source_outbox
      WHERE session_id = 'delete-session' AND source_kind = '${CANONICAL_EVENT_SOURCE_KIND}'
    `)).rows[0].c).toBe(0)
    expect((await pool.query(`SELECT COUNT(*)::int AS c FROM events WHERE session_id = 'delete-session'`)).rows[0].c).toBe(0)

    // Exactly one generic tombstone source row survives for projection.
    const tombstone = await pool.query(`
      SELECT source_kind, source_id, owner_user_id, payload
      FROM extension_source_outbox
      WHERE session_id = 'delete-session' AND source_kind = 'session_deleted'
    `)
    expect(tombstone.rowCount).toBe(1)
    expect(tombstone.rows[0].source_id).toBe('session_deleted:delete-session')
    expect(Number(tombstone.rows[0].owner_user_id)).toBe(userId)

    // Repeated deletes cannot duplicate the tombstone.
    await pool.query(`INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
      VALUES ('delete-session', 'delete-daemon', 'codex', '/repo', 'running', $1)`, [userId])
    await deleteSession(pool, 'delete-session', { extensionMode: 'enabled' })
    expect((await pool.query(`
      SELECT COUNT(*)::int AS c FROM extension_source_outbox
      WHERE session_id = 'delete-session' AND source_kind = 'session_deleted'
    `)).rows[0].c).toBe(1)
  })

  test('the projected tombstone reaches the feed as session.deleted.v1', async () => {
    await journal('one')
    await projectFeedBatch(pool, { batchSize: 100 })
    await deleteSession(pool, 'delete-session', { extensionMode: 'enabled' })
    await projectFeedBatch(pool, { batchSize: 100 })

    const tombstoneFeed = await pool.query(`
      SELECT topic, payload FROM extension_feed
      WHERE session_id = 'delete-session' AND source_kind = 'session_deleted'
    `)
    expect(tombstoneFeed.rowCount).toBe(1)
    expect(tombstoneFeed.rows[0].topic).toBe('session.deleted.v1')
  })

  test('a concurrent persist racing the delete ends in one of the two legal outcomes', async () => {
    await journal('before')

    // Outcome 1: the event commits first, then the delete removes it and
    // journals the tombstone.
    await deleteSession(pool, 'delete-session', { extensionMode: 'enabled' })
    const afterDelete = await pool.query(`
      SELECT COUNT(*)::int AS c FROM extension_feed
      WHERE session_id = 'delete-session' AND source_kind = '${CANONICAL_EVENT_SOURCE_KIND}'
    `)
    expect(afterDelete.rows[0].c).toBe(0)

    // Outcome 2: the delete committed first; the daemon fence now rejects
    // later events for the deleted session.
    await pool.query(`INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
      VALUES ('delete-session', 'delete-daemon', 'codex', '/repo', 'running', $1)`, [userId])
    const { EventMaterializer } = await import('../materialization/event-materializer.js')
    const materializer = new EventMaterializer({
      pool,
      extensionJournalSink: createPostgresExtensionJournalSink(),
    })
    await expect(materializer.materialize({
      inboxId: 0,
      userId,
      daemonId: 'delete-daemon',
      sessionId: 'delete-session',
      eventType: 'agent_text',
      payload: { type: 'agent_text', session_id: 'delete-session', text: 'late' },
      receivedAt: new Date(),
    })).rejects.toMatchObject({ name: 'UnknownDaemonSessionError' })
  })

  test('account deletion creates purge evidence and clears extension rows', async () => {
    await journal('one')
    await projectFeedBatch(pool, { batchSize: 100 })
    const installation = await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: userId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'from_now',
    })
    const installationId = installation.installation_id

    await deleteUserAccount(pool, userId)

    expect((await pool.query(`SELECT COUNT(*)::int AS c FROM extension_source_outbox WHERE owner_user_id = $1`, [userId])).rows[0].c).toBe(0)
    expect((await pool.query(`SELECT COUNT(*)::int AS c FROM extension_feed WHERE owner_user_id = $1`, [userId])).rows[0].c).toBe(0)
    // The installation cascades away with the user, but the purge evidence
    // (no FK) survives until the provider acks.
    const purge = await pool.query(`
      SELECT reason, status FROM extension_purge_requests WHERE installation_id = $1
    `, [installationId])
    expect(purge.rowCount).toBe(1)
    expect(purge.rows[0].reason).toBe('account_deleted')
    expect(purge.rows[0].status).toBe('pending')
  })
})
