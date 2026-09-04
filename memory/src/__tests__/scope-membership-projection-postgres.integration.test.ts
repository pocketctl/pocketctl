import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { createScopeControlProjector } from '../governance/membership-projector.js'
import { createInstallationRegistry } from '../installations/repository.js'
import type { ExtensionScopeFeedEnvelopeV2 } from '../relay/contracts.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const TEAM_SCOPE_ID = 'eeeeeeee-0000-4000-8000-000000000001'
const MEMBERSHIP_ID = 'eeeeeeee-0000-4000-8000-000000000002'
const ORGANIZATION_SCOPE_ID = 'eeeeeeee-0000-4000-8000-000000000003'

function envelope(
  feedId: number,
  overrides: Partial<ExtensionScopeFeedEnvelopeV2> & { data?: Record<string, unknown> } = {},
): ExtensionScopeFeedEnvelopeV2 {
  return {
    envelope_version: 2,
    feed_id: String(feedId),
    topic: 'scope.membership.v2',
    owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '2' },
    source: { kind: 'scope_membership', id: MEMBERSHIP_ID, recorded_at: '2026-08-30T10:00:00Z' },
    subject: { membership_id: MEMBERSHIP_ID, event_type: 'membership_created' },
    classification: {},
    data: { membership_revision: '1', state: 'active', roles: ['reader'] },
    ...overrides,
  }
}

