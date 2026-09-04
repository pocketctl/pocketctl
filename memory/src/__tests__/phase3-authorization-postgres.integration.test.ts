import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createScopeAuthorization, type V2GrantFacts } from '../governance/authorization.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const PRIMARY = 'aaaaaaaa-0000-4000-8000-000000000001'
const TEAM_INSTALL = 'aaaaaaaa-0000-4000-8000-000000000002'
const TEAM_INSTALL_2 = 'aaaaaaaa-0000-4000-8000-000000000003'
const TEAM_SCOPE = 'aaaaaaaa-0000-4000-8000-000000000011'
const MEMBERSHIP = 'aaaaaaaa-0000-4000-8000-000000000021'

describeWithDatabase('memory v2 scope authorization (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    if (!/test/i.test(database.rows[0]?.database_name ?? '')) {
      throw new Error('Refusing integration test against non-test database')
    }
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  async function seedSharedScope(input: {
    installationId: string
    scopeId: string
    membershipId?: string
    membershipState?: string
    membershipRevision?: number
    roles?: string[]
    scopeState?: string
    epoch?: number
  }): Promise<void> {
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 7,
              '[]'::jsonb, '[]'::jsonb, '["memory.search"]'::jsonb, '{}'::jsonb)
      ON CONFLICT (installation_id) DO NOTHING
    `, [input.installationId])
    await pool.query(`
      INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id, state, authorization_epoch)
      VALUES ($1, 'team', $2, $3, $4)
      ON CONFLICT (installation_id) DO UPDATE SET state = EXCLUDED.state,
        authorization_epoch = EXCLUDED.authorization_epoch
    `, [input.installationId, input.scopeId, input.scopeState ?? 'active', input.epoch ?? 5])
    if (input.membershipId) {
      await pool.query(`
        INSERT INTO memory_scope_memberships
          (installation_id, membership_id, roles, state, membership_revision)
        VALUES ($1, $2, $3::text[], $4, $5)
        ON CONFLICT (installation_id, membership_id) DO UPDATE SET
          roles = EXCLUDED.roles, state = EXCLUDED.state, membership_revision = EXCLUDED.membership_revision
      `, [
        input.installationId, input.membershipId, input.roles ?? ['reader', 'reviewer'],
        input.membershipState ?? 'active', input.membershipRevision ?? 2,
      ])
    }
  }

  async function seedPersonal(installationId: string): Promise<void> {
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 7,
              '[]'::jsonb, '[]'::jsonb, '["memory.search"]'::jsonb, '{}'::jsonb)
      ON CONFLICT (installation_id) DO NOTHING
    `, [installationId])
    await pool.query(`
      INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
      VALUES ($1, 'personal', $1)
      ON CONFLICT (installation_id) DO NOTHING
    `, [installationId])
  }

  function facts(overrides: Partial<V2GrantFacts> = {}): V2GrantFacts {
    return {
      primaryInstallationId: PRIMARY,
      configVersion: '7',
      scopeBindings: [
        {
          installation_id: PRIMARY,
          owner_scope_kind: 'personal',
          owner_scope_id: PRIMARY,
          membership_id: null,
          membership_revision: '0',
          authorization_epoch: '1',
          permissions: ['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin'],
        },
        {
          installation_id: TEAM_INSTALL,
          owner_scope_kind: 'team',
          owner_scope_id: TEAM_SCOPE,
          membership_id: MEMBERSHIP,
          membership_revision: '2',
          authorization_epoch: '5',
          permissions: ['read', 'review'],
        },
      ],
      ...overrides,
    }
  }

  test('validates bindings against the mirror and drops stale ones', async () => {
    await pool.query(`TRUNCATE memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes, memory_installations CASCADE`)
    await seedPersonal(PRIMARY)
    await seedSharedScope({ installationId: TEAM_INSTALL, scopeId: TEAM_SCOPE, membershipId: MEMBERSHIP })

    const authorization = createScopeAuthorization(pool)
    const validated = await authorization.validateV2Grant(facts())
    expect(validated).not.toBeNull()
    expect(validated!.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY, TEAM_INSTALL])

    // A stale mirror epoch drops the shared binding but keeps the grant.
    await pool.query(
      `UPDATE memory_owner_scopes SET authorization_epoch = 9 WHERE installation_id = $1`,
      [TEAM_INSTALL],
    )
    const stale = await authorization.validateV2Grant(facts())
    expect(stale!.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY])

    // A stale membership revision drops the binding too.
    await pool.query(`UPDATE memory_owner_scopes SET authorization_epoch = 5 WHERE installation_id = $1`, [TEAM_INSTALL])
    await pool.query(
      `UPDATE memory_scope_memberships SET membership_revision = 3 WHERE installation_id = $1`,
      [TEAM_INSTALL],
    )
    const staleRevision = await authorization.validateV2Grant(facts())
    expect(staleRevision!.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY])
  })

  test('suspended and tombstoned scopes never authorize', async () => {
    await pool.query(`TRUNCATE memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes, memory_installations CASCADE`)
    await seedPersonal(PRIMARY)
    await seedSharedScope({
      installationId: TEAM_INSTALL, scopeId: TEAM_SCOPE, membershipId: MEMBERSHIP, scopeState: 'suspended',
    })
    const authorization = createScopeAuthorization(pool)
    const suspended = await authorization.validateV2Grant(facts())
    expect(suspended!.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY])

    await pool.query(
      `UPDATE memory_owner_scopes SET state = 'active' WHERE installation_id = $1`, [TEAM_INSTALL])
    await pool.query(`
      INSERT INTO memory_scope_tombstones (owner_scope_kind, owner_scope_id, authorization_epoch, reason)
      VALUES ('team', $1, 5, 'dissolved')
      ON CONFLICT (owner_scope_kind, owner_scope_id) DO NOTHING
    `, [TEAM_SCOPE])
    const tombstoned = await authorization.validateV2Grant(facts())
    expect(tombstoned!.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY])
  })

  test('the primary binding must survive validation and config must match', async () => {
    await pool.query(`TRUNCATE memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes, memory_installations CASCADE`)
    await seedPersonal(PRIMARY)
    const authorization = createScopeAuthorization(pool)

    // Config drift on the primary rejects the whole grant.
    expect(await authorization.validateV2Grant(facts({ configVersion: '8' }))).toBeNull()

    // A dropped primary rejects the grant even when other bindings survive.
    await pool.query(`DELETE FROM memory_owner_scopes WHERE installation_id = $1`, [PRIMARY])
    await pool.query(`DELETE FROM memory_installations WHERE installation_id = $1`, [PRIMARY])
    await seedSharedScope({ installationId: TEAM_INSTALL, scopeId: TEAM_SCOPE, membershipId: MEMBERSHIP })
    expect(await authorization.validateV2Grant(facts())).toBeNull()
  })

  test('mutation helpers require an exact validated target binding', async () => {
    await pool.query(`TRUNCATE memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes, memory_installations CASCADE`)
    await seedPersonal(PRIMARY)
    await seedSharedScope({ installationId: TEAM_INSTALL, scopeId: TEAM_SCOPE, membershipId: MEMBERSHIP })
    await seedSharedScope({
      installationId: TEAM_INSTALL_2,
      scopeId: 'aaaaaaaa-0000-4000-8000-000000000012',
      membershipId: 'aaaaaaaa-0000-4000-8000-000000000022',
      roles: ['reader'],
    })
    const authorization = createScopeAuthorization(pool)
    const validated = (await authorization.validateV2Grant(facts({
      scopeBindings: [
        ...facts().scopeBindings,
        {
          installation_id: TEAM_INSTALL_2,
          owner_scope_kind: 'team',
          owner_scope_id: 'aaaaaaaa-0000-4000-8000-000000000012',
          membership_id: 'aaaaaaaa-0000-4000-8000-000000000022',
          membership_revision: '2',
          authorization_epoch: '5',
          permissions: ['read'],
        },
      ],
    })))!

    expect(authorization.hasPermission(validated, TEAM_INSTALL, 'review')).toBe(true)
    expect(authorization.hasPermission(validated, TEAM_INSTALL_2, 'review')).toBe(false)
    expect(authorization.hasPermission(validated, TEAM_INSTALL_2, 'read')).toBe(true)
    // An unknown installation has no binding at all.
    expect(authorization.hasPermission(validated, '99999999-9999-4999-8999-999999999999', 'read')).toBe(false)
    expect(() => authorization.requireTargetBinding(validated, TEAM_INSTALL_2, 'publish'))
      .toThrow(/permission/i)
    expect(() => authorization.requireTargetBinding(validated, '99999999-9999-4999-8999-999999999999', 'read'))
      .toThrow(/not found|binding/i)
  })
})
