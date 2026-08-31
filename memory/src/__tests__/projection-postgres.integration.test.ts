import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createJobRepository } from '../jobs/repository.js'
import { createEpisodeRepository } from '../episodes/repository.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '11111111-1111-1111-1111-111111111111'

interface InboxRow {
  feed_id: string | number
  topic: string
  session_id: string | null
  turn_id: string | null
  event_type: string
  recorded_at: Date
  classification: Record<string, unknown>
  data: Record<string, unknown>
}

async function insertInboxRow(pool: pg.Pool, row: Partial<InboxRow> & { feed_id: string | number }) {
  await pool.query(`
    INSERT INTO memory_feed_inbox
      (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
       session_id, turn_id, event_type, recorded_at, classification, data, payload_hash)
    VALUES ($1, $2, 1, $3, 'canonical_event', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
  `, [
    INSTALLATION, row.feed_id, row.topic ?? 'session.event.v1', `evt-${row.feed_id}`,
    row.session_id ?? null, row.turn_id ?? null, row.event_type ?? 'agent_text',
    row.recorded_at ?? new Date(), JSON.stringify(row.classification ?? {}),
    JSON.stringify(row.data ?? {}), canonicalPayloadHash(row.data ?? {}),
  ])
}

describeWithDatabase('L0/L0.5 source projector (PostgreSQL)', () => {
  let pool: pg.Pool
  let projector: ReturnType<typeof createSourceProjector>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    projector = createSourceProjector(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_feed_inbox, source_artifacts, source_turns,
               source_events, source_sessions, repositories, repo_snapshots,
               work_episodes, memory_session_tombstones, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
  })

  test('projects inbox rows in strict feed order and marks them projected', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'session_created',
      data: { agent_type: 'codex', daemon_id: 'd-1', cwd: '/repo/x' },
    })
    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      data: { text: 'redacted', event_id: 'e-2' },
    })
    await insertInboxRow(pool, {
      feed_id: 3, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'completed' },
    })

    const result = await projector.projectOnce(INSTALLATION)
    expect(result.projected).toBe(3)

    const inbox = await pool.query<{ feed_id: string; projection_state: string }>(
      `SELECT feed_id::text, projection_state FROM memory_feed_inbox ORDER BY feed_id`,
    )
    expect(inbox.rows.every(row => row.projection_state === 'projected')).toBe(true)

    const session = await pool.query<{
      agent_type: string | null; daemon_id: string | null; cwd_observation: string | null
    }>(`SELECT agent_type, daemon_id, cwd_observation FROM source_sessions`)
    expect(session.rows[0]).toMatchObject({
      agent_type: 'codex', daemon_id: 'd-1', cwd_observation: '/repo/x',
    })

    const events = await pool.query<{ origin_position: string; canonical_event_key: string | null }>(
      `SELECT origin_position, canonical_event_key FROM source_events ORDER BY origin_position`,
    )
    expect(events.rows.map(row => row.origin_position)).toEqual(['1', '2', '3'])
    expect(events.rows[1].canonical_event_key).toBe('event_id:e-2')

    const turn = await pool.query<{ state: string; event_count: string; terminal_at: Date | null }>(
      `SELECT state, event_count::text, terminal_at FROM source_turns`,
    )
    expect(turn.rows[0].state).toBe('completed')
    expect(turn.rows[0].event_count).toBe('3')
    expect(turn.rows[0].terminal_at).not.toBeNull()
  })

  test('re-projecting the same rows is idempotent', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      data: { event_id: 'e-1' },
    })
    await projector.projectOnce(INSTALLATION)
    // Simulate a replay by resetting the inbox row to pending.
    await pool.query(`UPDATE memory_feed_inbox SET projection_state = 'pending'`)
    const again = await projector.projectOnce(INSTALLATION)
    expect(again.projected).toBe(1)
    const events = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM source_events`)
    expect(Number(events.rows[0].count)).toBe(1)
  })

  test('terminal turns never regress to running', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'completed' },
    })
    await projector.projectOnce(INSTALLATION)
    // A late running event for the same turn arrives.
    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      recorded_at: new Date(Date.now() + 1000), data: { status: 'running' },
    })
    await projector.projectOnce(INSTALLATION)
    const turn = await pool.query<{ state: string }>(`SELECT state FROM source_turns`)
    expect(turn.rows[0].state).toBe('completed')
  })

  test('terminal and late events reactivate a completed episode compile job', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'running' },
    })
    await projector.projectOnce(INSTALLATION)
    await pool.query(`
      UPDATE memory_jobs
      SET state = 'completed', attempts = 3, completed_at = NOW()
      WHERE installation_id = $1 AND job_type = 'compile_episode'
    `, [INSTALLATION])

    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'completed' },
    })
    await projector.projectOnce(INSTALLATION)

    const job = await pool.query<{
      state: string; attempts: number; completed_at: Date | null
    }>(`
      SELECT state, attempts, completed_at FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'compile_episode'
    `, [INSTALLATION])
    expect(job.rows[0]).toMatchObject({ state: 'pending', attempts: 0, completed_at: null })
  })

  test('late events wait for a running episode compile claim before rerunning', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'completed' },
    })
    await projector.projectOnce(INSTALLATION)
    await pool.query(`UPDATE memory_jobs SET available_at = NOW()`)
    const jobs = createJobRepository(pool)
    const [claim] = await jobs.claimJobs({ workerId: 'episode-old', limit: 1, leaseMs: 60_000 })

    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      recorded_at: new Date(Date.now() + 1_000), data: { event_id: 'late-1' },
    })
    await projector.projectOnce(INSTALLATION)

    const running = await pool.query<{
      state: string; claimed_by: string | null; last_error_code: string | null
    }>(`SELECT state, claimed_by, last_error_code FROM memory_jobs WHERE job_id = $1`, [claim.job_id])
    expect(running.rows[0]).toEqual({
      state: 'running', claimed_by: 'episode-old', last_error_code: 'rerun_required',
    })

    expect(await jobs.completeJob({
      jobId: claim.job_id, claimedBy: 'episode-old', claimEpoch: claim.claim_epoch,
    })).toBe(true)
    const rerun = await pool.query<{
      state: string; claimed_by: string | null; attempts: number; completed_at: Date | null
    }>(`SELECT state, claimed_by, attempts, completed_at FROM memory_jobs WHERE job_id = $1`, [claim.job_id])
    expect(rerun.rows[0]).toEqual({
      state: 'pending', claimed_by: null, attempts: 0, completed_at: null,
    })
  })

  test('a late event gives an exhausted running episode job a fresh retry budget', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'completed' },
    })
    await projector.projectOnce(INSTALLATION)
    await pool.query(`UPDATE memory_jobs SET available_at = NOW(), attempts = 11`)
    const jobs = createJobRepository(pool)
    const [claim] = await jobs.claimJobs({ workerId: 'episode-old', limit: 1, leaseMs: 60_000 })

    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      recorded_at: new Date(Date.now() + 1_000), data: { event_id: 'late-at-limit' },
    })
    await projector.projectOnce(INSTALLATION)

    expect(await jobs.rescheduleJob({
      jobId: claim.job_id,
      claimedBy: 'episode-old',
      claimEpoch: claim.claim_epoch,
      errorCode: 'handler_failed_Error',
    })).toBe(false)
    const job = await pool.query<{
      state: string; attempts: number; last_error_code: string | null
    }>(`SELECT state, attempts, last_error_code FROM memory_jobs WHERE job_id = $1`, [claim.job_id])
    expect(job.rows[0]).toEqual({
      state: 'pending', attempts: 0, last_error_code: 'handler_failed_Error',
    })
    const dead = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM memory_dead_letters WHERE job_id = $1
    `, [claim.job_id])
    expect(dead.rows[0].count).toBe('0')
  })

  test('a late event gives a pending episode job a fresh retry budget', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { status: 'completed' },
    })
    await projector.projectOnce(INSTALLATION)
    await pool.query(`
      UPDATE memory_jobs
      SET attempts = 11, last_error_code = 'handler_failed_Error'
      WHERE installation_id = $1 AND job_type = 'compile_episode'
    `, [INSTALLATION])

    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      recorded_at: new Date(Date.now() + 1_000), data: { event_id: 'late-pending' },
    })
    await projector.projectOnce(INSTALLATION)

    const job = await pool.query<{
      state: string; attempts: number; last_error_code: string | null
    }>(`
      SELECT state, attempts, last_error_code
      FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'compile_episode'
    `, [INSTALLATION])
    expect(job.rows[0]).toEqual({
      state: 'pending', attempts: 0, last_error_code: null,
    })
  })

  test('events without a turn id never fabricate turns', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: null, event_type: 'agent_text', data: {},
    })
    await projector.projectOnce(INSTALLATION)
    const turns = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM source_turns`)
    expect(Number(turns.rows[0].count)).toBe(0)
    const events = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM source_events`)
    expect(Number(events.rows[0].count)).toBe(1)
  })

  test('projects bigint feed ids into session checkpoints without rounding', async () => {
    const feedId = '9007199254740993'
    await insertInboxRow(pool, {
      feed_id: feedId, session_id: 'ses-bigint', event_type: 'session_created', data: {},
    })
    await projector.projectOnce(INSTALLATION)
    const session = await pool.query<{ last_feed_id: string }>(`
      SELECT last_feed_id::text FROM source_sessions WHERE session_id = 'ses-bigint'
    `)
    expect(session.rows).toEqual([{ last_feed_id: feedId }])
  })

  test('artifacts stay idempotent and unknown events leave no artifact', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'tool_call',
      data: { call_id: 'c-1', tool: 'read' },
    })
    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'file_change',
      data: { file_path: 'src/a.ts', change_type: 'edit' },
    })
    await insertInboxRow(pool, {
      feed_id: 3, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      data: { text: 'redacted' },
    })
    await projector.projectOnce(INSTALLATION)
    const artifacts = await pool.query<{ artifact_type: string; identity_key: string }>(
      `SELECT artifact_type, identity_key FROM source_artifacts ORDER BY artifact_type`,
    )
    expect(artifacts.rows).toEqual([
      { artifact_type: 'file_change', identity_key: 'src/a.ts' },
      { artifact_type: 'tool_call', identity_key: 'c-1' },
    ])
  })

  test('repositories and snapshots only appear with explicit identities', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', event_type: 'agent_text',
      data: { repository_id: 'repo-abc', commit_sha: 'abc1234', cwd: '/repo/x' },
    })
    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-2', event_type: 'agent_text',
      data: { cwd: '/only/a/path' },
    })
    await insertInboxRow(pool, {
      feed_id: 3, session_id: 'ses-3', event_type: 'agent_text',
      data: { repository_id: 'repo-abc', commit_sha: 'zz' },
    })
    await projector.projectOnce(INSTALLATION)
    const repos = await pool.query<{ repository_key: string }>(`SELECT repository_key FROM repositories`)
    expect(repos.rows.map(row => row.repository_key)).toEqual(['repo-abc'])
    const snapshots = await pool.query<{ commit_sha: string }>(`SELECT commit_sha FROM repo_snapshots`)
    expect(snapshots.rows.map(row => row.commit_sha)).toEqual(['abc1234'])
    // cwd only ever becomes a session observation.
    const sessions = await pool.query<{ session_id: string; cwd_observation: string | null }>(
      `SELECT session_id, cwd_observation FROM source_sessions ORDER BY session_id`,
    )
    expect(sessions.rows.find(row => row.session_id === 'ses-2')?.cwd_observation).toBe('/only/a/path')
  })

  test('a failing projection rolls back the whole row transaction', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text', data: {},
    })
    const broken = createSourceProjector(pool, {
      failOnEventType: 'agent_text',
    })
    await expect(broken.projectOnce(INSTALLATION)).rejects.toThrow(/injected/)
    const inbox = await pool.query<{ projection_state: string }>(
      `SELECT projection_state FROM memory_feed_inbox`,
    )
    expect(inbox.rows[0].projection_state).toBe('pending')
    const events = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM source_events`)
    expect(Number(events.rows[0].count)).toBe(0)
  })

  test('a rolled-back deletion batch does not publish invalidation metrics', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, topic: 'session.deleted.v1', session_id: 'ses-1',
      event_type: 'session_deleted', data: {},
    })
    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-2', event_type: 'agent_text', data: {},
    })
    let invalidated = 0
    const broken = createSourceProjector(pool, {
      failOnEventType: 'agent_text',
      purge: { purgeSession: async () => 3 },
      onInvalidated: (_scope, count) => { invalidated += count },
    })
    await expect(broken.projectOnce(INSTALLATION)).rejects.toThrow(/injected/)
    expect(invalidated).toBe(0)
    const states = await pool.query<{ projection_state: string }>(`
      SELECT projection_state FROM memory_feed_inbox ORDER BY feed_id
    `)
    expect(states.rows.map(row => row.projection_state)).toEqual(['pending', 'pending'])
  })

  test('tombstoned sessions mark replayed rows purged instead of resurrecting', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', event_type: 'agent_text', data: {},
    })
    await projector.projectOnce(INSTALLATION)
    await pool.query(`
      INSERT INTO memory_session_tombstones (installation_id, session_id, reason, source_feed_id, purged_at)
      VALUES ($1, 'ses-1', 'user_deleted', 1, NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_feed_inbox
        (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
         session_id, event_type, recorded_at, data, payload_hash)
      VALUES ($1, 2, 1, 'session.event.v1', 'canonical_event', 'evt-2',
              'ses-1', 'agent_text', NOW(), '{}'::jsonb, $2)
    `, [INSTALLATION, canonicalPayloadHash({})])
    const result = await projector.projectOnce(INSTALLATION)
    expect(result.projected).toBe(1)
    const replayed = await pool.query<{ projection_state: string }>(
      `SELECT projection_state FROM memory_feed_inbox WHERE feed_id = 2`,
    )
    expect(replayed.rows[0].projection_state).toBe('purged')
    // No new event row for the tombstoned session.
    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM source_events WHERE session_id = 'ses-1'`,
    )
    expect(Number(events.rows[0].count)).toBe(1)
  })

  test('deletion projection purges through the projector transaction without blocking', async () => {
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', event_type: 'agent_text', data: {},
    })
    await projector.projectOnce(INSTALLATION)
    await insertInboxRow(pool, {
      feed_id: 2, topic: 'session.deleted.v1', session_id: 'ses-1',
      event_type: 'session_deleted', data: {},
    })

    const guardedPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      statement_timeout: 500,
    })
    try {
      let invalidated = 0
      const deletionProjector = createSourceProjector(guardedPool, {
        purge: createPurgeRepository(guardedPool, {
          hmacKey: 'projection-purge-test-key-0123456789abcdef',
        }),
        onInvalidated: (_scope, count) => { invalidated += count },
      })
      await expect(deletionProjector.projectOnce(INSTALLATION)).resolves.toEqual({ projected: 1 })
      expect(invalidated).toBe(0)
      const tombstone = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM memory_session_tombstones
        WHERE installation_id = $1 AND session_id = 'ses-1'
      `, [INSTALLATION])
      expect(Number(tombstone.rows[0].count)).toBe(1)
    } finally {
      await guardedPool.end()
    }
  })
})

describeWithDatabase('episode packet persistence (PostgreSQL)', () => {
  let pool: pg.Pool
  let episodes: ReturnType<typeof createEpisodeRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    episodes = createEpisodeRepository(pool, { stabilizationMs: 0 })
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_feed_inbox, source_artifacts, source_turns,
               source_events, source_sessions, repositories, repo_snapshots,
               work_episodes, memory_session_tombstones, memory_feature_settings,
               memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id, extraction_mode)
      VALUES ($1, 'enabled')
    `, [INSTALLATION])
    await insertInboxRow(pool, {
      feed_id: 1, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'user_goal',
      data: { text: 'Fix the login flake', event_id: 'g-1' },
    })
    await insertInboxRow(pool, {
      feed_id: 2, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'file_change',
      data: { file_path: 'src/auth.ts', change_type: 'modified', lines_added: 3, lines_removed: 1, event_id: 'f-1' },
    })
    await insertInboxRow(pool, {
      feed_id: 3, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'turn_status',
      data: { turn_status: 'completed', turn_reason: 'done' },
    })
    const projector = createSourceProjector(pool)
    await projector.projectOnce(INSTALLATION)
  })

  async function episodeRow() {
    const result = await pool.query<{
      document: Record<string, unknown>
      evidence_manifest: Record<string, unknown>
      source_digest: Buffer | null
      document_compiler_version: string | null
      compiled_at: Date | null
      repository_id: string | null
    }>(`
      SELECT document, evidence_manifest, source_digest, document_compiler_version,
             compiled_at, repository_id::text
      FROM work_episodes WHERE installation_id = $1
    `, [INSTALLATION])
    return result.rows[0]
  }

  async function extractionJobs(): Promise<number> {
    const result = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM memory_jobs WHERE job_type = 'extract_candidates'
    `)
    return Number(result.rows[0].count)
  }

  test('compileTurn persists the packet, manifest, digest and compiler version', async () => {
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    const row = await episodeRow()
    expect(row.document.schema_version).toBe(1)
    const document = row.document as { objective?: Array<{ text: string }>; timeline?: unknown[] }
    expect(document.objective?.[0]?.text).toBe('Fix the login flake')
    expect((document.timeline?.length ?? 0)).toBeGreaterThanOrEqual(3)
    expect(Object.keys(row.evidence_manifest).length).toBeGreaterThan(0)
    expect(row.source_digest).not.toBeNull()
    expect(row.document_compiler_version).toBe('memory-episode-packet-v3')
    expect(row.compiled_at).not.toBeNull()
    expect(await extractionJobs()).toBe(1)
  })

  test('identical recompilation keeps bytes and adds no extraction job', async () => {
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    const first = await episodeRow()
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    const second = await episodeRow()
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document))
    expect(second.source_digest!.equals(first.source_digest!)).toBe(true)
    expect(await extractionJobs()).toBe(1)
  })

  test('a late same-turn event rebuilds the packet but coalesces extraction by turn', async () => {
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    const first = await episodeRow()
    await insertInboxRow(pool, {
      feed_id: 4, session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text',
      recorded_at: new Date(Date.now() + 1_000), data: { event_id: 'late-1', text: 'late' },
    })
    const projector = createSourceProjector(pool)
    await projector.projectOnce(INSTALLATION)
    await episodes.compileTurn(INSTALLATION, 'turn-1')
    const second = await episodeRow()
    expect(second.source_digest!.equals(first.source_digest!)).toBe(false)
    expect(await extractionJobs()).toBe(1)
    const job = await pool.query<{ idempotency_key: string; state: string }>(`
      SELECT idempotency_key, state FROM memory_jobs WHERE job_type = 'extract_candidates'
    `)
    expect(job.rows).toEqual([{ idempotency_key: 'extract:turn-1', state: 'pending' }])
    const episodesCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_episodes WHERE installation_id = $1`, [INSTALLATION],
    )
    expect(Number(episodesCount.rows[0].count)).toBe(1)
  })

  test('repository identity comes from payload facts, never cwd', async () => {
    const repositoryKey = 'repo-key-alpha'
    await insertInboxRow(pool, {
      feed_id: 5, session_id: 'ses-2', turn_id: 'turn-2', event_type: 'file_change',
      data: {
        file_path: 'src/b.ts', repository_id: repositoryKey, commit_sha: 'abc123def4567890',
        cwd: '/home/alice/secret/path', event_id: 'f-2',
      },
    })
    await insertInboxRow(pool, {
      feed_id: 6, session_id: 'ses-2', turn_id: 'turn-2', event_type: 'turn_status',
      data: { turn_status: 'completed' },
    })
    const projector = createSourceProjector(pool)
    await projector.projectOnce(INSTALLATION)
    const observedRepository = await pool.query<{ repository_id: string }>(`
      SELECT repository_id::text FROM repositories
      WHERE installation_id = $1 AND repository_key = $2
    `, [INSTALLATION, repositoryKey])
    await episodes.compileTurn(INSTALLATION, 'turn-2')
    const result = await pool.query<{
      repository_id: string | null
      document: Record<string, unknown>
    }>(`
      SELECT repository_id::text, document FROM work_episodes WHERE turn_id = 'turn-2'
    `)
    const observedId = observedRepository.rows[0]?.repository_id
    expect(observedId).toBeTruthy()
    expect(result.rows[0].repository_id).toBe(observedId)
    const repository = (result.rows[0].document as { repository?: { repository_id?: string | null; commit_sha?: string | null } }).repository
    expect(repository?.repository_id).toBe(observedId)
    expect(repository?.commit_sha).toBe('abc123def4567890')
    expect(JSON.stringify(result.rows[0].document)).not.toContain('/home/alice')
  })

  test('inherits repository identity only from the same-session lifecycle when turn events omit it', async () => {
    const repositoryKey = 'gitee.com/muwb123/pocketctl'
    const otherRepositoryKey = 'gitee.com/muwb123/other-project'
    const commitSha = '0123456789abcdef0123456789abcdef01234567'
    const observedAt = new Date('2026-08-29T00:00:00.000Z')
    await insertInboxRow(pool, {
      feed_id: 5,
      session_id: 'ses-lifecycle',
      turn_id: null,
      event_type: 'session_created',
      recorded_at: observedAt,
      data: {
        agent_type: 'codex',
        cwd: '/home/alice/pocketctl',
        repository_id: repositoryKey,
        branch: 'develop',
        commit_sha: commitSha,
      },
    })
    await insertInboxRow(pool, {
      feed_id: 6,
      session_id: 'ses-other',
      turn_id: null,
      event_type: 'session_discovered',
      recorded_at: new Date(observedAt.getTime() + 500),
      data: {
        agent_type: 'codex',
        repository_id: otherRepositoryKey,
        branch: 'main',
        commit_sha: 'abcdef0123456789abcdef0123456789abcdef01',
      },
    })
    await insertInboxRow(pool, {
      feed_id: 7,
      session_id: 'ses-lifecycle',
      turn_id: 'turn-lifecycle',
      event_type: 'user_goal',
      recorded_at: new Date(observedAt.getTime() + 1_000),
      data: { text: 'Verify repository inheritance', event_id: 'goal-lifecycle' },
    })
    await insertInboxRow(pool, {
      feed_id: 8,
      session_id: 'ses-lifecycle',
      turn_id: 'turn-lifecycle',
      event_type: 'turn_status',
      recorded_at: new Date(observedAt.getTime() + 2_000),
      data: { turn_status: 'completed' },
    })

    const projector = createSourceProjector(pool)
    await projector.projectOnce(INSTALLATION)
    await episodes.compileTurn(INSTALLATION, 'turn-lifecycle')

    const observedRepository = await pool.query<{ repository_id: string }>(`
      SELECT repository_id::text FROM repositories
      WHERE installation_id = $1 AND repository_key = $2
    `, [INSTALLATION, repositoryKey])
    const result = await pool.query<{
      repository_id: string | null
      document: Record<string, unknown>
    }>(`
      SELECT repository_id::text, document
      FROM work_episodes WHERE turn_id = 'turn-lifecycle'
    `)
    const observedId = observedRepository.rows[0]?.repository_id
    const repository = (result.rows[0].document as {
      repository?: { repository_id?: string | null; commit_sha?: string | null }
    }).repository
    expect(observedId).toBeTruthy()
    expect(result.rows[0].repository_id).toBe(observedId)
    expect(repository?.repository_id).toBe(observedId)
    expect(repository?.commit_sha).toBe(commitSha)
    expect(JSON.stringify(result.rows[0].document)).not.toContain('/home/alice')
  })

  test('extraction stays off unless the installation opted in', async () => {
    await pool.query(`
      UPDATE memory_feature_settings SET extraction_mode = 'off' WHERE installation_id = $1
    `, [INSTALLATION])
    await pool.query(`DELETE FROM memory_jobs WHERE job_type = 'extract_candidates'`)
    await insertInboxRow(pool, {
      feed_id: 7, session_id: 'ses-3', turn_id: 'turn-3', event_type: 'turn_status',
      data: { turn_status: 'completed' },
    })
    const projector = createSourceProjector(pool)
    await projector.projectOnce(INSTALLATION)
    await episodes.compileTurn(INSTALLATION, 'turn-3')
    expect(await extractionJobs()).toBe(0)
  })
})
