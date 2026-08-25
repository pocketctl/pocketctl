import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'
import {
  createProviderCredential,
  signProviderExtensionToken,
} from '../extensions/provider-auth.js'
import { registerFeedRoutes } from '../extensions/feed-routes.js'
import { registerProviderInstallationRoutes } from '../extensions/provider-installation-routes.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER_SECRET = 'provider-installation-secret-0123456789'
const CURSOR_SECRET = 'provider-installation-cursor-0123456789'
const ISSUER = 'https://relay.example.test'
const OTHER_PROVIDER = 'other-provider'

/**
 * Relay Pre-Task R0 integration gate: the provider installation inventory and
 * the snapshot reconcile completion ACK, on a real schema with two providers
 * and every installation status. The reconcile loop closes against the feed:
 * hard-retention 410 → reconciled ACK → pull resumes.
 */
describeWithDatabase('extension provider installation routes (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: FastifyInstance

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
    registerFeedRoutes(app, { ...base, cursorSecret: CURSOR_SECRET, leaseTtlSeconds: 3600 })
    registerProviderInstallationRoutes(app, { ...base, cursorSecret: CURSOR_SECRET })
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  afterEach(async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
  })

  function tokenFor(providerId: string): string {
    return signProviderExtensionToken({
      providerId, credentialId: 'cred-1', secret: PROVIDER_SECRET, issuer: ISSUER,
    })
  }

  async function insertUser(email: string): Promise<number> {
    return (await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [email],
    )).rows[0].id
  }

  async function insertInstallation(input: {
    ownerUserId: number
    providerId: string
    status: string
  }): Promise<string> {
    return (await pool.query<{ installation_id: string }>(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes,
         subscriptions, enabled_services, event_filter, start_policy, start_feed_id, config_version)
      VALUES (gen_random_uuid(), $1, $2, $3,
              ARRAY['session:events:read']::text[], ARRAY['session.event.v1']::text[],
              ARRAY['memory.search']::text[], '{}'::jsonb, 'from_now', 0, 1)
      RETURNING installation_id
    `, [input.providerId, input.ownerUserId, input.status])).rows[0].installation_id
  }

  async function setSnapshotRequired(installationId: string): Promise<void> {
    await pool.query(
      `INSERT INTO extension_checkpoints (installation_id, snapshot_required_at)
       VALUES ($1, NOW())
       ON CONFLICT (installation_id) DO UPDATE SET snapshot_required_at = NOW()`,
      [installationId],
    )
  }

  async function snapshotRequiredAt(installationId: string): Promise<Date | null> {
    const result = await pool.query<{ snapshot_required_at: Date | null }>(
      `SELECT snapshot_required_at FROM extension_checkpoints WHERE installation_id = $1`,
      [installationId],
    )
    return result.rows[0]?.snapshot_required_at ?? null
  }

  test('inventories only the calling provider across pages and statuses', async () => {
    await upsertProviderDefinitions(pool)
    await pool.query(
      `INSERT INTO extension_providers (provider_id, manifest_version, manifest)
       VALUES ('${OTHER_PROVIDER}', 1, '{}'::jsonb)`,
    )

    const ownerA = await insertUser('inventory-a@example.test')
    const ownerB = await insertUser('inventory-b@example.test')
    const mine = [
      await insertInstallation({ ownerUserId: ownerA, providerId: 'pocketctl-memory', status: 'pending' }),
      await insertInstallation({ ownerUserId: ownerB, providerId: 'pocketctl-memory', status: 'active' }),
      await insertInstallation({ ownerUserId: ownerB, providerId: OTHER_PROVIDER, status: 'paused' }),
      await insertInstallation({ ownerUserId: ownerA, providerId: OTHER_PROVIDER, status: 'revoked' }),
    ]
    await setSnapshotRequired(mine[1])

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const url: string = cursor
        ? `/api/extensions/v1/provider/installations?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '/api/extensions/v1/provider/installations?limit=1'
      const response = await app.inject({
        method: 'GET', url,
        headers: { authorization: `Bearer ${tokenFor('pocketctl-memory')}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        installations: Array<{ installation_id: string }>
        next_cursor: string | null
        has_more: boolean
      }
      for (const item of body.installations) {
        seen.push(item.installation_id)
        expect(Object.keys(item).sort()).toEqual([
          'config_version', 'created_at', 'enabled_services', 'event_filter',
          'granted_scopes', 'installation_id', 'snapshot_required', 'status',
          'subscriptions', 'updated_at',
        ])
      }
      expect(body.has_more).toBe(Boolean(body.next_cursor))
      cursor = body.next_cursor
      if (!cursor) break
    }

    // Pagination walks the provider's installations in UUID order; the
    // foreign provider's installations never appear.
    expect([...seen].sort()).toEqual([mine[0], mine[1]].sort())
    const flagged = await app.inject({
      method: 'GET', url: '/api/extensions/v1/provider/installations',
      headers: { authorization: `Bearer ${tokenFor('pocketctl-memory')}` },
    })
    const flaggedItem = (flagged.json().installations as Array<{ installation_id: string; snapshot_required: boolean }>)
      .find(item => item.installation_id === mine[1])
    expect(flaggedItem?.snapshot_required).toBe(true)
  })

  test('reconciled ack clears hard retention and the feed pull resumes', async () => {
    await upsertProviderDefinitions(pool)
    const credential = await createProviderCredential(pool, {
      providerId: 'pocketctl-memory', clientId: 'reconcile-client',
    })
    const ownerId = await insertUser('reconcile@example.test')
    const installationId = await insertInstallation({
      ownerUserId: ownerId, providerId: 'pocketctl-memory', status: 'active',
    })
    await setSnapshotRequired(installationId)
    expect(await snapshotRequiredAt(installationId)).not.toBeNull()

    const token = tokenFor('pocketctl-memory')
    const blocked = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(blocked.statusCode).toBe(410)
    expect(blocked.json().error.code).toBe('cursor_expired')
    expect(blocked.json().error.snapshot_required).toBe(true)

    const acked = await app.inject({
      method: 'POST',
      url: `/api/extensions/v1/provider/installations/${installationId}/reconciled`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(acked.statusCode).toBe(200)
    expect(acked.json()).toEqual({ installation_id: installationId, reconciled: true })
    expect(await snapshotRequiredAt(installationId)).toBeNull()

    const resumed = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${installationId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json().items).toEqual([])
    expect(resumed.json().snapshot_required).toBeUndefined()

    // A repeated completion ACK stays idempotent.
    const again = await app.inject({
      method: 'POST',
      url: `/api/extensions/v1/provider/installations/${installationId}/reconciled`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(again.statusCode).toBe(200)

    // Credential provisioned above must remain unused-but-valid shape.
    expect(credential.clientId).toBe('reconcile-client')
  })

  test('providers cannot reconcile across providers and revoked installations stay blocked', async () => {
    await upsertProviderDefinitions(pool)
    await pool.query(
      `INSERT INTO extension_providers (provider_id, manifest_version, manifest)
       VALUES ('${OTHER_PROVIDER}', 1, '{}'::jsonb)`,
    )
    const ownerId = await insertUser('isolation@example.test')
    const otherOwner = await insertUser('isolation-other@example.test')
    const activeId = await insertInstallation({
      ownerUserId: ownerId, providerId: 'pocketctl-memory', status: 'active',
    })
    const revokingId = await insertInstallation({
      ownerUserId: otherOwner, providerId: 'pocketctl-memory', status: 'revoking',
    })
    await setSnapshotRequired(activeId)
    await setSnapshotRequired(revokingId)

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/extensions/v1/provider/installations/${activeId}/reconciled`,
      headers: { authorization: `Bearer ${tokenFor(OTHER_PROVIDER)}` },
    })
    expect(foreign.statusCode).toBe(404)
    expect(await snapshotRequiredAt(activeId)).not.toBeNull()

    const revoking = await app.inject({
      method: 'POST',
      url: `/api/extensions/v1/provider/installations/${revokingId}/reconciled`,
      headers: { authorization: `Bearer ${tokenFor('pocketctl-memory')}` },
    })
    expect(revoking.statusCode).toBe(403)
    expect(revoking.json().error.code).toBe('installation_revoked')
    expect(await snapshotRequiredAt(revokingId)).not.toBeNull()
  })
})
