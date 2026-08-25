import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createInstallationRegistry } from '../installations/repository.js'
import type { ProviderInstallationItem } from '../relay/contracts.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

function item(overrides: Partial<ProviderInstallationItem> = {}): ProviderInstallationItem {
  return {
    installation_id: '11111111-1111-1111-1111-111111111111',
    status: 'active',
    config_version: '1',
    granted_scopes: ['session:events:read'],
    subscriptions: ['session.event.v1'],
    enabled_services: ['memory.search'],
    event_filter: {},
    snapshot_required: false,
    created_at: '2026-08-23T00:00:00Z',
    updated_at: '2026-08-23T00:00:00Z',
    ...overrides,
  }
}

describeWithDatabase('installation discovery registry (PostgreSQL)', () => {
  let pool: pg.Pool
  let registry: ReturnType<typeof createInstallationRegistry>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    registry = createInstallationRegistry(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_dead_letters, memory_purge_receipts,
               memory_session_tombstones, memory_usage_outbox, memory_feed_inbox,
               memory_snapshot_runs, memory_snapshot_events, memory_installations,
               memory_provider_state
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_provider_state (provider_id) VALUES ('pocketctl-memory')
    `)
  })

  test('applies a complete multi-page discovery as one generation', async () => {
    const generation = await registry.applyDiscovery({
      generation: 1,
      items: [
        item({ installation_id: '11111111-1111-1111-1111-111111111111', status: 'pending' }),
        item({ installation_id: '22222222-2222-2222-2222-222222222222', status: 'active', config_version: '4' }),
        item({ installation_id: '33333333-3333-3333-3333-333333333333', status: 'paused' }),
      ],
    })
    expect(generation.applied).toBe(3)

    const rows = await pool.query<{ installation_id: string; relay_status: string; local_status: string; config_version: string }>(
      `SELECT installation_id, relay_status, local_status, config_version::text
       FROM memory_installations ORDER BY installation_id`,
    )
    expect(rows.rows.map(row => [row.installation_id, row.relay_status])).toEqual([
      ['11111111-1111-1111-1111-111111111111', 'pending'],
      ['22222222-2222-2222-2222-222222222222', 'active'],
      ['33333333-3333-3333-3333-333333333333', 'paused'],
    ])
    // pending arrives as discovering until the first feed pull promotes it.
    expect(rows.rows.find(row => row.installation_id.startsWith('11111111'))?.local_status).toBe('discovering')
    expect(rows.rows.find(row => row.installation_id.startsWith('22222222'))?.local_status).toBe('syncing')
    expect(rows.rows.find(row => row.installation_id.startsWith('22222222'))?.config_version).toBe('4')
  })

  test('marks locally-missing installations degraded without deleting them', async () => {
    await registry.applyDiscovery({
      generation: 1,
      items: [
        item({ installation_id: '11111111-1111-1111-1111-111111111111' }),
        item({ installation_id: '22222222-2222-2222-2222-222222222222' }),
      ],
    })

    // Next complete generation drops the second installation.
    await registry.applyDiscovery({
      generation: 2,
      items: [item({ installation_id: '11111111-1111-1111-1111-111111111111' })],
    })

    const rows = await pool.query<{ installation_id: string; local_status: string }>(
      `SELECT installation_id, local_status FROM memory_installations ORDER BY installation_id`,
    )
    expect(rows.rows).toHaveLength(2) // nothing physically deleted
    const dropped = rows.rows.find(row => row.installation_id.startsWith('22222222'))
    expect(dropped?.local_status).toBe('degraded')
    const kept = rows.rows.find(row => row.installation_id.startsWith('11111111'))
    expect(kept?.local_status).not.toBe('degraded')
  })

  test('updates config versions and snapshots flags on re-discovery', async () => {
    await registry.applyDiscovery({
      generation: 1,
      items: [item({ installation_id: '44444444-4444-4444-4444-444444444444', config_version: '1' })],
    })
    await registry.applyDiscovery({
      generation: 2,
      items: [item({
        installation_id: '44444444-4444-4444-4444-444444444444',
        config_version: '7',
        snapshot_required: true,
        granted_scopes: ['session:events:read', 'session:snapshot:read'],
      })],
    })
    const row = await pool.query<{ config_version: string; snapshot_required: boolean; granted_scopes: string[] }>(
      `SELECT config_version::text, snapshot_required, granted_scopes FROM memory_installations`,
    )
    expect(row.rows[0].config_version).toBe('7')
    expect(row.rows[0].snapshot_required).toBe(true)
    expect(row.rows[0].granted_scopes).toEqual(['session:events:read', 'session:snapshot:read'])
  })

  test('preserves feed integrity diagnostics across discovery refreshes', async () => {
    await registry.applyDiscovery({ generation: 1, items: [item()] })
    await pool.query(`
      UPDATE memory_installations
      SET local_status = 'integrity_error', last_error_code = 'feed_integrity'
    `)
    await registry.applyDiscovery({ generation: 2, items: [item({ config_version: '2' })] })

    const row = await pool.query<{ local_status: string; last_error_code: string | null }>(
      `SELECT local_status, last_error_code FROM memory_installations`,
    )
    expect(row.rows[0]).toEqual({
      local_status: 'integrity_error',
      last_error_code: 'feed_integrity',
    })
  })

  test('revoking installations transition to purging without enqueueing an unhandled job', async () => {
    await registry.applyDiscovery({
      generation: 1,
      items: [item({ installation_id: '55555555-5555-5555-5555-555555555555', status: 'active' })],
    })
    await registry.applyDiscovery({
      generation: 2,
      items: [item({ installation_id: '55555555-5555-5555-5555-555555555555', status: 'revoking' })],
    })
    const installation = await pool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations`,
    )
    expect(installation.rows[0].local_status).toBe('purging')

    const jobs = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_jobs WHERE job_type = 'installation_purge'`,
    )
    expect(Number(jobs.rows[0].count)).toBe(0)

    // Re-discovering the same revoked state must not duplicate the job.
    await registry.applyDiscovery({
      generation: 3,
      items: [item({ installation_id: '55555555-5555-5555-5555-555555555555', status: 'revoked' })],
    })
    const again = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_jobs`,
    )
    expect(Number(again.rows[0].count)).toBe(0)
  })

  test('a revoked installation missing from the list keeps its purge pending', async () => {
    await registry.applyDiscovery({
      generation: 1,
      items: [item({ installation_id: '66666666-6666-6666-6666-666666666666', status: 'revoking' })],
    })
    // Relay drops the row entirely on the next inventory.
    await registry.applyDiscovery({ generation: 2, items: [] })
    const row = await pool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations`,
    )
    // Still purging — a missing row must not downgrade it to degraded.
    expect(row.rows[0].local_status).toBe('purging')
    const jobs = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_jobs WHERE job_type = 'installation_purge'`,
    )
    expect(Number(jobs.rows[0].count)).toBe(0)
  })

  test('a completed purge remains terminal when revoked inventory is rediscovered', async () => {
    const installationId = '77777777-7777-7777-7777-777777777777'
    await registry.applyDiscovery({
      generation: 1,
      items: [item({ installation_id: installationId, status: 'revoked' })],
    })
    await pool.query(
      `UPDATE memory_installations SET local_status = 'purged' WHERE installation_id = $1`,
      [installationId],
    )

    await registry.applyDiscovery({
      generation: 2,
      items: [item({ installation_id: installationId, status: 'revoked' })],
    })

    const row = await pool.query<{ local_status: string }>(
      `SELECT local_status FROM memory_installations WHERE installation_id = $1`,
      [installationId],
    )
    expect(row.rows[0].local_status).toBe('purged')
  })

  test('records the discovery cursor and timestamp in provider state', async () => {
    await registry.applyDiscovery({
      generation: 1,
      items: [item({ installation_id: '11111111-1111-1111-1111-111111111111' })],
      installationCursor: 'opaque-cursor-1',
    })
    const state = await pool.query<{ installation_cursor: string | null; last_discovery_at: Date | null }>(
      `SELECT installation_cursor, last_discovery_at FROM memory_provider_state`,
    )
    expect(state.rows[0].installation_cursor).toBe('opaque-cursor-1')
    expect(state.rows[0].last_discovery_at).not.toBeNull()
  })
})
