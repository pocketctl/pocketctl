import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import type { ExtensionScope, ExtensionTopic } from '../extensions/types.js'
import {
  canTransitionInstallation,
  ExtensionInstallationConflictError,
  ExtensionInstallationRepository,
} from '../extensions/installation-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('extension installations (PostgreSQL)', () => {
  let pool: pg.Pool
  let repository: ExtensionInstallationRepository
  let userId: number
  let otherUserId: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing PostgreSQL integration test against non-test database')
    }
    await initDB(pool)
    await upsertProviderDefinitions(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    await upsertProviderDefinitions(pool)
    userId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('install-a@example.test', 'x') RETURNING id
    `)).rows[0].id
    otherUserId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('install-b@example.test', 'x') RETURNING id
    `)).rows[0].id
    repository = new ExtensionInstallationRepository(pool)
  })

  function createInput(ownerUserId: number, overrides: Partial<Parameters<ExtensionInstallationRepository['createInstallation']>[0]> = {}) {
    return {
      ownerUserId,
      providerId: 'pocketctl-memory',
      grantedScopes: ['session:events:read', 'session:snapshot:read'] as ExtensionScope[],
      subscriptions: ['session.event.v1', 'turn.lifecycle.v1'] as ExtensionTopic[],
      enabledServices: ['memory.search', 'memory.recall'],
      eventFilter: { daemon_ids: ['daemon-1'] },
      startPolicy: 'from_now' as const,
      ...overrides,
    }
  }

  test('creates installations anchored at the current feed head', async () => {
    await pool.query(`
      INSERT INTO extension_feed (owner_user_id, topic, source_kind, source_id, payload)
      VALUES (1, 'session.event.v1', 'canonical_event', 'event:seed', '{}'::jsonb)
    `)
    const installation = await repository.createInstallation(createInput(userId))
    expect(installation.status).toBe('pending')
    expect(installation.start_feed_id).toBe(1)
    expect(installation.config_version).toBe(1)
    expect(installation.granted_scopes).toEqual(['session:events:read', 'session:snapshot:read'])
  })

  test('rejects a second installation for the same user and provider', async () => {
    await repository.createInstallation(createInput(userId))
    await expect(repository.createInstallation(createInput(userId)))
      .rejects.toBeInstanceOf(ExtensionInstallationConflictError)
    // A different user may still install.
    await expect(repository.createInstallation(createInput(otherUserId))).resolves.toBeDefined()
  })

  test('keeps a revoked installation as a fence while allowing a new installation id', async () => {
    const revoked = await repository.createInstallation(createInput(userId))
    await pool.query(`
      UPDATE extension_installations
      SET status = 'revoked', config_version = config_version + 1
      WHERE installation_id = $1
    `, [revoked.installation_id])

    const replacement = await repository.createInstallation(createInput(userId))
    expect(replacement.installation_id).not.toBe(revoked.installation_id)
    expect(replacement.status).toBe('pending')

    const rows = await pool.query<{ installation_id: string; status: string }>(`
      SELECT installation_id::text, status
      FROM extension_installations
      WHERE owner_user_id = $1 AND provider_id = 'pocketctl-memory'
      ORDER BY created_at
    `, [userId])
    expect(rows.rows).toEqual([
      { installation_id: revoked.installation_id, status: 'revoked' },
      { installation_id: replacement.installation_id, status: 'pending' },
    ])
  })

  test('optimistic locking increments config_version and rejects stale writes', async () => {
    const installation = await repository.createInstallation(createInput(userId))
    const updated = await repository.updateInstallation(
      userId, installation.installation_id, 1, { status: 'paused' },
    )
    expect(updated.status).toBe('paused')
    expect(updated.config_version).toBe(2)

    // The paused installation keeps its checkpoint row for resume.
    const checkpoint = await pool.query(
      `SELECT 1 FROM extension_installations WHERE installation_id = $1 AND status = 'paused'`,
      [installation.installation_id],
    )
    expect(checkpoint.rowCount).toBe(1)

    await expect(repository.updateInstallation(
      userId, installation.installation_id, 1, { status: 'active' },
    )).rejects.toMatchObject({ name: 'ExtensionInstallationVersionConflictError' })
  })

  test('cross-user access cannot see or mutate another owner installation', async () => {
    const installation = await repository.createInstallation(createInput(userId))
    expect(await repository.getInstallationForUser(otherUserId, installation.installation_id)).toBeNull()
    await expect(repository.updateInstallation(
      otherUserId, installation.installation_id, 1, { status: 'paused' },
    )).rejects.toMatchObject({ name: 'ExtensionInstallationNotFoundError' })
    await expect(repository.revokeInstallation(otherUserId, installation.installation_id))
      .rejects.toMatchObject({ name: 'ExtensionInstallationNotFoundError' })
  })

  test('revocation moves to revoking and records a purge request without deleting rows', async () => {
    const installation = await repository.createInstallation(createInput(userId))
    const result = await repository.revokeInstallation(userId, installation.installation_id)
    expect(result.installation.status).toBe('revoking')
    const row = await pool.query(
      `SELECT status FROM extension_installations WHERE installation_id = $1`,
      [installation.installation_id],
    )
    expect(row.rows[0].status).toBe('revoking')
    const purge = await pool.query(
      `SELECT reason, status FROM extension_purge_requests WHERE installation_id = $1`,
      [installation.installation_id],
    )
    expect(purge.rowCount).toBe(1)
    expect(purge.rows[0].reason).toBe('uninstall')
    expect(purge.rows[0].status).toBe('pending')
  })

  test('a manifest version bump never widens stored installation grants', async () => {
    const installation = await repository.createInstallation(createInput(userId))
    const before = installation.granted_scopes

    await pool.query(`
      UPDATE extension_providers
      SET manifest_version = 2,
          manifest = jsonb_set(manifest, '{requested_scopes}', '["session:events:read","session:snapshot:read","session:deletion:read","session:admin:all"]'::jsonb)
      WHERE provider_id = 'pocketctl-memory'
    `)
    const after = await repository.getInstallationForUser(userId, installation.installation_id)
    expect(after!.granted_scopes).toEqual(before)
  })

  test('the transition table rejects illegal jumps', () => {
    expect(canTransitionInstallation('pending', 'active')).toBe(true)
    expect(canTransitionInstallation('active', 'paused')).toBe(true)
    expect(canTransitionInstallation('paused', 'active')).toBe(true)
    expect(canTransitionInstallation('pending', 'revoked')).toBe(false)
    expect(canTransitionInstallation('revoked', 'active')).toBe(false)
    expect(canTransitionInstallation('revoking', 'revoked')).toBe(true)
  })
})
