import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createEpisodeRepository } from '../episodes/repository.js'
import { createPurgeRepository } from '../purge/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '44444444-4444-4444-4444-444444444444'
const HMAC_KEY = 'episode-resurrection-hmac-0123456789abcdef'

async function seedTerminalTurn(pool: pg.Pool, sessionId = 'ses-1', turnId = 'turn-1') {
  await pool.query(`
    INSERT INTO source_sessions
      (installation_id, session_id, agent_type, first_recorded_at, last_recorded_at)
    VALUES ($1, $2, 'codex', NOW(), NOW())
  `, [INSTALLATION, sessionId])
  await pool.query(`
    INSERT INTO source_events
      (source_event_id, installation_id, origin, origin_position, session_id, turn_id,
       event_type, occurred_at, payload, payload_hash)
    VALUES (gen_random_uuid(), $1, 'feed', $2, $3, $4, 'agent_text', NOW(),
            '{"text":"redacted"}'::jsonb, $5)
  `, [INSTALLATION, `pos-${turnId}`, sessionId, turnId, Buffer.alloc(32, 3)])
  await pool.query(`
    INSERT INTO source_turns
      (installation_id, turn_id, session_id, state, terminal_at, event_count)
    VALUES ($1, $2, $3, 'completed', NOW(), 1)
  `, [INSTALLATION, turnId, sessionId])
}

async function episodeCount(pool: pg.Pool, turnId = 'turn-1'): Promise<number> {
  const rows = await pool.query<{ count: string }>(`
    SELECT COUNT(*)::text FROM work_episodes WHERE installation_id = $1 AND turn_id = $2
  `, [INSTALLATION, turnId])
  return Number(rows.rows[0].count)
}

describeWithDatabase('episode compilation purge fence (PostgreSQL)', () => {
  let pool: pg.Pool
  let episodes: ReturnType<typeof createEpisodeRepository>
  let purge: ReturnType<typeof createPurgeRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    episodes = createEpisodeRepository(pool, { stabilizationMs: 0 })
    purge = createPurgeRepository(pool, { hmacKey: HMAC_KEY })
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_purge_receipts, memory_dead_letters, memory_jobs, memory_session_tombstones,
               memory_snapshot_runs, memory_snapshot_events, memory_feed_inbox,
               source_artifacts, source_turns, source_events, source_sessions,
               repositories, repo_snapshots, work_episodes, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
  })

  test('compiles an episode for a healthy installation', async () => {
    await seedTerminalTurn(pool)
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(1)
  })

  test('a visible session tombstone blocks episode compilation', async () => {
    await seedTerminalTurn(pool)
    await pool.query(`
      INSERT INTO memory_session_tombstones
        (installation_id, session_id, reason, source_feed_id, purged_at)
      VALUES ($1, 'ses-1', 'user_deleted', 5, NOW())
    `, [INSTALLATION])
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(0)
  })

  test('a fenced installation status blocks episode compilation', async () => {
    await seedTerminalTurn(pool)
    await pool.query(`
      UPDATE memory_installations SET local_status = 'purged' WHERE installation_id = $1
    `, [INSTALLATION])
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(0)
  })

  test('compiling after a completed installation purge leaves nothing behind', async () => {
    await seedTerminalTurn(pool)
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(1)
    await purge.purgeInstallation({ installationId: INSTALLATION, requestId: crypto.randomUUID(), reason: 'uninstall' })
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(0)
  })

  test('a compile racing an open purge transaction cannot outlive its commit', async () => {
    await seedTerminalTurn(pool)
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(1)

    // Hold the session purge transaction open with every content row locked —
    // the worst-case interleave for a concurrent compile. The compile runs
    // concurrently: it either blocks on the purge's row lock or lands after
    // it; both paths must converge to zero episodes.
    const purger = await pool.connect()
    try {
      await purger.query('BEGIN')
      await purge.purgeSession(
        { installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null },
        purger,
      )
      const compiling = episodes.compileTurn(INSTALLATION, 'turn-1')
      await new Promise(resolve => setTimeout(resolve, 150))
      await purger.query('COMMIT')
      await compiling
    } finally {
      purger.release()
    }

    expect(await episodeCount(pool)).toBe(0)
  })

  test('a FIRST compile racing an open purge transaction cannot outlive its commit', async () => {
    await seedTerminalTurn(pool)

    // No pre-existing episode row: the compile's plain INSERT cannot conflict
    // with the purge's work_episodes DELETE, so only the advisory-lock
    // serialization can prevent a permanently orphaned episode.
    const purger = await pool.connect()
    try {
      await purger.query('BEGIN')
      await purge.purgeSession(
        { installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null },
        purger,
      )
      const compiling = episodes.compileTurn(INSTALLATION, 'turn-1')
      await new Promise(resolve => setTimeout(resolve, 150))
      await purger.query('COMMIT')
      await compiling
    } finally {
      purger.release()
    }

    expect(await episodeCount(pool)).toBe(0)
  })

  test('a FIRST compile racing an open installation purge cannot outlive its commit', async () => {
    await seedTerminalTurn(pool)
    const requestId = crypto.randomUUID()

    const purger = await pool.connect()
    let receipt: string
    try {
      await purger.query('BEGIN')
      receipt = await purge.purgeInstallation(
        { installationId: INSTALLATION, requestId, reason: 'uninstall' }, purger,
      )
      const compiling = episodes.compileTurn(INSTALLATION, 'turn-1')
      await new Promise(resolve => setTimeout(resolve, 150))
      await purger.query('COMMIT')
      await compiling
    } finally {
      purger.release()
    }

    expect(receipt!).toContain(requestId)
    expect(await episodeCount(pool)).toBe(0)
  })

  test('a waiting compile holds no row locks: advisory locks precede the upsert', async () => {
    await seedTerminalTurn(pool)
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    expect(await episodeCount(pool)).toBe(1)

    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`
        SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0))
      `, [INSTALLATION, 'ses-1'])
      const compiling = episodes.compileTurn(INSTALLATION, 'turn-1')
      await new Promise(resolve => setTimeout(resolve, 150))
      // If the compile had already executed its upsert, this DELETE would
      // block on its row lock and hit the local statement timeout — the
      // re-compile deadlock window the lock order must exclude.
      await holder.query(`SET LOCAL statement_timeout = 300`)
      const deleted = await holder.query(
        `DELETE FROM work_episodes WHERE installation_id = $1 AND turn_id = $2`,
        [INSTALLATION, 'turn-1'],
      )
      expect(deleted.rowCount).toBe(1)
      await holder.query('ROLLBACK')
      await compiling
    } finally {
      holder.release()
    }

    expect(await episodeCount(pool)).toBe(1)
  })

  test('a transaction-scoped installation purge returns the stored receipt on replay', async () => {
    await seedTerminalTurn(pool)
    const requestId = crypto.randomUUID()
    const first = await purge.purgeInstallation(
      { installationId: INSTALLATION, requestId, reason: 'uninstall' },
    )

    // The transaction-client path skips the receipt pre-check; a replay for
    // the same request must still return the receipt actually stored.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const second = await purge.purgeInstallation(
        { installationId: INSTALLATION, requestId, reason: 'uninstall' }, client,
      )
      await client.query('COMMIT')
      expect(second).toBe(first)
    } finally {
      client.release()
    }
  })
})
