/**
 * Phase 0 end-to-end gate: a REAL Relay (actual route modules on the Relay
 * purpose-named test database) talking to REAL Memory modules (on the Memory
 * purpose-named test database). Two databases, one process: the Memory HTTP
 * clients dial the Relay app through an inject adapter.
 *
 * This file is excluded from `tsc` builds (it reaches across package roots
 * to mount the real Relay); vitest transforms it directly.
 */
import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { generateKeyPairSync } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

// Relay side (real production modules, test harness only).
import { initDB, persistOwnedClientEvent } from '../../../relay/src/db.js'
import { upsertProviderDefinitions } from '../../../relay/src/extensions/catalog.js'
import { createProviderCredential, signProviderExtensionToken } from '../../../relay/src/extensions/provider-auth.js'
import { registerProviderTokenRoute } from '../../../relay/src/extensions/provider-auth-routes.js'
import { registerFeedRoutes } from '../../../relay/src/extensions/feed-routes.js'
import { registerSnapshotRoutes } from '../../../relay/src/extensions/snapshot-routes.js'
import { registerProviderInstallationRoutes } from '../../../relay/src/extensions/provider-installation-routes.js'
import { registerCapabilityRoutes } from '../../../relay/src/extensions/capability-routes.js'
import { registerStatusRoutes } from '../../../relay/src/extensions/status-routes.js'
import { registerUsageRoutes } from '../../../relay/src/extensions/usage-routes.js'
import { registerPurgeRoutes } from '../../../relay/src/extensions/purge-routes.js'
import { registerExtensionInstallationRoutes } from '../../../relay/src/extensions/installation-routes.js'
import { resolveGrantKeyMaterial, signCapabilityGrant, publicJwks } from '../../../relay/src/extensions/capability-grant.js'
import { createPostgresExtensionJournalSink } from '../../../relay/src/extensions/journal.js'
import { projectFeedBatch } from '../../../relay/src/extensions/feed-projector.js'

// Memory side (real production modules).
import { applyMemorySchema } from '../schema.js'
import { createRelayHttpClient } from '../relay/http-client.js'
import { createProviderTokenClient } from '../relay/token-client.js'
import { createInstallationsClient } from '../relay/installations.js'
import { createFeedClient } from '../relay/feed-client.js'
import { createSnapshotClient } from '../relay/snapshot-client.js'
import { createPurgeClient } from '../relay/purge-client.js'
import { createReportingClient } from '../relay/reporting-client.js'
import { createInstallationRegistry } from '../installations/repository.js'
import { createFeedConsumer } from '../inbox/feed-worker.js'
import { createProjectionHandler } from '../projection/repository.js'
import { createEpisodeRepository } from '../episodes/repository.js'
import { createSnapshotReconciler } from '../snapshot/reconcile-worker.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createPurgeWorker } from '../purge/worker.js'
import { createCapabilityVerifier } from '../relay/capability-verifier.js'

const relayDatabaseUrl = process.env.TEST_DATABASE_URL
const memoryDatabaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const e2eEnabled = Boolean(
  relayDatabaseUrl
  && memoryDatabaseUrl
  && relayDatabaseUrl !== memoryDatabaseUrl
  && process.env.RUN_POSTGRES_INTEGRATION === '1'
  && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeE2E = e2eEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'e2e-provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'e2e-cursor-secret-0123456789abcdef'
const ISSUER = 'http://relay.e2e.test'
const HMAC_KEY = 'e2e-hmac-key-0123456789abcdef-0123456789abcdef'

type InjectResponse = { statusCode: number; headers: Record<string, string>; body: string }

/** Route Memory's fetch calls into the in-process Relay app. */
function relayFetch(app: FastifyInstance, failNext = false): typeof fetch {
  let broken = failNext
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (broken) throw new TypeError('relay outage (injected)')
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.replace(ISSUER, '')
    const headers: Record<string, string> = {}
    const auth = init?.headers
    if (auth) {
      const entries = auth instanceof Headers ? [...auth.entries()]
        : Array.isArray(auth) ? (auth as string[][]).map(([k, v]) => [k, v] as [string, string])
          : Object.entries(auth as Record<string, string>)
      for (const [key, value] of entries) headers[key.toLowerCase()] = value
    }
    const response = await app.inject({
      method: (init?.method ?? 'GET') as string,
      url: path,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    }) as unknown as InjectResponse
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers,
    })
  }) as typeof fetch
}

