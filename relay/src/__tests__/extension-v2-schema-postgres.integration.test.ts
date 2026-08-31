import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { deleteUserAccount, initDB } from '../db.js'
import { initExtensionSchema } from '../extensions/schema.js'
import {
  addScopeMembership,
  createOrganization,
  createTeam,
  getSharedScope,
  MembershipRevisionConflictError,
  updateScopeMembership,
} from '../extensions/scope-repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PROVIDER = 'extension-v2-schema-provider'
const ORG_ID = 'c0000000-0000-4000-8000-000000000001'
const TEAM_ID = 'c0000000-0000-4000-8000-000000000002'
const TEAM_2_ID = 'c0000000-0000-4000-8000-000000000003'
const SHARED_INSTALL = 'c0000000-0000-4000-8000-000000000011'
const SHARED_INSTALL_2 = 'c0000000-0000-4000-8000-000000000012'
const SHARED_INSTALL_3 = 'c0000000-0000-4000-8000-000000000013'
const PERSONAL_INSTALL = 'c0000000-0000-4000-8000-000000000021'

async function insertUser(
  pool: pg.Pool,
  email: string,
): Promise<number> {
  await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x')
     ON CONFLICT (email) DO UPDATE SET password_hash = 'x'`,
    [email],
  )
  const row = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email])
  return row.rows[0].id
}

async function ensureProvider(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO extension_providers (provider_id, manifest_version, manifest)
     VALUES ($1, 1, '{}'::jsonb)
     ON CONFLICT (provider_id) DO NOTHING`,
    [PROVIDER],
  )
}

