import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('memory phase3 mirror schema (migration 19)', () => {
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

  test('appends migration 19 without renumbering migrations 1-18', () => {
    const versions = MEMORY_MIGRATIONS.map(migration => migration.version)
    expect(versions.slice(0, 19)).toHaveLength(19)
    expect(versions.slice(0, 18)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1))
  })

  test('creates the mirror tables idempotently and backfills personal scopes', async () => {
    await applyMemorySchema(pool)

    const tables = await pool.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN ('memory_owner_scopes', 'memory_scope_memberships', 'memory_scope_tombstones')
      ORDER BY tablename
    `)
    expect(tables.rows.map(row => row.tablename)).toEqual([
      'memory_owner_scopes', 'memory_scope_memberships', 'memory_scope_tombstones',
    ])

    // A pre-migration installation backfills as a personal scope row when
    // migration 19 (re)applies after being rolled back.
    const installation = await pool.query<{ installation_id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text
    `)
    await pool.query(`DROP TABLE IF EXISTS memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes CASCADE`)
    await pool.query(`DELETE FROM memory_schema_migrations WHERE version = 19`)
    await applyMemorySchema(pool)

    const scope = await pool.query<{
      owner_scope_kind: string
      owner_scope_id: string
      authorization_epoch: string
    }>(`
      SELECT owner_scope_kind, owner_scope_id::text, authorization_epoch::text
      FROM memory_owner_scopes WHERE installation_id = $1
    `, [installation.rows[0].installation_id])
    expect(scope.rowCount).toBe(1)
    expect(scope.rows[0].owner_scope_kind).toBe('personal')
    expect(scope.rows[0].owner_scope_id).toBe(installation.rows[0].installation_id)
    expect(Number(scope.rows[0].authorization_epoch)).toBe(1)
  })

  test('enforces one mirror row per shared scope and membership allowlists', async () => {
    const first = await pool.query<{ id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text AS id
    `)
    await pool.query(`
      INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id, authorization_epoch)
      VALUES ($1, 'team', gen_random_uuid(), 3)
    `, [first.rows[0].id])
    // A second installation for the same shared scope is rejected.
    const second = await pool.query<{ id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
              '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text AS id
    `)
    const scopeId = await pool.query<{ owner_scope_id: string }>(
      `SELECT owner_scope_id::text FROM memory_owner_scopes WHERE installation_id = $1`,
      [first.rows[0].id],
    )
    await expect(pool.query(`
      INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
      VALUES ($1, 'team', $2)
    `, [second.rows[0].id, scopeId.rows[0].owner_scope_id])).rejects.toThrow()

    // Membership scope-kind allowlist rejects personal scopes.
    await expect(pool.query(`
      INSERT INTO memory_scope_memberships (installation_id, membership_id, state, membership_revision)
      VALUES ($1, gen_random_uuid(), 'active', 1)
    `, [first.rows[0].id])).resolves.toBeTruthy()
  })
})
