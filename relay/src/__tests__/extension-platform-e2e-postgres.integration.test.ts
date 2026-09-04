import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  deleteSession,
  initDB,
  persistOwnedClientEvent,
} from '../db.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { createPostgresExtensionJournalSink } from '../extensions/journal.js'
import { projectFeedBatch } from '../extensions/feed-projector.js'
import {
  createProviderCredential,
  signProviderExtensionToken,
} from '../extensions/provider-auth.js'
import { registerProviderTokenRoute } from '../extensions/provider-auth-routes.js'
import { registerFeedRoutes } from '../extensions/feed-routes.js'
import { registerSnapshotRoutes } from '../extensions/snapshot-routes.js'
import { registerStatusRoutes } from '../extensions/status-routes.js'
import { registerUsageRoutes } from '../extensions/usage-routes.js'
import { registerPurgeRoutes } from '../extensions/purge-routes.js'
import { registerExtensionInstallationRoutes } from '../extensions/installation-routes.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'e2e-provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'e2e-cursor-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const MARKER = 'extension-e2e-marker-8f3a1c'

/**
 * Mock pocketctl-memory consumer E2E: provision → install → ingest → project
 * → pull → durable inbox → ack → restart → duplicate → takeover → pause →
 * delete (tombstone) → snapshot reconcile → status/usage → uninstall + purge
 * ack. The consumer keeps a local inbox keyed by (installation, feed_id) —
 * exactly the idempotency contract real providers must implement.
 */
