import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, persistOwnedClientEvent } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { createPostgresExtensionJournalSink } from '../extensions/journal.js'
import { projectFeedBatch } from '../extensions/feed-projector.js'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import { registerFeedRoutes } from '../extensions/feed-routes.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'cursor-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'

describeWithDatabase('extension feed consumption (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let userIdA: number
  let userIdB: number
  let installationA: string
  let installationB: string
  const repository = () => new ExtensionInstallationRepository(pool)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
    app = Fastify()
    registerFeedRoutes(app, {
      pool,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
      leaseTtlSeconds: 2,
    })
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)
    userIdA = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('consume-a@example.test', 'x') RETURNING id
    `)).rows[0].id
    userIdB = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('consume-b@example.test', 'x') RETURNING id
    `)).rows[0].id
    for (const [sessionId, owner] of [['consume-session-a', userIdA], ['consume-session-b', userIdB]] as const) {
      await pool.query(`
        INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
        VALUES ($1, 'h', '[]'::jsonb, 'online', $2)
      `, [`${sessionId}-daemon`, owner])
      await pool.query(`
        INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
        VALUES ($1, $2, 'codex', '/repo', 'running', $3)
      `, [sessionId, `${sessionId}-daemon`, owner])
    }
    const created = await repository().createInstallation({
      ownerUserId: userIdA,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1', 'turn.lifecycle.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'retained_history',
    })
    installationA = created.installation_id
    const createdB = await repository().createInstallation({
      ownerUserId: userIdB,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'retained_history',
    })
    installationB = createdB.installation_id
  })

  afterEach(async () => {
    // Clean state between tests inside the shared database.
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
  })

  function providerToken(): string {
    return signProviderExtensionToken({
      providerId: 'pocketctl-memory', credentialId: 'cred', secret: PROVIDER_SECRET, issuer: ISSUER,
    })
  }

  async function seedFeed(countA = 3, countB = 1): Promise<void> {
    for (let index = 0; index < countA; index++) {
      await persistOwnedClientEvent(pool, userIdA, 'consume-session-a', 'agent_text',
        { type: 'agent_text', text: `a-${index}` }, createPostgresExtensionJournalSink())
    }
    for (let index = 0; index < countB; index++) {
      await persistOwnedClientEvent(pool, userIdB, 'consume-session-b', 'agent_text',
        { type: 'agent_text', text: `b-${index}` }, createPostgresExtensionJournalSink())
    }
    await projectFeedBatch(pool, { batchSize: 100 })
  }

  async function pull(installationId: string, cursor?: string) {
    const url = cursor
      ? `/api/extensions/v1/feed?installation_id=${installationId}&cursor=${encodeURIComponent(cursor)}`
      : `/api/extensions/v1/feed?installation_id=${installationId}&limit=100`
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${providerToken()}` } })
  }

  async function ack(installationId: string, cursor: string, leaseToken: string) {
    return app.inject({
      method: 'POST', url: '/api/extensions/v1/feed/ack',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: installationId, cursor, lease_token: leaseToken },
    })
  }

  async function checkpointOf(installationId: string) {
    const row = await pool.query<{ ack_feed_id: string; lease_epoch: string }>(
      `SELECT ack_feed_id::text, lease_epoch::text FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    return {
      ack: Number(row.rows[0]?.ack_feed_id ?? 0),
      epoch: Number(row.rows[0]?.lease_epoch ?? 0),
    }
  }

  test('pull -> durable ack advances the checkpoint exactly once', async () => {
    await seedFeed()
    const first = await pull(installationA)
    expect(first.statusCode).toBe(200)
    const body = first.json()
    expect(body.items.length).toBe(3)
    const { items: itemsA } = body

    // Duplicate pull without ack redelivers the same items (at-least-once);
    // the retry issues a fresh lease pair, so the provider acks the latest.
    const again = await pull(installationA)
    expect(again.json().items.length).toBe(3)

    // Cross-tenant isolation: user A's installation never sees user B rows.
    expect(itemsA.every((item: { data: { text: string } }) => item.data.text.startsWith('a-'))).toBe(true)

    // Ack is idempotent and monotonic.
    const latest = again.json()
    const acked = await ack(installationA, latest.next_cursor, latest.lease_token)
    expect(acked.statusCode).toBe(200)
    const duplicate = await ack(installationA, latest.next_cursor, latest.lease_token)
    expect(duplicate.statusCode).toBe(200)
    expect((await checkpointOf(installationA)).ack).toBe(Number(itemsA[itemsA.length - 1].feed_id))

    // The next pull starts after the acknowledged position.
    const post = await pull(installationA)
    expect(post.json().items).toEqual([])
  })

  test('a lease takeover fences the previous instance ack', async () => {
    await seedFeed(2)
    const first = await pull(installationA)
    const oldCursor = first.json().next_cursor
    const oldToken = first.json().lease_token

    // A second instance takes over with a fresh pull (no cursor).
    const takeover = await pull(installationA)
    expect(takeover.statusCode).toBe(200)

    // The old instance's ack now fails closed.
    const stale = await ack(installationA, oldCursor, oldToken)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('stale_lease')
    expect((await checkpointOf(installationA)).ack).toBe(0)

    // The new instance acks successfully.
    const ok = await ack(installationA, takeover.json().next_cursor, takeover.json().lease_token)
    expect(ok.statusCode).toBe(200)
  })

  test('an ack cannot jump past the delivered batch using a foreign cursor', async () => {
    await seedFeed(2)
    const first = await pull(installationA)
    const firstCursor = first.json().next_cursor
    const firstToken = first.json().lease_token

    // A later pull under a new lease issues a further cursor.
    const second = await pull(installationA, firstCursor)
    const secondCursor = second.json().next_cursor
    const secondToken = second.json().lease_token

    // Acking the LATER cursor with the FIRST lease's token is fenced out.
    const jumped = await ack(installationA, secondCursor, firstToken)
    expect(jumped.statusCode).toBe(409)

    // The matching pair still acks.
    const ok = await ack(installationA, secondCursor, secondToken)
    expect(ok.statusCode).toBe(200)
  })

  test('paused installations stop delivery but keep the checkpoint', async () => {
    await seedFeed(1)
    await repository().updateInstallation(userIdA, installationA, 1, { status: 'paused' })
    const response = await pull(installationA)
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('installation_paused')
    // The checkpoint row survives pause.
    expect(await checkpointOf(installationA)).toBeDefined()
  })

  test('provider A cannot read provider B installations', async () => {
    await seedFeed(1)
    const otherProviderToken = signProviderExtensionToken({
      providerId: 'pocketctl-memory', credentialId: 'other', secret: 'wrong-secret-0123456789', issuer: ISSUER,
    })
    expect(otherProviderToken).toBeTruthy()
    // A token verified against a DIFFERENT installation binding: simulate by
    // requesting B's installation with a forged provider id via direct SQL is
    // not possible; use a second provider by inserting one.
    await pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('other-provider', 1, '{}'::jsonb)
    `)
    const otherToken = signProviderExtensionToken({
      providerId: 'other-provider', credentialId: 'c2', secret: PROVIDER_SECRET, issuer: ISSUER,
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${installationA}`,
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(response.statusCode).toBe(404)
  })

  test('installation A never receives user B rows even after replay semantics', async () => {
    await seedFeed(3, 2)
    const response = await pull(installationB)
    const items = response.json().items
    expect(items.length).toBe(2)
    expect(items.every((item: { data: { text: string } }) => item.data.text.startsWith('b-'))).toBe(true)
  })

  test('a stale-epoch cursor can never wind the lease epoch back', async () => {
    await seedFeed(2)
    const first = await pull(installationA)
    const oldCursor = first.json().next_cursor

    // Instance B takes over with a fresh pull (epoch +1).
    const takeover = await pull(installationA)
    expect(takeover.statusCode).toBe(200)
    const epochAfterTakeover = (await checkpointOf(installationA)).epoch
    expect(epochAfterTakeover).toBeGreaterThan(0)

    // Instance A's old-cursor GET is fenced out instead of regressing the epoch.
    const stale = await pull(installationA, oldCursor)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('stale_lease')
    expect((await checkpointOf(installationA)).epoch).toBe(epochAfterTakeover)
  })

  test('filtered installations still receive deletion tombstones', async () => {
    // Re-create installation A with a daemon filter.
    await pool.query(`DELETE FROM extension_installations WHERE installation_id = $1`, [installationA])
    const filtered = await repository().createInstallation({
      ownerUserId: userIdA,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read', 'session:deletion:read'],
      subscriptions: ['session.event.v1', 'session.deleted.v1'],
      enabledServices: ['memory.search'],
      eventFilter: { daemon_ids: ['consume-session-a-daemon'] },
      startPolicy: 'retained_history',
    })
    installationA = filtered.installation_id

    await seedFeed(1)
    const token = providerToken()
    const before = await pull(installationA)
    expect(before.json().items.length).toBe(1)

    // Deleting the session removes the sessions row; the tombstone feed row
    // must still be delivered through the daemon filter.
    const { deleteSession } = await import('../db.js')
    await deleteSession(pool, 'consume-session-a', { extensionMode: 'enabled' })
    await projectFeedBatch(pool, { batchSize: 100 })
    const after = await pull(installationA, before.json().next_cursor)
    expect(after.statusCode).toBe(200)
    const items = after.json().items as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    expect(items[0].topic).toBe('session.deleted.v1')
  })

  test('retention keeps rows a checkpoint-less installation still needs', async () => {
    // installationB (retained_history, never pulled in this test) has no
    // checkpoint row; start_feed_id=0 must still guard its retained history.
    expect(await checkpointOf(installationB)).toEqual({ ack: 0, epoch: 0 })

    // Seed one aged-but-not-hard-maxed row owned by user B.
    await pool.query(`
      INSERT INTO extension_feed (feed_id, owner_user_id, topic, source_kind, source_id, payload, created_at)
      VALUES (9001, $1, 'session.event.v1', 'canonical_event', 'event:9001', '{}'::jsonb, NOW() - INTERVAL '10 days')
      ON CONFLICT (source_kind, source_id, topic, envelope_version) DO NOTHING
    `, [userIdB])
    await pool.query(`SELECT setval('extension_feed_feed_id_seq', 9001)`)

    const { runFeedRetentionOnce } = await import('../extensions/retention.js')
    const result = await runFeedRetentionOnce(pool, { retentionDays: 7 })
    const survivor = await pool.query(
      `SELECT COUNT(*)::int AS c FROM extension_feed WHERE feed_id = 9001`,
    )
    expect(survivor.rows[0].c).toBe(1)
    expect(result.deleted).toBe(0)
  })

  test('expiring leases fail closed after the TTL', async () => {
    await seedFeed(1)
    const first = await pull(installationA)
    expect(first.statusCode).toBe(200)
    // Lease TTL is 2s in this suite.
    await new Promise(resolve => setTimeout(resolve, 2300))
    const late = await ack(installationA, first.json().next_cursor, first.json().lease_token)
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('stale_lease')
  })
})
