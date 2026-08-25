import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { runFeedRetentionOnce, clearSnapshotRequiredFlag } from '../extensions/retention.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension feed retention (PostgreSQL)', () => {
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
      INSERT INTO users (email, password_hash) VALUES ('retention@example.test', 'x') RETURNING id
    `)).rows[0].id
  })

  async function seedFeedRow(feedId: number, ageDays: number): Promise<void> {
    await pool.query(`
      INSERT INTO extension_feed (feed_id, owner_user_id, topic, source_kind, source_id, payload, created_at)
      VALUES ($1, $2, 'session.event.v1', 'canonical_event', $3, '{}'::jsonb, NOW() - ($4 * INTERVAL '1 day'))
      ON CONFLICT (source_kind, source_id, topic, envelope_version) DO NOTHING
    `, [feedId, userId, `event:${feedId}`, ageDays])
    await pool.query(`SELECT setval('extension_feed_feed_id_seq', GREATEST($1, (SELECT last_value FROM extension_feed_feed_id_seq)))`, [feedId])
  }

  async function createInstallationWithAck(ackFeedId: number): Promise<string> {
    const installation = await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: userId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'retained_history',
    })
    await pool.query(`
      INSERT INTO extension_checkpoints (installation_id, ack_feed_id) VALUES ($1, $2)
      ON CONFLICT (installation_id) DO UPDATE SET ack_feed_id = $2
    `, [installation.installation_id, ackFeedId])
    return installation.installation_id
  }

  test('deletes aged rows below the ack but keeps rows a live installation still needs', async () => {
    await seedFeedRow(1, 30)
    await seedFeedRow(2, 30)
    await seedFeedRow(3, 1)
    await createInstallationWithAck(2) // installation still needs rows 1..2? ack=2 → needs nothing below? ack=2 means consumed through 2
    // ack=2: rows with feed_id <= 2 are acknowledged; retention may delete them.
    const result = await runFeedRetentionOnce(pool, { retentionDays: 7 })

    expect(result.deleted).toBeGreaterThanOrEqual(2)
    const remaining = await pool.query(`SELECT feed_id FROM extension_feed ORDER BY feed_id`)
    expect(remaining.rows.map(row => Number(row.feed_id))).toEqual([3])
  })

  test('an aged row above the ack survives the soft pass', async () => {
    await seedFeedRow(1, 10) // past retention (7d), below the hard max (14d)
    await createInstallationWithAck(0) // nothing acknowledged yet
    const result = await runFeedRetentionOnce(pool, { retentionDays: 7 })
    expect(result.deleted).toBe(0)
    const remaining = await pool.query(`SELECT COUNT(*)::int AS c FROM extension_feed`)
    expect(remaining.rows[0].c).toBe(1)
  })

  test('the hard max deletes anyway and marks the lagging installation', async () => {
    await seedFeedRow(1, 40) // far past hard max (14 days)
    const installationId = await createInstallationWithAck(0)

    const result = await runFeedRetentionOnce(pool, { retentionDays: 7 })

    expect(result.deleted).toBe(1)
    expect(result.markedInstallations).toBe(1)
    const marked = await pool.query(
      `SELECT snapshot_required_at FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    expect(marked.rows[0].snapshot_required_at).not.toBeNull()

    // The flag clears after an explicit reconciliation (snapshot rebuild).
    await clearSnapshotRequiredFlag(pool, installationId)
    const cleared = await pool.query(
      `SELECT snapshot_required_at FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    expect(cleared.rows[0].snapshot_required_at).toBeNull()
  })

  test('a never-pulled installation is marked (not silently truncated) past the hard max', async () => {
    // No checkpoint row: the provider of this retained_history installation
    // has never pulled. start_feed_id=0 means every row is still owed.
    const { ExtensionInstallationRepository } = await import('../extensions/installation-repository.js')
    const never = await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: userId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'retained_history',
    })
    const before = await pool.query(
      `SELECT COUNT(*)::int AS c FROM extension_checkpoints WHERE installation_id = $1`,
      [never.installation_id],
    )
    expect(before.rows[0].c).toBe(0)

    await seedFeedRow(5000, 40) // far past the 14-day hard max
    const result = await runFeedRetentionOnce(pool, { retentionDays: 7 })

    expect(result.deleted).toBe(1)
    expect(result.markedInstallations).toBe(1)
    const marked = await pool.query(
      `SELECT snapshot_required_at FROM extension_checkpoints WHERE installation_id = $1`,
      [never.installation_id],
    )
    expect(marked.rowCount).toBe(1) // the upsert created the missing row
    expect(marked.rows[0].snapshot_required_at).not.toBeNull()

    // The next pull demands a snapshot with the documented flag.
    const feed = await import('../extensions/feed-routes.js')
    const Fastify = (await import('fastify')).default
    const app = Fastify()
    const { signProviderExtensionToken } = await import('../extensions/provider-auth.js')
    feed.registerFeedRoutes(app, {
      pool,
      mode: 'enabled',
      providerJwtSecret: 'retention-provider-secret-0123456789',
      issuer: 'https://relay.example.test',
      cursorSecret: 'retention-cursor-secret-0123456789',
      leaseTtlSeconds: 60,
    })
    const token = signProviderExtensionToken({
      providerId: 'pocketctl-memory', credentialId: 'c',
      secret: 'retention-provider-secret-0123456789',
      issuer: 'https://relay.example.test',
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${never.installation_id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    await app.close()
    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('cursor_expired')
    expect(response.json().error.snapshot_required).toBe(true)
  })

  test('purge requests survive retention untouched', async () => {
    await pool.query(`
      INSERT INTO extension_purge_requests (request_id, provider_id, installation_id, reason, expires_at)
      VALUES (gen_random_uuid(), 'pocketctl-memory', gen_random_uuid(), 'uninstall', NOW() - INTERVAL '60 days')
    `)
    await runFeedRetentionOnce(pool, { retentionDays: 1 })
    const purges = await pool.query(`SELECT COUNT(*)::int AS c FROM extension_purge_requests`)
    expect(purges.rows[0].c).toBe(1)
  })
})