describeWithDatabase('extension platform end-to-end (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let userId: number
  let installationId: string
  let clientSecret: string
  let clientId: string

  // The provider's durable inbox across restarts.
  const inbox = new Map<string, Record<string, unknown>>()

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)

    const base = {
      pool,
      mode: 'enabled' as const,
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
    }
    app = Fastify()
    registerProviderTokenRoute(app, base)
    registerFeedRoutes(app, { ...base, cursorSecret: CURSOR_SECRET, leaseTtlSeconds: 3600 })
    registerSnapshotRoutes(app, { ...base, cursorSecret: CURSOR_SECRET })
    registerStatusRoutes(app, { ...base, verifyAccessToken: async () => ({ userId }) })
    registerUsageRoutes(app, { ...base, verifyAccessToken: async () => ({ userId }) })
    registerPurgeRoutes(app, base)
    registerExtensionInstallationRoutes(app, {
      pool,
      mode: 'enabled',
      verifyAccessToken: async () => ({ userId }),
      cursorSecret: CURSOR_SECRET,
    })
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  async function providerToken(): Promise<string> {
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/token',
      payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    })
    expect(response.statusCode).toBe(200)
    return response.json().access_token
  }

  async function pull(token: string, cursor?: string): Promise<Record<string, unknown>> {
    const url = cursor
      ? `/api/extensions/v1/feed?installation_id=${installationId}&cursor=${encodeURIComponent(cursor)}`
      : `/api/extensions/v1/feed?installation_id=${installationId}&limit=100`
    const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  async function ack(token: string, cursor: string, leaseToken: string): Promise<number> {
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/feed/ack',
      headers: { authorization: `Bearer ${token}` },
      payload: { installation_id: installationId, cursor, lease_token: leaseToken },
    })
    return response.statusCode
  }

  function consume(batch: Record<string, unknown>): void {
    for (const item of batch.items as Array<Record<string, unknown>>) {
      inbox.set(`${installationId}:${item.feed_id}`, item)
    }
  }

  test('provision, install, ingest, project, pull, persist, ack', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)

    // 1. Provision the first-party provider credential.
    const credential = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'e2e-client',
    })
    clientId = credential.clientId
    clientSecret = credential.clientSecret

    // 2. Create the user, a session and an installation.
    userId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('e2e@example.test', 'x') RETURNING id
    `)).rows[0].id
    await pool.query(`
      INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
      VALUES ('e2e-daemon', 'h', '[]'::jsonb, 'online', $1)
    `, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
      VALUES ('e2e-session', 'e2e-daemon', 'codex', '/repo', 'running', $1)
    `, [userId])
    installationId = (await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: userId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read', 'session:snapshot:read', 'session:deletion:read'],
      subscriptions: ['session.event.v1', 'turn.lifecycle.v1', 'session.deleted.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'retained_history',
    })).installation_id

    // 3. Mixed canonical events through the owned path + a turn terminal
    //    through the materializer.
    await persistOwnedClientEvent(pool, userId, 'e2e-session', 'agent_text',
      { type: 'agent_text', text: `${MARKER} hello` }, createPostgresExtensionJournalSink())
    await persistOwnedClientEvent(pool, userId, 'e2e-session', 'tool_call',
      { type: 'tool_call', tool: 'Read' }, createPostgresExtensionJournalSink())
    const materializer = new EventMaterializer({
      pool, extensionJournalSink: createPostgresExtensionJournalSink(),
    })
    await materializer.materialize({
      inboxId: 0, userId, daemonId: 'e2e-daemon', sessionId: 'e2e-session',
      eventType: 'turn_status',
      payload: { type: 'turn_status', session_id: 'e2e-session', turn_id: 'turn:v1:e2e:1', turn: 'completed' },
      receivedAt: new Date(),
    })

    // 4. Project the journal into the shared feed.
    const projected = await projectFeedBatch(pool, { batchSize: 100 })
    expect(projected.projected).toBe(3)

    // 5. Provider exchanges credentials and pulls.
    const token = await providerToken()
    const batch = await pull(token)
    expect((batch.items as Array<Record<string, unknown>>).length).toBe(3)
    const texts = JSON.stringify(batch.items)
    expect(texts).toContain(MARKER)
    expect(texts).not.toContain('e2e-provider-secret')

    // 6. Commit the batch to the local durable inbox, then ack.
    consume(batch)
    expect(await ack(token, String(batch.next_cursor), String(batch.lease_token))).toBe(200)
  })

  test('restart, duplicate pull/ack and lease takeover stay idempotent', async () => {
    const token = await providerToken()

    // Consumer "restarts" (the inbox map persists) and re-pulls: redelivery
    // collapses on the (installation, feed_id) key.
    const duplicate = await pull(token)
    consume(duplicate)

    const checkpoint = await pool.query<{ ack_feed_id: string }>(
      `SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    const before = Number(checkpoint.rows[0].ack_feed_id)

    // A second consumer instance takes over; the first one's stale ack fails.
    const secondInstance = await pull(await providerToken())
    const firstCursor = duplicate.next_cursor as string
    const firstLease = duplicate.lease_token as string
    expect(await ack(token, firstCursor, firstLease)).toBe(409)

    // The takeover instance acks cleanly and the checkpoint never regresses.
    expect(await ack(await providerToken(), String(secondInstance.next_cursor), String(secondInstance.lease_token))).toBe(200)
    const after = await pool.query<{ ack_feed_id: string }>(
      `SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    expect(Number(after.rows[0].ack_feed_id)).toBeGreaterThanOrEqual(before)
  })

  test('pause blocks delivery and resume continues', async () => {
    const repository = new ExtensionInstallationRepository(pool)
    const current = await repository.getInstallationForUser(userId, installationId)
    await repository.updateInstallation(userId, installationId, current!.config_version, { status: 'paused' })

    const token = await providerToken()
    const paused = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(paused.statusCode).toBe(409)

    const pausedRow = await repository.getInstallationForUser(userId, installationId)
    await repository.updateInstallation(userId, installationId, pausedRow!.config_version, { status: 'active' })
    const resumed = await pull(await providerToken())
    expect(Array.isArray(resumed.items)).toBe(true)
  })

  test('session delete produces a tombstone the consumer ingests', async () => {
    await deleteSession(pool, 'e2e-session', { extensionMode: 'enabled' })
    await projectFeedBatch(pool, { batchSize: 100 })

    const token = await providerToken()
    const batch = await pull(token)
    const items = batch.items as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    expect(items[0].topic).toBe('session.deleted.v1')
    expect(JSON.stringify(items[0].data)).not.toContain(MARKER)
    consume(batch)
    expect(await ack(token, String(batch.next_cursor), String(batch.lease_token))).toBe(200)

    // The feed no longer returns deleted content on any later pull.
    const after = await pull(await providerToken(), String(batch.next_cursor))
    expect((after.items as unknown[]).length).toBe(0)
  })

  test('snapshot inventory reconciliation sees the deletion', async () => {
    const token = await providerToken()
    const inventory = await app.inject({
      method: 'GET', url: `/api/extensions/v1/sessions?installation_id=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(inventory.statusCode).toBe(200)
    const sessions = inventory.json().sessions as Array<Record<string, unknown>>
    expect(sessions.find(session => session.session_id === 'e2e-session')).toBeUndefined()
  })

  test('status and usage reporting round-trip', async () => {
    const token = await providerToken()
    const status = await app.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        installation_id: installationId, state: 'ready', provider_version: '1.0.0',
        last_feed_id: inbox.size, feed_lag_seconds: 0,
      },
    })
    expect(status.statusCode).toBe(200)

    const usage = await app.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        installation_id: installationId,
        facts: [{
          usage_id: 'e2e-u-1', operation: 'recall', model: 'test',
          input_tokens: 1, output_tokens: 1, embedding_tokens: 0, cached_tokens: 0,
          cost_micros: 1, occurred_at: new Date().toISOString(),
        }],
      },
    })
    expect(usage.statusCode).toBe(200)
  })

  test('uninstall revokes and the purge ack completes the lifecycle', async () => {
    const repository = new ExtensionInstallationRepository(pool)
    const revoked = await repository.revokeInstallation(userId, installationId)
    expect(revoked.installation.status).toBe('revoking')

    // Ordinary capabilities are closed.
    const token = await providerToken()
    const feedClosed = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(feedClosed.statusCode).toBe(403)

    // The purge queue is still reachable and ackable.
    const queue = await app.inject({
      method: 'GET', url: '/api/extensions/v1/purges',
      headers: { authorization: `Bearer ${await providerToken()}` },
    })
    expect(queue.statusCode).toBe(200)
    const purges = queue.json().purges as Array<{ request_id: string }>
    expect(purges.length).toBe(1)
    const acked = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${purges[0].request_id}/ack`,
      headers: { authorization: `Bearer ${await providerToken()}` },
      payload: { provider_receipt: `sha256:${MARKER}` },
    })
    expect(acked.statusCode).toBe(200)

    // Fixture cleanup: nothing marker-bearing survives.
    const leftovers = await pool.query(
      `SELECT COUNT(*)::int AS c FROM extension_feed WHERE payload::text LIKE $1`,
      [`%${MARKER}%`],
    )
    expect(leftovers.rows[0].c).toBe(0)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
  })
})
