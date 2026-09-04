import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { deleteUserAccount, initDB } from '../db.js'
import {
  assertExtensionSchema,
  initExtensionSchema,
} from '../extensions/schema.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension platform PostgreSQL schema', () => {
  let pool: pg.Pool

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

  test('creates the nine extension tables idempotently on a fresh database', async () => {
    await initExtensionSchema(pool)
    await initExtensionSchema(pool)

    const tables = await pool.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename LIKE 'extension_%'
      ORDER BY tablename
    `)
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'extension_checkpoints',
      'extension_feed',
      'extension_installations',
      'extension_organizations',
      'extension_provider_credentials',
      'extension_provider_status',
      'extension_provider_usage_facts',
      'extension_providers',
      'extension_purge_requests',
      'extension_scope_idempotency',
      'extension_scope_memberships',
      'extension_scope_outbox',
      'extension_source_outbox',
      'extension_teams',
    ])
  })

  test('enforces unique constraints rejected by the database', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)

    await pool.query(`
      INSERT INTO users (email, password_hash)
      VALUES ('extension-schema-owner@example.test', 'x')
    `)
    const user = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = 'extension-schema-owner@example.test'`,
    )
    const userId = user.rows[0].id
    await pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('extension-schema-provider', 1, '{}'::jsonb)
    `)
    await pool.query(`
      INSERT INTO extension_installations (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ('11111111-1111-1111-1111-111111111111', 'extension-schema-provider', $1, 'pending', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [userId])

    // Same owner + provider cannot install twice.
    await expect(pool.query(`
      INSERT INTO extension_installations (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ('22222222-2222-2222-2222-222222222222', 'extension-schema-provider', $1, 'pending', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [userId])).rejects.toThrow()

    // Source identity dedup.
    await pool.query(`
      INSERT INTO extension_source_outbox (source_kind, source_id, owner_user_id, event_type, payload)
      VALUES ('canonical_event', 'event:1', $1, 'agent_text', '{}'::jsonb)
    `, [userId])
    await expect(pool.query(`
      INSERT INTO extension_source_outbox (source_kind, source_id, owner_user_id, event_type, payload)
      VALUES ('canonical_event', 'event:1', $1, 'agent_text', '{}'::jsonb)
    `, [userId])).rejects.toThrow()

    // Feed identity dedup across topic + envelope version.
    await pool.query(`
      INSERT INTO extension_feed (owner_user_id, topic, source_kind, source_id, payload)
      VALUES ($1, 'session.event.v1', 'canonical_event', 'event:1', '{}'::jsonb)
    `, [userId])
    await expect(pool.query(`
      INSERT INTO extension_feed (owner_user_id, topic, source_kind, source_id, payload)
      VALUES ($1, 'session.event.v1', 'canonical_event', 'event:1', '{}'::jsonb)
    `, [userId])).rejects.toThrow()

    // Credential uniqueness per provider + client.
    await pool.query(`
      INSERT INTO extension_provider_credentials (credential_id, provider_id, client_id, secret_digest, secret_fingerprint)
      VALUES ('33333333-3333-3333-3333-333333333333', 'extension-schema-provider', 'client-a', 'digest', '0123456789abcdef')
    `)
    await expect(pool.query(`
      INSERT INTO extension_provider_credentials (credential_id, provider_id, client_id, secret_digest, secret_fingerprint)
      VALUES ('44444444-4444-4444-4444-444444444444', 'extension-schema-provider', 'client-a', 'digest', '0123456789abcdef')
    `)).rejects.toThrow()

    // Usage facts are idempotent per (installation, usage_id).
    await pool.query(`
      INSERT INTO extension_provider_usage_facts (installation_id, usage_id, operation, occurred_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'u-1', 'recall', NOW())
    `)
    await expect(pool.query(`
      INSERT INTO extension_provider_usage_facts (installation_id, usage_id, operation, occurred_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'u-1', 'recall', NOW())
    `)).rejects.toThrow()

    // Purge requests dedupe per (provider, installation, reason).
    await pool.query(`
      INSERT INTO extension_purge_requests (request_id, provider_id, installation_id, reason, expires_at)
      VALUES ('55555555-5555-5555-5555-555555555555', 'extension-schema-provider', '11111111-1111-1111-1111-111111111111', 'uninstall', NOW() + INTERVAL '30 days')
    `)
    await expect(pool.query(`
      INSERT INTO extension_purge_requests (request_id, provider_id, installation_id, reason, expires_at)
      VALUES ('66666666-6666-6666-6666-666666666666', 'extension-schema-provider', '11111111-1111-1111-1111-111111111111', 'uninstall', NOW() + INTERVAL '30 days')
    `)).rejects.toThrow()
  })

  test('check constraints reject out-of-allowlist values', async () => {
    await expect(pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('bad-trust', 1, '{}'::jsonb, 'third_party', 'enabled')
    `)).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('bad-version', 0, '{}'::jsonb)
    `)).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO extension_installations (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ('77777777-7777-7777-7777-777777777777', 'extension-schema-provider', 1, 'enabled', ARRAY['x'], ARRAY['y'], ARRAY['z'], 'from_now')
    `)).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO extension_provider_status (installation_id, provider_version, state)
      VALUES ('77777777-7777-7777-7777-777777777777', 'v1', 'offline')
    `)).rejects.toThrow()
    await expect(pool.query(`
      INSERT INTO extension_purge_requests (request_id, provider_id, installation_id, reason, expires_at)
      VALUES ('88888888-8888-8888-8888-888888888888', 'p', '11111111-1111-1111-1111-111111111111', 'because', NOW())
    `)).rejects.toThrow()
  })

  test('deleting an installation cascades checkpoints, status, and usage', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await pool.query(`
      INSERT INTO users (email, password_hash)
      VALUES ('extension-schema-cascade@example.test', 'x')
    `)
    const user = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = 'extension-schema-cascade@example.test'`,
    )
    await pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('extension-schema-provider', 1, '{}'::jsonb)
    `)
    await pool.query(`
      INSERT INTO extension_installations (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ('99999999-9999-9999-9999-999999999999', 'extension-schema-provider', $1, 'pending', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [user.rows[0].id])
    await pool.query(`
      INSERT INTO extension_checkpoints (installation_id) VALUES ('99999999-9999-9999-9999-999999999999')
    `)
    await pool.query(`
      DELETE FROM extension_installations WHERE installation_id = '99999999-9999-9999-9999-999999999999'
    `)
    const checkpoint = await pool.query(`
      SELECT 1 FROM extension_checkpoints WHERE installation_id = '99999999-9999-9999-9999-999999999999'
    `)
    expect(checkpoint.rowCount).toBe(0)
  })

  test('deleting the owning user leaves purge requests intact and detaches the installation', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await pool.query(`
      INSERT INTO users (email, password_hash)
      VALUES ('extension-schema-purge@example.test', 'x')
    `)
    const user = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = 'extension-schema-purge@example.test'`
    )
    const userId = user.rows[0].id
    await pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('extension-schema-provider', 1, '{}'::jsonb)
    `)
    await pool.query(`
      INSERT INTO extension_installations (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'extension-schema-provider', $1, 'active', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [userId])

    // ADR-0005: account deletion goes through the revoking transaction; the
    // personal installation is revoked and detached rather than cascaded away.
    expect(await deleteUserAccount(pool, userId)).toBe(true)

    const installation = await pool.query<{ status: string; owner_user_id: number | null }>(`
      SELECT status, owner_user_id FROM extension_installations
      WHERE installation_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    `)
    expect(installation.rowCount).toBe(1)
    expect(installation.rows[0].status).toBe('revoked')
    expect(installation.rows[0].owner_user_id).toBeNull()

    const purge = await pool.query(`
      SELECT status FROM extension_purge_requests
      WHERE installation_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        AND reason = 'account_deleted'
    `)
    expect(purge.rowCount).toBe(1)
    expect(purge.rows[0].status).toBe('pending')
  })

  test('assertExtensionSchema passes on an initialized database and fails on a dropped table', async () => {
    await assertExtensionSchema(pool)
    await pool.query(`DROP TABLE IF EXISTS extension_feed CASCADE`)
    await expect(assertExtensionSchema(pool)).rejects.toThrow('extension')
    await initExtensionSchema(pool)
    await assertExtensionSchema(pool)
  })
})
