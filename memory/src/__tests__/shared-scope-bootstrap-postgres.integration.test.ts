import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createInstallationRegistry } from '../installations/repository.js'
import { createScopeAuthorization } from '../governance/authorization.js'
import { createScopeControlProjector } from '../governance/membership-projector.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const suite = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const installation = '99999999-0000-4000-8000-000000000001'
const scope = '99999999-0000-4000-8000-000000000002'
const creator = '99999999-0000-4000-8000-000000000003'
const reader = '99999999-0000-4000-8000-000000000004'
function inventory(epoch = '2', state = 'active', members = [
  { membership_id: creator, membership_revision: '1', state: 'active', roles: ['scope_administrator'] },
  { membership_id: reader, membership_revision: '1', state: 'active', roles: ['reader'] },
]) {
  return { installation_id: installation, status: 'active' as const, config_version: '1',
    granted_scopes: ['scope:control:read'], subscriptions: ['scope.membership.v2'], enabled_services: ['memory.search'],
    event_filter: {}, snapshot_required: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    owner_scope_kind: 'organization' as const, owner_scope_id: scope, parent_organization_id: null,
    authorization_epoch: epoch, scope_snapshot: { state, memberships: members } }
}
suite('shared installation membership bootstrap (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); await assertMemoryTestDatabase(pool, url!); await applyMemorySchema(pool) }, 60_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations, memory_scope_tombstones CASCADE') })
  async function apply(item: ReturnType<typeof inventory>) { await createInstallationRegistry(pool).applyDiscovery({ generation: 1, items: [item as never] }) }
  async function authorized(id = creator, revision = '1', epoch = '2') {
    return createScopeAuthorization(pool).validateV2Grant({ primaryInstallationId: installation, configVersion: '1', scopeBindings: [{
      installation_id: installation, owner_scope_kind: 'organization', owner_scope_id: scope,
      membership_id: id, membership_revision: revision, authorization_epoch: epoch, permissions: ['read'],
    }] })
  }
  test('authorizes a pre-existing creator even after another member advanced the scope epoch', async () => {
    await apply(inventory())
    expect(await authorized()).not.toBeNull()
    expect(await authorized(reader)).not.toBeNull()
  })
  test('repairs a ready installation whose earlier creator membership was never projected', async () => {
    const old = inventory(); delete (old as Partial<typeof old>).scope_snapshot
    await apply(old)
    await pool.query("UPDATE memory_installations SET local_status='ready'")
    expect(await authorized()).toBeNull()
    await apply(inventory())
    expect(await authorized()).not.toBeNull()
  })
  test('a stale discovery cannot reactivate a revoked membership or a dissolved scope', async () => {
    await apply(inventory('3', 'active', [{ membership_id: creator, membership_revision: '2', state: 'revoked', roles: [] }]))
    await apply(inventory())
    expect(await authorized(creator, '1', '3')).toBeNull()
    expect((await pool.query('SELECT state FROM memory_scope_memberships WHERE membership_id=$1', [creator])).rows[0]?.state).toBe('revoked')
    await apply(inventory('4', 'dissolved', []))
    await apply(inventory())
    expect((await pool.query('SELECT state FROM memory_owner_scopes')).rows[0].state).toBe('dissolved')
  })
  test('ignores an older lifecycle event pulled before a newer discovery snapshot committed', async () => {
    await apply(inventory())
    let release!: (value: unknown) => void
    let pulled!: () => void
    const started = new Promise<void>(resolve => { pulled = resolve })
    const projector = createScopeControlProjector({ pool, workerId: 'bootstrap-race',
      pullScopeControlFeed: async () => { pulled(); return new Promise(resolve => { release = resolve }) },
      ackScopeControlFeed: async () => 0,
    })
    const running = projector.consumeInstallation(installation)
    await started
    await apply(inventory('4', 'dissolved', []))
    release({ installation_id: installation, items: [{ envelope_version: 2, feed_id: '1', topic: 'scope.lifecycle.v2',
      owner_scope: { kind: 'organization', id: scope, authorization_epoch: '3' },
      source: { kind: 'scope_lifecycle', id: scope, recorded_at: new Date().toISOString() },
      subject: { event_type: 'scope_created' }, classification: {}, data: { state: 'active' },
    }], next_cursor: 'c', lease_token: 'l', lease_expires_at: new Date(Date.now()+60_000).toISOString() })
    await running
    expect((await pool.query('SELECT state, authorization_epoch::text FROM memory_owner_scopes')).rows[0]).toEqual({ state: 'dissolved', authorization_epoch: '4' })
  })
  test('ignores an older membership event racing a newer revocation snapshot', async () => {
    await apply(inventory())
    let release!: (value: unknown) => void
    let pulled!: () => void
    const started = new Promise<void>(resolve => { pulled = resolve })
    const projector = createScopeControlProjector({ pool, workerId: 'membership-race',
      pullScopeControlFeed: async () => { pulled(); return new Promise(resolve => { release = resolve }) },
      ackScopeControlFeed: async () => 0,
    })
    const running = projector.consumeInstallation(installation)
    await started
    await apply(inventory('4', 'active', [{ membership_id: creator, membership_revision: '3', state: 'revoked', roles: [] }]))
    release({ installation_id: installation, items: [{ envelope_version: 2, feed_id: '1', topic: 'scope.membership.v2',
      owner_scope: { kind: 'organization', id: scope, authorization_epoch: '3' },
      source: { kind: 'scope_membership', id: reader, recorded_at: new Date().toISOString() },
      subject: { membership_id: reader, event_type: 'membership_updated' }, classification: {},
      data: { state: 'active', roles: ['reader'], membership_revision: '2' },
    }], next_cursor: 'c', lease_token: 'l', lease_expires_at: new Date(Date.now()+60_000).toISOString() })
    await running
    expect(await authorized(reader, '2', '4')).toBeNull()
    expect((await pool.query('SELECT state, membership_revision::text FROM memory_scope_memberships WHERE membership_id=$1', [reader])).rows[0])
      .toEqual({ state: 'revoked', membership_revision: '1' })
  })
  test('legacy discovery never reactivates a dissolved scope when advancing an epoch', async () => {
    await apply(inventory('4', 'dissolved', []))
    const legacy = inventory('5'); delete (legacy as Partial<typeof legacy>).scope_snapshot
    await apply(legacy)
    expect((await pool.query('SELECT state FROM memory_owner_scopes')).rows[0].state).toBe('dissolved')
  })
  test('repairs legacy active state from an authoritative suspended snapshot at the same epoch', async () => {
    const legacy = inventory(); delete (legacy as Partial<typeof legacy>).scope_snapshot
    await apply(legacy)
    await apply(inventory('2', 'suspended'))
    expect(await authorized()).toBeNull()
    expect((await pool.query('SELECT state FROM memory_owner_scopes')).rows[0].state).toBe('suspended')
    // Same-epoch active replay cannot undo the restrictive repair.
    await apply(inventory())
    expect((await pool.query('SELECT state FROM memory_owner_scopes')).rows[0].state).toBe('suspended')
  })
})
