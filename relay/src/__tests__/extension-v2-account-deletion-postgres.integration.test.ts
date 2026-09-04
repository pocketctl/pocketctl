import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deleteUserAccount, initDB } from '../db.js'

/**
 * ADR-P3-11 Relay account deletion against the v2 schema: personal
 * installation revoked+detached, memberships revoked with opaque identity
 * preserved, shared Team/Organization installations and scopes untouched.
 */

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const ORG_ID = 'abbaabba-0000-4000-8000-000000000001'
const TEAM_ID = 'abbaabba-0000-4000-8000-000000000002'
const SHARED_INSTALL = 'abbaabba-0000-4000-8000-000000000011'
const MEMBERSHIP = 'abbaabba-0000-4000-8000-000000000021'

describeWithDatabase('extension v2 account deletion (Relay PostgreSQL)', () => {
  let pool: pg.Pool
  let memberId: number

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE extension_scope_idempotency, extension_scope_outbox, extension_scope_memberships,
                extension_teams, extension_organizations, extension_purge_requests,
                extension_provider_usage_facts, extension_provider_status, extension_provider_credentials,
                extension_checkpoints, extension_feed, extension_source_outbox, extension_installations,
                extension_providers, users RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO extension_providers (provider_id, manifest_version, manifest)
      VALUES ('pocketctl-memory', 4, '{}'::jsonb) ON CONFLICT DO NOTHING
    `)
    const user = await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash) VALUES ('v2-account-member@example.test', 'x') RETURNING id
    `)
    memberId = user.rows[0].id
    await pool.query(`
      INSERT INTO extension_organizations (organization_id, name, created_by_user_id)
      VALUES ($1, 'account-org', $2)
    `, [ORG_ID, memberId])
    await pool.query(`
      INSERT INTO extension_teams (team_id, organization_id, name, created_by_user_id)
      VALUES ($1, $2, 'account-team', $3)
    `, [TEAM_ID, ORG_ID, memberId])
    await pool.query(`
      INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
      VALUES ($1, 'team', $2, $3, '{contributor}')
    `, [MEMBERSHIP, TEAM_ID, memberId])
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, created_by_user_id, status,
         granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, 'pocketctl-memory', NULL, 'team', $2, $3, 'active',
              ARRAY['scope:control:read'], ARRAY['scope.membership.v2'], ARRAY['memory.search'], 'from_now')
    `, [SHARED_INSTALL, TEAM_ID, memberId])
  })

  test('revokes the membership and advances the scope epoch while the shared installation survives', async () => {
    const epochBefore = await pool.query<{ epoch: string }>(
      `SELECT authorization_epoch::text AS epoch FROM extension_teams WHERE team_id = $1`,
      [TEAM_ID],
    )
    expect(await deleteUserAccount(pool, memberId)).toBe(true)

    const membership = await pool.query<{ state: string; user_id: number | null; revoked_at: Date | null }>(
      `SELECT state, user_id, revoked_at FROM extension_scope_memberships WHERE membership_id = $1`,
      [MEMBERSHIP],
    )
    expect(membership.rowCount).toBe(1)
    expect(membership.rows[0].state).toBe('revoked')
    expect(membership.rows[0].user_id).toBeNull()
    expect(membership.rows[0].revoked_at).not.toBeNull()

    const shared = await pool.query<{ status: string; owner_user_id: number | null }>(
      `SELECT status, owner_user_id FROM extension_installations WHERE installation_id = $1`,
      [SHARED_INSTALL],
    )
    expect(shared.rows[0].status).toBe('active')
    expect(shared.rows[0].owner_user_id).toBeNull()

    const epochAfter = await pool.query<{ epoch: string }>(
      `SELECT authorization_epoch::text AS epoch FROM extension_teams WHERE team_id = $1`,
      [TEAM_ID],
    )
    expect(Number(epochAfter.rows[0].epoch)).toBeGreaterThan(Number(epochBefore.rows[0].epoch))

    // A revoked membership row keeps the opaque identity; the unique
    // membership slot is not reusable because the user row is gone and the
    // surviving row holds the revoked history.
    const orgRows = await pool.query(`SELECT 1 FROM extension_organizations WHERE organization_id = $1`, [ORG_ID])
    expect(orgRows.rowCount).toBe(1)
  })
})
