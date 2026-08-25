import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import { registerStatusRoutes } from '../extensions/status-routes.js'
import { registerUsageRoutes } from '../extensions/usage-routes.js'
import { registerPurgeRoutes } from '../extensions/purge-routes.js'
import { ExtensionInstallationRepository } from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'

describeWithDatabase('extension control plane (PostgreSQL)', () => {
  let pool: pg.Pool
  let statusApp: FastifyInstance
  let usageApp: FastifyInstance
  let purgeApp: FastifyInstance
  let userId: number
  let otherUserId: number
  let installationId: string

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
    statusApp = Fastify()
    registerStatusRoutes(statusApp, {
      ...base,
      verifyAccessToken: async () => ({ userId }),
    })
    usageApp = Fastify()
    registerUsageRoutes(usageApp, {
      ...base,
      verifyAccessToken: async () => ({ userId }),
    })
    purgeApp = Fastify()
    registerPurgeRoutes(purgeApp, base)
  }, 30_000)

  afterAll(async () => {
    await statusApp?.close()
    await usageApp?.close()
    await purgeApp?.close()
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)
    userId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('cp-a@example.test', 'x') RETURNING id
    `)).rows[0].id
    otherUserId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('cp-b@example.test', 'x') RETURNING id
    `)).rows[0].id
    installationId = (await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: userId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'from_now',
    })).installation_id
  })

  function providerToken() {
    return signProviderExtensionToken({
      providerId: 'pocketctl-memory', credentialId: 'c', secret: PROVIDER_SECRET, issuer: ISSUER,
    })
  }

  test('status reports upsert and feed the user view', async () => {
    const report = await statusApp.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: {
        installation_id: installationId,
        state: 'syncing',
        provider_version: '1.0.0',
        last_feed_id: 12,
        feed_lag_seconds: 3,
      },
    })
    expect(report.statusCode).toBe(200)

    const view = await statusApp.inject({
      method: 'GET', url: '/api/extensions/v1/status',
      headers: { authorization: 'Bearer user' },
    })
    expect(view.statusCode).toBe(200)
    const installations = view.json().installations
    expect(installations.length).toBe(1)
    expect(installations[0].state).toBe('syncing')
    expect(Number(installations[0].last_feed_id)).toBe(12)

    // A revoked installation no longer accepts provider status.
    await pool.query(`UPDATE extension_installations SET status = 'revoked' WHERE installation_id = $1`, [installationId])
    const rejected = await statusApp.inject({
      method: 'POST', url: '/api/extensions/v1/status',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: installationId, state: 'ready', provider_version: '1' },
    })
    expect(rejected.statusCode).toBe(404)
  })

  test('usage facts are idempotent per (installation, usage_id)', async () => {
    const fact = {
      usage_id: 'u-1', operation: 'recall', model: 'm',
      input_tokens: 10, output_tokens: 5, embedding_tokens: 0, cached_tokens: 0,
      cost_micros: 42, occurred_at: new Date(Date.now() - 60_000).toISOString(),
    }
    const first = await usageApp.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: installationId, facts: [fact] },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().ingested).toBe(1)

    const duplicate = await usageApp.inject({
      method: 'POST', url: '/api/extensions/v1/usage/batch',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: installationId, facts: [fact] },
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().ingested).toBe(0)

    const stored = await pool.query(`SELECT COUNT(*)::int AS c FROM extension_provider_usage_facts`)
    expect(stored.rows[0].c).toBe(1)
    // Provider usage stays out of the agent token ledger.
    const agentLedger = await pool.query(`SELECT COUNT(*)::int AS c FROM token_usage_facts`)
    expect(agentLedger.rows[0].c).toBe(0)
  })

  test('purge queue serves a revoked installation and acks idempotently', async () => {
    await pool.query(
      `UPDATE extension_installations SET status = 'revoked' WHERE installation_id = $1`,
      [installationId],
    )
    const purge = await pool.query<{ request_id: string }>(`
      INSERT INTO extension_purge_requests (request_id, provider_id, installation_id, reason, expires_at)
      VALUES (gen_random_uuid(), 'pocketctl-memory', $1, 'uninstall', NOW() + INTERVAL '30 days')
      RETURNING request_id
    `, [installationId])

    const listed = await purgeApp.inject({
      method: 'GET', url: '/api/extensions/v1/purges',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().purges.length).toBe(1)

    const acked = await purgeApp.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${purge.rows[0].request_id}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { provider_receipt: 'sha256:deadbeef' },
    })
    expect(acked.statusCode).toBe(200)

    const again = await purgeApp.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${purge.rows[0].request_id}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(again.statusCode).toBe(200)

    const row = await pool.query<{ status: string; provider_receipt: string | null }>(
      `SELECT status, provider_receipt FROM extension_purge_requests WHERE request_id = $1`,
      [purge.rows[0].request_id],
    )
    expect(row.rows[0].status).toBe('acked')
    expect(row.rows[0].provider_receipt).toBe('sha256:deadbeef')
  })

  test('cross-user usage summaries never leak other owners', async () => {
    const otherInstallation = (await new ExtensionInstallationRepository(pool).createInstallation({
      ownerUserId: otherUserId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabledServices: ['memory.search'],
      eventFilter: {},
      startPolicy: 'from_now',
    })).installation_id
    await pool.query(`
      INSERT INTO extension_provider_usage_facts (installation_id, usage_id, operation, occurred_at)
      VALUES ($1, 'other-1', 'recall', NOW())
    `, [otherInstallation])
    await pool.query(`
      INSERT INTO extension_provider_usage_facts (installation_id, usage_id, operation, occurred_at)
      VALUES ($1, 'mine-1', 'embedding', NOW())
    `, [installationId])

    const summary = await usageApp.inject({
      method: 'GET', url: '/api/extensions/v1/usage',
      headers: { authorization: 'Bearer user' },
    })
    expect(summary.statusCode).toBe(200)
    const usage = summary.json().usage
    expect(usage.length).toBe(1)
    expect(usage[0].installation_id).toBe(installationId)
  })
})