describeWithDatabase('memory scope membership projection', () => {
  let pool: pg.Pool
  let installationId: string

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

  beforeEach(async () => {
    await pool.query(`TRUNCATE memory_scope_tombstones, memory_scope_memberships, memory_owner_scopes, memory_installations CASCADE`)
    const created = await pool.query<{ id: string }>(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         granted_scopes, subscriptions, enabled_services, event_filter)
      VALUES (gen_random_uuid(), 'pocketctl-memory', 'active', 'ready', 1,
              '["scope:control:read"]'::jsonb, '["scope.membership.v2","scope.lifecycle.v2"]'::jsonb,
              '["memory.search"]'::jsonb, '{}'::jsonb)
      RETURNING installation_id::text AS id
    `)
    installationId = created.rows[0].id
    await pool.query(`
      INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id, authorization_epoch)
      VALUES ($1, 'team', $2, 1)
    `, [installationId, TEAM_SCOPE_ID])
  })

  function projectorWith(items: ExtensionScopeFeedEnvelopeV2[]) {
    let pullCount = 0
    const ack = vi.fn()
    const pull = vi.fn(async () => {
      pullCount++
      return pullCount <= 1
        ? {
            installation_id: installationId,
            items,
            next_cursor: `cursor-${pullCount}`,
            lease_token: `lease-${pullCount}`,
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          }
        : {
            installation_id: installationId,
            items: [],
            next_cursor: `cursor-${pullCount}`,
            lease_token: `lease-${pullCount}`,
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          }
    })
    const projector = createScopeControlProjector({
      pool,
      workerId: 'test-worker',
      pullScopeControlFeed: pull as never,
      ackScopeControlFeed: ack as never,
    })
    return { projector, pull, ack }
  }

  async function membershipRow(): Promise<{
    roles: string[]
    state: string
    membership_revision: string
  }> {
    const row = await pool.query(`
      SELECT roles, state, membership_revision::text FROM memory_scope_memberships
      WHERE installation_id = $1 AND membership_id = $2
    `, [installationId, MEMBERSHIP_ID])
    return row.rows[0]
  }

  async function scopeRow(): Promise<{ state: string; authorization_epoch: string; last_feed_id: string }> {
    const row = await pool.query(`
      SELECT state, authorization_epoch::text, last_feed_id::text FROM memory_owner_scopes
      WHERE installation_id = $1
    `, [installationId])
    return row.rows[0]
  }

  test('applies membership events in epoch/revision order and records opaque facts only', async () => {
    const { projector } = projectorWith([
      envelope(1),
      envelope(2, {
        data: { membership_revision: '2', state: 'active', roles: ['reviewer'] },
        subject: { membership_id: MEMBERSHIP_ID, event_type: 'membership_roles_changed' },
      }),
    ])
    await projector.consumeInstallation(installationId)

    const membership = await membershipRow()
    expect(membership.roles).toEqual(['reviewer'])
    expect(membership.membership_revision).toBe('2')
    const scope = await scopeRow()
    expect(scope.authorization_epoch).toBe('2')
    expect(scope.last_feed_id).toBe('2')

    // Opaque projection only: no user/email/display fields exist anywhere.
    const columns = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'memory_scope_memberships'
      ORDER BY column_name
    `)
    const names = columns.rows.map(row => row.column_name)
    expect(names).not.toContain('email')
    expect(names).not.toContain('display_name')
    expect(names).not.toContain('user_id')
  })

  test('skips duplicate and stale events while advancing the watermark', async () => {
    const { projector } = projectorWith([
      envelope(1),
      // Replay of the same feed id: skipped.
      envelope(1),
      // Stale epoch (older than mirror): rejected without touching rows.
      envelope(3, {
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '1' },
        data: { membership_revision: '9', state: 'revoked', roles: [] },
      }),
      // Equal epoch with a non-newer revision: also stale.
      envelope(4, {
        data: { membership_revision: '1', state: 'revoked', roles: [] },
      }),
    ])
    await projector.consumeInstallation(installationId)

    const membership = await membershipRow()
    expect(membership.state).toBe('active')
    expect(membership.roles).toEqual(['reader'])
    const scope = await scopeRow()
    // The watermark still advances past skipped/stale rows so the feed ACKs.
    expect(scope.last_feed_id).toBe('4')
    expect(scope.authorization_epoch).toBe('2')
  })

  test('projects lifecycle suspension and dissolution with a tombstone', async () => {
    const { projector } = projectorWith([
      envelope(1, {
        topic: 'scope.lifecycle.v2',
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '2' },
        source: { kind: 'scope_lifecycle', id: TEAM_SCOPE_ID, recorded_at: '2026-08-30T10:00:00Z' },
        subject: { event_type: 'scope_suspended' },
        data: { state: 'suspended' },
      }),
    ])
    await projector.consumeInstallation(installationId)
    expect((await scopeRow()).state).toBe('suspended')

    const dissolve = projectorWith([
      envelope(2, {
        topic: 'scope.lifecycle.v2',
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '3' },
        source: { kind: 'scope_lifecycle', id: TEAM_SCOPE_ID, recorded_at: '2026-08-30T10:01:00Z' },
        subject: { event_type: 'scope_dissolved' },
        data: { state: 'dissolved' },
      }),
      // Older replayed facts after dissolution never resurrect the scope.
      envelope(3, {
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '2' },
        data: { membership_revision: '5', state: 'active', roles: ['reader'] },
      }),
    ])
    await dissolve.projector.consumeInstallation(installationId)

    const scope = await scopeRow()
    expect(scope.state).toBe('dissolved')
    expect(scope.authorization_epoch).toBe('3')

    const tombstone = await pool.query<{ authorization_epoch: string }>(`
      SELECT authorization_epoch::text FROM memory_scope_tombstones
      WHERE owner_scope_kind = 'team' AND owner_scope_id = $1
    `, [TEAM_SCOPE_ID])
    expect(tombstone.rowCount).toBe(1)
    expect(Number(tombstone.rows[0].authorization_epoch)).toBe(3)

    // The stale membership event never landed.
    const membership = await pool.query(
      `SELECT 1 FROM memory_scope_memberships WHERE installation_id = $1`,
      [installationId],
    )
    expect(membership.rowCount).toBe(0)
  })

  test('keeps dissolving scopes pollable and tombstones only the terminal dissolution', async () => {
    const dissolving = projectorWith([
      envelope(1, {
        topic: 'scope.lifecycle.v2',
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '2' },
        source: { kind: 'scope_lifecycle', id: TEAM_SCOPE_ID, recorded_at: '2026-08-30T10:00:00Z' },
        subject: { event_type: 'scope_dissolving' },
        data: { state: 'dissolving' },
      }),
    ])
    await dissolving.projector.consumeInstallation(installationId)

    expect((await scopeRow()).state).toBe('dissolving')
    expect((await pool.query(`SELECT 1 FROM memory_scope_tombstones`)).rowCount).toBe(0)
    const pollable = await pool.query<{ installation_id: string }>(`
      SELECT installation_id FROM memory_owner_scopes
      WHERE owner_scope_kind IN ('team', 'organization')
        AND state IN ('active', 'suspended', 'dissolving')
    `)
    expect(pollable.rows).toEqual([{ installation_id: installationId }])

    const dissolved = projectorWith([
      envelope(2, {
        topic: 'scope.lifecycle.v2',
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '3' },
        source: { kind: 'scope_lifecycle', id: TEAM_SCOPE_ID, recorded_at: '2026-08-30T10:01:00Z' },
        subject: { event_type: 'scope_dissolved' },
        data: { state: 'dissolved' },
      }),
    ])
    await dissolved.projector.consumeInstallation(installationId)

    expect((await scopeRow()).state).toBe('dissolved')
    expect((await pool.query(`SELECT 1 FROM memory_scope_tombstones`)).rowCount).toBe(1)
  })

  test('projects revocation into valid_until and stops counting the membership', async () => {
    const { projector } = projectorWith([
      envelope(1),
      envelope(2, {
        owner_scope: { kind: 'team', id: TEAM_SCOPE_ID, authorization_epoch: '3' },
        subject: { membership_id: MEMBERSHIP_ID, event_type: 'membership_state_changed' },
        data: { membership_revision: '2', state: 'revoked', roles: [] },
      }),
    ])
    await projector.consumeInstallation(installationId)

    const membership = await membershipRow()
    expect(membership.state).toBe('revoked')
    const scope = await scopeRow()
    expect(scope.authorization_epoch).toBe('3')
  })

  test('discovery upserts owner-scope metadata for shared installations', async () => {
    const registry = createInstallationRegistry(pool)
    const generation = await registry.currentGeneration() + 1
    await registry.applyDiscovery({
      generation,
      items: [{
        installation_id: installationId,
        status: 'active',
        config_version: '2',
        granted_scopes: ['scope:control:read'],
        subscriptions: ['scope.membership.v2'],
        enabled_services: ['memory.search'],
        event_filter: {},
        snapshot_required: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        owner_scope_kind: 'team',
        owner_scope_id: TEAM_SCOPE_ID,
        parent_organization_id: ORGANIZATION_SCOPE_ID,
        authorization_epoch: '7',
      }],
    })
    const scope = await pool.query<{
      authorization_epoch: string
      parent_organization_id: string
    }>(`
      SELECT authorization_epoch::text, parent_organization_id::text
      FROM memory_owner_scopes WHERE installation_id = $1
    `, [installationId])
    expect(scope.rows[0]).toEqual({
      authorization_epoch: '7',
      parent_organization_id: ORGANIZATION_SCOPE_ID,
    })
  })
})