describeWithDatabase('extension v2 owner-scope PostgreSQL schema', () => {
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

  test('migrates a Phase 2 (v1) installation to a personal owner scope idempotently', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    const userId = await insertUser(pool, 'v2-migration-owner@example.test')
    await ensureProvider(pool)
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, $3, 'active', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [PERSONAL_INSTALL, PROVIDER, userId])
    // Simulate the pre-migration shape: drop the Phase 3 guard rails and
    // blank the scope identity, as a Phase 2 database would hold it.
    await pool.query(
      `ALTER TABLE extension_installations DROP CONSTRAINT IF EXISTS extension_installations_owner_scope_identity_check`,
    )
    await pool.query(
      `ALTER TABLE extension_installations DISABLE TRIGGER trg_extension_installations_owner_scope`,
    )
    await pool.query(
      `UPDATE extension_installations SET owner_scope_id = NULL WHERE installation_id = $1`,
      [PERSONAL_INSTALL],
    )
    await pool.query(
      `ALTER TABLE extension_installations ENABLE TRIGGER trg_extension_installations_owner_scope`,
    )

    await initExtensionSchema(pool)
    await initExtensionSchema(pool)

    const row = await pool.query<{
      owner_scope_kind: string
      owner_scope_id: string
      authorization_epoch: string
    }>(
      `SELECT owner_scope_kind, owner_scope_id, authorization_epoch
       FROM extension_installations WHERE installation_id = $1`,
      [PERSONAL_INSTALL],
    )
    expect(row.rowCount).toBe(1)
    expect(row.rows[0].owner_scope_kind).toBe('personal')
    expect(row.rows[0].owner_scope_id).toBe(PERSONAL_INSTALL)
    expect(Number(row.rows[0].authorization_epoch)).toBe(1)
  })

  test('enforces the personal/shared owner identity check', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    const userId = await insertUser(pool, 'v2-owner-check@example.test')
    await ensureProvider(pool)
    await pool.query(`
      INSERT INTO extension_organizations (organization_id, name, created_by_user_id)
      VALUES ($1, 'owner-check-org', $2)
    `, [ORG_ID, userId])

    // Live personal installation without an owner is rejected.
    await expect(pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, NULL, 'personal', $1, 'pending', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'from_now')
    `, [PERSONAL_INSTALL, PROVIDER])).rejects.toThrow()

    // Shared installation with a user owner is rejected.
    await expect(pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, $3, 'organization', $4, 'pending', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'from_now')
    `, [SHARED_INSTALL, PROVIDER, userId, ORG_ID])).rejects.toThrow()

    // Shared installation without a user owner is accepted.
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, NULL, 'organization', $3, 'pending', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'from_now')
    `, [SHARED_INSTALL, PROVIDER, ORG_ID])

    // Revoked personal installation survives account deletion with a detached owner.
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, NULL, 'personal', $1, 'revoked', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'from_now')
    `, [PERSONAL_INSTALL, PROVIDER])
  })

  test('enforces one live installation per provider and owner scope', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    const userId = await insertUser(pool, 'v2-scope-unique@example.test')
    await ensureProvider(pool)
    await pool.query(`
      INSERT INTO extension_organizations (organization_id, name, created_by_user_id)
      VALUES ($1, 'unique-org', $2)
    `, [ORG_ID, userId])
    await pool.query(`
      INSERT INTO extension_teams (team_id, organization_id, name, created_by_user_id)
      VALUES ($1, $2, 'unique-team', $3)
    `, [TEAM_ID, ORG_ID, userId])

    const insertShared = (installationId: string, scopeId: string, status: string) =>
      pool.query(`
        INSERT INTO extension_installations
          (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
        VALUES ($1, $2, NULL, 'team', $3, $4, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'from_now')
      `, [installationId, PROVIDER, scopeId, status])

    await insertShared(SHARED_INSTALL, TEAM_ID, 'pending')
    await expect(insertShared(SHARED_INSTALL_2, TEAM_ID, 'active')).rejects.toThrow()
    // A different owner scope is unaffected.
    await insertShared(SHARED_INSTALL_2, TEAM_2_ID, 'active')
    // Once the first installation is terminal, the scope slot frees up.
    await pool.query(
      `UPDATE extension_installations SET status = 'revoked' WHERE installation_id = $1`,
      [SHARED_INSTALL],
    )
    await insertShared(SHARED_INSTALL_3, TEAM_ID, 'active')
  })

  test('enforces team hierarchy, membership allowlists, and duplicate membership rejection', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    const userId = await insertUser(pool, 'v2-membership@example.test')
    await ensureProvider(pool)
    await pool.query(`
      INSERT INTO extension_organizations (organization_id, name, created_by_user_id)
      VALUES ($1, 'membership-org', $2)
    `, [ORG_ID, userId])

    // Team must reference an existing Organization.
    await expect(pool.query(`
      INSERT INTO extension_teams (team_id, organization_id, name)
      VALUES ($1, 'c0000000-0000-4000-8000-000000009999', 'orphan-team')
    `, [TEAM_ID])).rejects.toThrow()

    // Membership role allowlist rejects unknown roles.
    await expect(pool.query(`
      INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
      VALUES ($1, 'organization', $2, $3, ARRAY['warlord'])
    `, [SHARED_INSTALL, ORG_ID, userId])).rejects.toThrow()

    // Membership scope kind allowlist rejects personal scopes.
    await expect(pool.query(`
      INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
      VALUES ($1, 'personal', $2, $3, ARRAY['reader'])
    `, [SHARED_INSTALL, ORG_ID, userId])).rejects.toThrow()

    await pool.query(`
      INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
      VALUES ($1, 'organization', $2, $3, ARRAY['reader', 'reviewer'])
    `, [SHARED_INSTALL, ORG_ID, userId])

    // One live membership per (scope, user): a second insert collides.
    await expect(pool.query(`
      INSERT INTO extension_scope_memberships (membership_id, scope_kind, scope_id, user_id, roles)
      VALUES ($1, 'organization', $2, $3, ARRAY['reader'])
    `, [SHARED_INSTALL_2, ORG_ID, userId])).rejects.toThrow()
  })

  test('membership mutations bump membership revision and scope epoch atomically', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    const userId = await insertUser(pool, 'v2-revision@example.test')
    await ensureProvider(pool)

    const org = await createOrganization(pool, {
      organizationId: ORG_ID,
      name: 'revision-org',
      createdByUserId: userId,
    })
    expect(org.state).toBe('active')
    expect(Number(org.authorization_epoch)).toBe(1)
    expect(Number(org.revision)).toBe(1)

    const membership = await addScopeMembership(pool, {
      scopeKind: 'organization',
      scopeId: ORG_ID,
      userId,
      roles: ['reader'],
    })
    expect(membership.state).toBe('active')
    expect(Number(membership.membership_revision)).toBe(1)

    let scope = (await getSharedScope(pool, 'organization', ORG_ID))!
    expect(Number(scope.authorization_epoch)).toBe(2)
    expect(Number(scope.revision)).toBe(2)

    const updated = await updateScopeMembership(pool, {
      membershipId: membership.membership_id,
      expectedRevision: 1,
      roles: ['reviewer'],
    })
    expect(updated.roles).toEqual(['reviewer'])
    expect(Number(updated.membership_revision)).toBe(2)
    scope = (await getSharedScope(pool, 'organization', ORG_ID))!
    expect(Number(scope.authorization_epoch)).toBe(3)
    expect(Number(scope.revision)).toBe(3)

    // Stale CAS revision fails closed without touching state.
    await expect(updateScopeMembership(pool, {
      membershipId: membership.membership_id,
      expectedRevision: 1,
      roles: ['publisher'],
    })).rejects.toBeInstanceOf(MembershipRevisionConflictError)
    scope = (await getSharedScope(pool, 'organization', ORG_ID))!
    expect(Number(scope.authorization_epoch)).toBe(3)

    // Revocation sets revoked_at and advances both fences again.
    const revoked = await updateScopeMembership(pool, {
      membershipId: membership.membership_id,
      expectedRevision: 2,
      state: 'revoked',
    })
    expect(revoked.state).toBe('revoked')
    expect(revoked.revoked_at).not.toBeNull()
    scope = (await getSharedScope(pool, 'organization', ORG_ID))!
    expect(Number(scope.authorization_epoch)).toBe(4)

    const team = await createTeam(pool, {
      teamId: TEAM_ID,
      organizationId: ORG_ID,
      name: 'revision-team',
      createdByUserId: userId,
    })
    expect(Number(team.authorization_epoch)).toBe(1)
    // A team scope lookup by organization id stays empty: kinds never alias.
    expect(await getSharedScope(pool, 'team', ORG_ID)).toBeNull()
  })

  test('account deletion revokes personal installations and memberships but keeps shared scopes', async () => {
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    const ownerId = await insertUser(pool, 'v2-account-delete@example.test')
    const adminId = await insertUser(pool, 'v2-account-admin@example.test')
    await ensureProvider(pool)

    const org = await createOrganization(pool, {
      organizationId: ORG_ID,
      name: 'account-delete-org',
      createdByUserId: adminId,
    })
    const beforeEpoch = Number(org.authorization_epoch)
    const membership = await addScopeMembership(pool, {
      scopeKind: 'organization',
      scopeId: ORG_ID,
      userId: ownerId,
      roles: ['contributor'],
    })

    // Personal installation for the deleted account.
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, $3, 'active', ARRAY['session:events:read'], ARRAY['session.event.v1'], ARRAY['memory.search'], 'from_now')
    `, [PERSONAL_INSTALL, PROVIDER, ownerId])
    // Shared installation for the organization (audit-only creator).
    await pool.query(`
      INSERT INTO extension_installations
        (installation_id, provider_id, owner_user_id, owner_scope_kind, owner_scope_id, created_by_user_id, status, granted_scopes, subscriptions, enabled_services, start_policy)
      VALUES ($1, $2, NULL, 'organization', $3, $4, 'active', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 'from_now')
    `, [SHARED_INSTALL, PROVIDER, ORG_ID, ownerId])

    expect(await deleteUserAccount(pool, ownerId)).toBe(true)

    // Personal installation is revoked and detached, not deleted.
    const personal = await pool.query<{
      status: string
      owner_user_id: number | null
    }>(
      `SELECT status, owner_user_id FROM extension_installations WHERE installation_id = $1`,
      [PERSONAL_INSTALL],
    )
    expect(personal.rowCount).toBe(1)
    expect(personal.rows[0].status).toBe('revoked')
    expect(personal.rows[0].owner_user_id).toBeNull()

    // Shared installation survives untouched except the audit creator FK.
    const shared = await pool.query<{
      status: string
      owner_scope_id: string
      created_by_user_id: number | null
    }>(
      `SELECT status, owner_scope_id, created_by_user_id FROM extension_installations WHERE installation_id = $1`,
      [SHARED_INSTALL],
    )
    expect(shared.rowCount).toBe(1)
    expect(shared.rows[0].status).toBe('active')
    expect(shared.rows[0].owner_scope_id).toBe(ORG_ID)
    expect(shared.rows[0].created_by_user_id).toBeNull()

    // Organization scope survives with an advanced authorization epoch.
    const scopeAfter = (await getSharedScope(pool, 'organization', ORG_ID))!
    expect(Number(scopeAfter.authorization_epoch)).toBeGreaterThan(beforeEpoch)

    // Membership row survives revocation with the opaque identity intact.
    const membershipAfter = await pool.query<{
      state: string
      user_id: number | null
      revoked_at: Date | null
    }>(
      `SELECT state, user_id, revoked_at FROM extension_scope_memberships WHERE membership_id = $1`,
      [membership.membership_id],
    )
    expect(membershipAfter.rowCount).toBe(1)
    expect(membershipAfter.rows[0].state).toBe('revoked')
    expect(membershipAfter.rows[0].user_id).toBeNull()
    expect(membershipAfter.rows[0].revoked_at).not.toBeNull()

    // Provider purge evidence survives the account.
    const purge = await pool.query(
      `SELECT 1 FROM extension_purge_requests WHERE installation_id = $1 AND reason = 'account_deleted'`,
      [PERSONAL_INSTALL],
    )
    expect(purge.rowCount).toBe(1)
  })
})