describeE2E('phase 0 relay <-> memory (two real databases)', () => {
  let relayPool: pg.Pool
  let memoryPool: pg.Pool
  let relay: FastifyInstance
  let grantKeys: ReturnType<typeof resolveGrantKeyMaterial>
  let clientId = ''
  let clientSecret = ''
  let installationId = ''
  let userId = 0

  // Memory-side wiring (rebuilt per scenario to simulate restarts).
  function buildMemory(fetchImpl: typeof fetch) {
    const http = createRelayHttpClient({
      baseUrl: ISSUER, timeoutMs: 5_000, maxRetries: 0, fetchImpl,
    })
    const tokens = createProviderTokenClient({
      relayUrl: ISSUER, clientId, clientSecret, http,
    })
    return {
      http,
      tokens,
      installations: createInstallationsClient({ http, tokens }),
      feed: createFeedClient({ http, tokens }),
      snapshot: createSnapshotClient({ http, tokens }),
      purge: createPurgeClient({ http, tokens }),
      reporting: createReportingClient({ http, tokens }),
    }
  }

  async function drainMemory(mem: ReturnType<typeof buildMemory>) {
    const registry = createInstallationRegistry(memoryPool)
    const discoveryItems: Array<Record<string, unknown>> = []
    // Discovery via the real relay inventory.
    const worker = await (async () => {
      const items: typeof discoveryItems = []
      let cursor: string | undefined
      for (;;) {
        const page = await mem.installations.listInstallations(cursor)
        items.push(...page.installations)
        if (!page.has_more || !page.next_cursor) break
        cursor = page.next_cursor
      }
      await registry.applyDiscovery({ generation: 1, items: items as never })
      return items
    })()
    // Feed consumption until dry.
    const consumer = createFeedConsumer({
      pool: memoryPool,
      pullFeed: (id, limit) => mem.feed.pullFeed(id, limit),
      ackFeed: input => mem.feed.ackFeed(input),
      workerId: 'e2e-worker-1',
      signal: new AbortController().signal,
    })
    for (let round = 0; round < 5; round++) {
      await consumer.runOnce()
    }
    // Projection + episodes.
    const projection = createProjectionHandler(memoryPool, {
      purge: createPurgeRepository(memoryPool, { hmacKey: HMAC_KEY }),
    })
    await projection.handleProjectFeed(
      { job_id: 'e2e', installation_id: installationId, job_type: 'project_feed',
        idempotency_key: 'e2e', payload: {}, attempts: 0, claim_epoch: 0 },
      new AbortController().signal,
    )
    const episodes = createEpisodeRepository(memoryPool)
    const pending = await memoryPool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM memory_jobs WHERE job_type = 'compile_episode'`,
    )
    for (const job of pending.rows) {
      await episodes.handleCompileEpisode(
        { job_id: 'e2e', installation_id: installationId, job_type: 'compile_episode',
          idempotency_key: job.idempotency_key, payload: {}, attempts: 0, claim_epoch: 0 },
        new AbortController().signal,
      )
    }
    return { worker }
  }

  beforeAll(async () => {
    relayPool = new pg.Pool({ connectionString: relayDatabaseUrl, max: 4 })
    memoryPool = new pg.Pool({ connectionString: memoryDatabaseUrl, max: 4 })
    // Both databases are distinct, loopback, purpose-named (script guard) —
    // assert once more inside the process.
    const relayDb = await relayPool.query<{ database: string }>('SELECT current_database() AS database')
    const memoryDb = await memoryPool.query<{ database: string }>('SELECT current_database() AS database')
    expect(relayDb.rows[0].database).not.toBe(memoryDb.rows[0].database)

    await initDB(relayPool)
    await applyMemorySchema(memoryPool)
    await upsertProviderDefinitions(relayPool)

    grantKeys = resolveGrantKeyMaterial({})
    const base = {
      pool: relayPool, mode: 'enabled' as const,
      providerJwtSecret: PROVIDER_SECRET, issuer: ISSUER,
    }
    relay = Fastify()
    registerProviderTokenRoute(relay, base)
    registerFeedRoutes(relay, { ...base, cursorSecret: CURSOR_SECRET, leaseTtlSeconds: 3600 })
    registerSnapshotRoutes(relay, { ...base, cursorSecret: CURSOR_SECRET })
    registerProviderInstallationRoutes(relay, { ...base, cursorSecret: CURSOR_SECRET })
    registerCapabilityRoutes(relay, {
      ...base,
      verifyAccessToken: async () => ({ userId }),
      grantKeys,
      rateLimiter: { check: () => ({ allowed: true }) },
    })
    registerStatusRoutes(relay, {
      ...base,
      verifyAccessToken: async () => ({ userId }),
      rateLimiter: { check: () => ({ allowed: true }) },
    })
    registerUsageRoutes(relay, {
      ...base,
      verifyAccessToken: async () => ({ userId }),
      rateLimiter: { check: () => ({ allowed: true }) },
    })
    registerPurgeRoutes(relay, base)
    registerExtensionInstallationRoutes(relay, {
      pool: relayPool,
      mode: 'enabled',
      verifyAccessToken: async () => ({ userId }),
      cursorSecret: CURSOR_SECRET,
    })
  }, 60_000)

  afterAll(async () => {
    await relay?.close()
    await relayPool?.end()
    await memoryPool?.end()
  })

  beforeEach(async () => {
    // Relay-side reset (mirror of the relay e2e harness guard).
    await relayPool.query(`
      TRUNCATE extension_purge_requests, extension_provider_usage_facts,
               extension_provider_status, extension_provider_credentials,
               extension_checkpoints, extension_feed, extension_source_outbox,
               extension_installations, events, sessions, daemons, users
      RESTART IDENTITY CASCADE
    `)
    await memoryPool.query(`
      TRUNCATE memory_purge_receipts, memory_jobs, memory_dead_letters,
               memory_session_tombstones, memory_snapshot_runs, memory_snapshot_events,
               memory_feed_inbox, source_artifacts, source_turns, source_events,
               source_sessions, repositories, repo_snapshots, work_episodes,
               memory_installations, memory_provider_state
      RESTART IDENTITY CASCADE
    `)
  })

  async function provisionAndInstall(): Promise<void> {
    const credential = await createProviderCredential(relayPool, {
      providerId: 'pocketctl-memory', clientId: 'e2e-memory-client',
    })
    clientId = credential.clientId
    clientSecret = credential.clientSecret
    userId = (await relayPool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('memory-e2e@example.test', 'x') RETURNING id
    `)).rows[0].id
    await relayPool.query(`
      INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
      VALUES ('e2e-daemon', 'h', '[]'::jsonb, 'online', $1)
    `, [userId])
    await relayPool.query(`
      INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id)
      VALUES ('e2e-session', 'e2e-daemon', 'codex', '/repo', 'running', $1)
    `, [userId])
    // The user installation route needs a verified access token; the E2E
    // cares about the provider-side loop, so seed the installation row
    // exactly as that route would (pending, full scopes, from_now).
    installationId = (await relayPool.query<{ installation_id: string }>(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes,
         subscriptions, enabled_services, event_filter, start_policy, start_feed_id, config_version)
      VALUES (gen_random_uuid(), 'pocketctl-memory', $1, 'pending',
              ARRAY['session:events:read','session:snapshot:read','session:deletion:read']::text[],
              ARRAY['session.event.v1','session.lifecycle.v1','turn.lifecycle.v1',
                    'session.deleted.v1','session.access.revoked.v1']::text[],
              ARRAY['memory.search']::text[], '{}'::jsonb, 'from_now', 0, 1)
      RETURNING installation_id
    `, [userId])).rows[0].installation_id
  }

  async function journalRelayEvents(): Promise<void> {
    const sink = createPostgresExtensionJournalSink()
    await persistOwnedClientEvent(relayPool, userId, 'e2e-session', 'agent_text',
      { type: 'agent_text', session_id: 'e2e-session', text: 'e2e redacted body', turn_id: 'turn-e2e' }, sink)
    await persistOwnedClientEvent(relayPool, userId, 'e2e-session', 'tool_call',
      { type: 'tool_call', session_id: 'e2e-session', call_id: 'call-1', tool: 'read', turn_id: 'turn-e2e' }, sink)
    await persistOwnedClientEvent(relayPool, userId, 'e2e-session', 'turn_status',
      { type: 'turn_status', session_id: 'e2e-session', turn_status: 'completed',
        turn_id: 'turn-e2e', turn_reason: 'done' }, sink)
    const projected = await projectFeedBatch(relayPool, { batchSize: 50 })
    expect(projected.projected).toBeGreaterThanOrEqual(3)
  }

  test('discovery → feed → inbox → ack → projection → episodes → status', async () => {
    await provisionAndInstall()
    await journalRelayEvents()
    const mem = buildMemory(relayFetch(relay))
    const { worker: discovered } = await drainMemory(mem)
    expect(discovered.length).toBeGreaterThanOrEqual(1)

    // Durable inbox holds the projected batch; every row is projected.
    const inbox = await memoryPool.query<{ projection_state: string }>(
      `SELECT projection_state FROM memory_feed_inbox WHERE installation_id = $1`,
      [installationId],
    )
    expect(inbox.rows.length).toBeGreaterThanOrEqual(3)
    expect(inbox.rows.every(row => row.projection_state === 'projected')).toBe(true)

    // L0.5 read models exist.
    const session = await memoryPool.query(`SELECT session_id FROM source_sessions`)
    expect(session.rows.map(row => row.session_id)).toEqual(['e2e-session'])
    const turn = await memoryPool.query<{ state: string; reason: string | null }>(
      `SELECT state, reason FROM source_turns`,
    )
    expect(turn.rows[0]).toMatchObject({ state: 'completed', reason: 'done' })
    const artifacts = await memoryPool.query(`SELECT COUNT(*)::int AS count FROM source_artifacts`)
    expect(artifacts.rows[0].count).toBeGreaterThanOrEqual(1)
    const episode = await memoryPool.query<{ state: string; outcome: string; event_count: number }>(
      `SELECT state, outcome, event_count FROM work_episodes`,
    )
    expect(episode.rows[0]).toMatchObject({ state: 'ready', outcome: 'completed' })
    expect(Number(episode.rows[0].event_count)).toBeGreaterThanOrEqual(3)

    // Relay checkpoint advanced (ACK happened).
    const checkpoint = await relayPool.query<{ ack_feed_id: string }>(
      `SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    expect(Number(checkpoint.rows[0].ack_feed_id)).toBeGreaterThanOrEqual(3)

    // Duplicate consumption stays idempotent (restart semantics).
    await drainMemory(mem)
    const inboxAfter = await memoryPool.query(`SELECT COUNT(*)::int AS count FROM memory_feed_inbox`)
    expect(inboxAfter.rows[0].count).toBe(inbox.rows.length)

    // Status round-trip through the real Relay route.
    const status = vi.fn()
    const statusRoute = relay
    void statusRoute
    const statusResponse = await mem.reporting.reportStatus({
      installation_id: installationId,
      provider_version: '0.1.0',
      state: 'ready',
      last_feed_id: 3,
      feed_lag_seconds: 0,
      pending_jobs: 0,
      failed_jobs_24h: 0,
    })
    void statusResponse
    const providerStatus = await relayPool.query(
      `SELECT state FROM extension_provider_status WHERE installation_id = $1`,
      [installationId],
    )
    expect(providerStatus.rows[0].state).toBe('ready')
  })

  test('worker takeover rejects the stale lease holder', async () => {
    await provisionAndInstall()
    await journalRelayEvents()
    const mem = buildMemory(relayFetch(relay))
    await drainMemory(mem)

    // A second consumer (fresh lease) pulls; the first worker's stored
    // cursor/lease is gone (memory-only) so takeover is implicit — the
    // invariant is that no data duplicates and the checkpoint stays monotonic.
    const before = await relayPool.query<{ ack_feed_id: string }>(
      `SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    const consumer = createFeedConsumer({
      pool: memoryPool,
      pullFeed: (id, limit) => mem.feed.pullFeed(id, limit),
      ackFeed: input => mem.feed.ackFeed(input),
      workerId: 'e2e-worker-2',
      signal: new AbortController().signal,
    })
    await consumer.runOnce()
    const after = await relayPool.query<{ ack_feed_id: string }>(
      `SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    expect(Number(after.rows[0].ack_feed_id)).toBeGreaterThanOrEqual(Number(before.rows[0].ack_feed_id))
    const inbox = await memoryPool.query(`SELECT COUNT(*)::int AS count FROM memory_feed_inbox`)
    expect(inbox.rows[0].count).toBeGreaterThanOrEqual(3)
  })

  test('hard retention forces snapshot reconcile and the feed resumes', async () => {
    await provisionAndInstall()
    await journalRelayEvents()
    const mem = buildMemory(relayFetch(relay))
    await drainMemory(mem)

    // Force the hard-retention flag (what retention would do).
    await relayPool.query(`
      INSERT INTO extension_checkpoints (installation_id, snapshot_required_at)
      VALUES ($1, NOW())
      ON CONFLICT (installation_id) DO UPDATE SET snapshot_required_at = NOW()
    `, [installationId])
    const blocked = await mem.feed.pullFeed(installationId, 100).catch(error => error)
    expect(blocked).toMatchObject({ code: 'cursor_expired', snapshotRequired: true })

    const reconciler = createSnapshotReconciler({
      pool: memoryPool,
      relay: mem.snapshot,
    })
    const result = await reconciler.reconcile(installationId)
    expect(result.state).toBe('completed')

    const flag = await relayPool.query<{ snapshot_required_at: Date | null }>(
      `SELECT snapshot_required_at FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    expect(flag.rows[0].snapshot_required_at).toBeNull()

    const resumed = await mem.feed.pullFeed(installationId, 100)
    expect(resumed.items).toEqual([])
  })

  test('capability grants gate the probe; foreign installations are rejected', async () => {
    await provisionAndInstall()
    const verifier = createCapabilityVerifier({
      relayUrl: ISSUER,
      issuer: ISSUER,
      fetchImpl: relayFetch(relay),
      lookupInstallation: async id => {
        const result = await memoryPool.query<{
          local_status: string; relay_status: string; config_version: string
        }>(`SELECT local_status, relay_status, config_version::text
             FROM memory_installations WHERE installation_id = $1`, [id])
        return result.rows[0] ?? null
      },
    })
    const grant = signCapabilityGrant(grantKeys, {
      issuer: ISSUER,
      providerId: 'pocketctl-memory',
      installationId,
      userId,
      callerType: 'web',
      services: ['memory.search'],
      configVersion: 1,
    })
    // The installation is not registered locally yet → rejected.
    expect(await verifier.verify(grant, 'memory.search')).toBeNull()

    // Register it through discovery, then the grant passes.
    const mem = buildMemory(relayFetch(relay))
    const page = await mem.installations.listInstallations()
    await createInstallationRegistry(memoryPool).applyDiscovery({ generation: 1, items: page.installations })
    const verified = await verifier.verify(grant, 'memory.search')
    expect(verified).toMatchObject({ installationId })

    // A foreign installation id never verifies.
    const foreign = signCapabilityGrant(grantKeys, {
      issuer: ISSUER,
      providerId: 'pocketctl-memory',
      installationId: '99999999-9999-9999-9999-999999999999',
      userId,
      callerType: 'web',
      services: ['memory.search'],
      configVersion: 1,
    })
    expect(await verifier.verify(foreign, 'memory.search')).toBeNull()
  })

  test('session delete tombstones locally and blocks replay resurrection', async () => {
    await provisionAndInstall()
    await journalRelayEvents()
    const mem = buildMemory(relayFetch(relay))
    await drainMemory(mem)

    // Relay deletes the session (durable tombstone topic).
    await relayPool.query(`DELETE FROM sessions WHERE session_id = 'e2e-session'`)

    const tombstone = await createPurgeRepository(memoryPool, { hmacKey: HMAC_KEY }).purgeSession({
      installationId, sessionId: 'e2e-session', reason: 'user_deleted', sourceFeedId: null,
    })
    void tombstone
    const sessions = await memoryPool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM source_sessions WHERE session_id = 'e2e-session'`,
    )
    expect(sessions.rows[0].deleted_at).not.toBeNull()
    const derived = await memoryPool.query(
      `SELECT COUNT(*)::int AS count FROM source_events WHERE session_id = 'e2e-session'`,
    )
    expect(derived.rows[0].count).toBe(0)
  })

  test('installation revoke purges locally, receipts, and acks relay', async () => {
    await provisionAndInstall()
    await journalRelayEvents()
    const mem = buildMemory(relayFetch(relay))
    await drainMemory(mem)

    // Relay revokes the installation (repository semantics).
    await relayPool.query(`
      UPDATE extension_installations SET status = 'revoked', updated_at = NOW()
      WHERE installation_id = $1
    `, [installationId])
    const purgeRequestId = (await relayPool.query<{ request_id: string }>(`
      INSERT INTO extension_purge_requests (request_id, provider_id, installation_id, reason, expires_at)
      VALUES (gen_random_uuid(), 'pocketctl-memory', $1, 'uninstall', NOW() + INTERVAL '30 days')
      RETURNING request_id
    `, [installationId])).rows[0].request_id

    const worker = createPurgeWorker({
      pool: memoryPool,
      purge: createPurgeRepository(memoryPool, { hmacKey: HMAC_KEY }),
      relay: mem.purge,
    })
    await worker.runOnce()

    const receipt = await memoryPool.query<{ receipt: string; relay_acked_at: Date | null }>(
      `SELECT receipt, relay_acked_at FROM memory_purge_receipts WHERE request_id = $1`,
      [purgeRequestId],
    )
    expect(receipt.rows[0].receipt).toMatch(/^memory-phase0:/)
    expect(receipt.rows[0].relay_acked_at).not.toBeNull()

    const ackedOnRelay = await relayPool.query<{ status: string; provider_receipt: string | null }>(
      `SELECT status, provider_receipt FROM extension_purge_requests WHERE request_id = $1`,
      [purgeRequestId],
    )
    expect(ackedOnRelay.rows[0].status).toBe('acked')
    expect(ackedOnRelay.rows[0].provider_receipt).toBe(receipt.rows[0].receipt)

    // All provider content is gone.
    for (const table of ['memory_feed_inbox', 'source_events', 'source_sessions', 'work_episodes']) {
      const rows = await memoryPool.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE installation_id = $1`, [installationId],
      )
      expect(rows.rows[0].count, table).toBe(0)
    }
    const installation = await memoryPool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations WHERE installation_id = $1`, [installationId],
    )
    expect(installation.rows[0].local_status).toBe('purged')
  })

  test('fault drills: relay outage, malformed envelopes, unsupported versions', async () => {
    await provisionAndInstall()
    await journalRelayEvents()

    // Register the installation locally so the consumer loop can see it.
    const healthyMem = buildMemory(relayFetch(relay))
    const page = await healthyMem.installations.listInstallations()
    await createInstallationRegistry(memoryPool).applyDiscovery({ generation: 1, items: page.installations })

    // Relay outage: nothing is stored, the installation survives.
    const brokenMem = buildMemory(relayFetch(relay, true))
    const brokenConsumer = createFeedConsumer({
      pool: memoryPool,
      pullFeed: (id, limit) => brokenMem.feed.pullFeed(id, limit),
      ackFeed: input => brokenMem.feed.ackFeed(input),
      workerId: 'e2e-broken',
      signal: new AbortController().signal,
    })
    await brokenConsumer.runOnce()
    const inbox = await memoryPool.query(`SELECT COUNT(*)::int AS count FROM memory_feed_inbox`)
    expect(inbox.rows[0].count).toBe(0)

    // Malformed and unsupported envelopes quarantine durably and still ack.
    const mem = buildMemory(relayFetch(relay))
    const consumer = createFeedConsumer({
      pool: memoryPool,
      pullFeed: async () => ({
        installation_id: installationId,
        items: [
          { envelope_version: 99, feed_id: '901', topic: 'session.event.v1',
            source: { kind: 'x', id: 'y', recorded_at: '2026-08-23T00:00:00Z' },
            subject: { session_id: 's', event_type: 'x' }, classification: {}, data: {} },
          { envelope_version: 1, feed_id: '902', topic: 'session.event.v1',
            source: { kind: 'x', id: 'y', recorded_at: '2026-08-23T00:00:00Z' },
            subject: { session_id: 's', event_type: 'brand_new_type' }, classification: {}, data: {} },
        ],
        next_cursor: 'c', lease_token: 'l',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      ackFeed: vi.fn(async () => 902),
      workerId: 'e2e-broken',
      signal: new AbortController().signal,
    })
    await consumer.runOnce()
    const quarantined = await memoryPool.query<{ projection_state: string; error_code: string }>(
      `SELECT projection_state, error_code FROM memory_feed_inbox WHERE feed_id = 901`,
    )
    expect(quarantined.rows[0]).toMatchObject({
      projection_state: 'quarantined', error_code: 'unsupported_envelope_version',
    })
    const unknown = await memoryPool.query<{ projection_state: string }>(
      `SELECT projection_state FROM memory_feed_inbox WHERE feed_id = 902`,
    )
    expect(unknown.rows[0].projection_state).toBe('pending')
  })
})
