import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createMemoryMetrics, updateFeedLagGauge } from '../metrics.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('memory database metrics (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE memory_installations RESTART IDENTITY CASCADE`)
  })

  test('feed lag reports the stalest pullable installation', async () => {
    for (const [installationId, age] of [
      ['11111111-1111-1111-1111-111111111111', '2 hours'],
      ['22222222-2222-2222-2222-222222222222', '1 minute'],
    ] as const) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version, last_pull_at)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1, NOW() - $2::interval)
      `, [installationId, age])
    }
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version, created_at)
      VALUES ('33333333-3333-3333-3333-333333333333',
              'pocketctl-memory', 'active', 'discovering', 1, NOW() - INTERVAL '3 hours')
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version,
         snapshot_required, last_pull_at)
      VALUES
        ('44444444-4444-4444-4444-444444444444',
         'pocketctl-memory', 'paused', 'ready', 1, FALSE, NOW() - INTERVAL '1 day'),
        ('55555555-5555-5555-5555-555555555555',
         'pocketctl-memory', 'revoking', 'purging', 1, FALSE, NOW() - INTERVAL '2 days'),
        ('66666666-6666-6666-6666-666666666666',
         'pocketctl-memory', 'active', 'syncing', 1, TRUE, NOW() - INTERVAL '3 days')
    `)

    const metrics = createMemoryMetrics()
    await updateFeedLagGauge(pool, metrics.feedLag)
    const output = await metrics.registry.metrics()
    const value = Number(/pocketctl_memory_feed_lag_seconds ([0-9.]+)/.exec(output)?.[1])
    expect(value).toBeGreaterThan(10_700)
    expect(value).toBeLessThan(10_900)
  })
})
