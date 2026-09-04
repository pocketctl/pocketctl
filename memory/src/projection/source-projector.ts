import type pg from 'pg'
import { classifyArtifact } from './artifact-classifier.js'
import { extractCanonicalEventKey } from './event-identity.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'

const TERMINAL_TURN_STATES = new Set(['completed', 'interrupted', 'failed', 'abandoned'])
const TURN_STATES = new Set([
  'running', 'interrupt_requested', 'completed', 'interrupted', 'failed', 'abandoned',
])
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i

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

export interface SourceProjectorOptions {
  /** Test hook: fail on an event type to prove transactional rollback. */
  failOnEventType?: string
  batchSize?: number
  /** Episode stabilization window used when scheduling compile jobs. */
  stabilizationMs?: number
  /** Executes session purge semantics for deletion topics. */
  purge?: {
    purgeSession(input: {
      installationId: string
      sessionId: string
      reason: string
      sourceFeedId: string | number | null
    }, transactionClient?: Pick<pg.PoolClient, 'query'>): Promise<number>
  }
  /** Runs only after the projector transaction commits. */
  onInvalidated?: (scope: 'session', count: number) => void
}

const DELETION_TOPICS = new Set(['session.deleted.v1', 'session.access.revoked.v1'])

/**
 * Ordered L0/L0.5 projector. Each pass claims the oldest pending inbox rows
 * for one installation and projects them inside a single transaction that
 * also flips the rows to projected (or purged under a tombstone) — a crash
 * never leaves "projected inbox, missing read model" or the reverse.
 */
export function createSourceProjector(pool: pg.Pool, options: SourceProjectorOptions = {}) {
  const batchSize = options.batchSize ?? 100
  const stabilizationMs = options.stabilizationMs ?? 30_000

  async function projectOnce(installationId: string): Promise<{ projected: number }> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const claimed = await client.query<InboxRow>(`
          SELECT feed_id::text, topic, session_id, turn_id, event_type, recorded_at,
                 classification, data
          FROM memory_feed_inbox
          WHERE installation_id = $1 AND projection_state = 'pending'
          ORDER BY feed_id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `, [installationId, batchSize])

        let projected = 0
        let invalidated = 0
        for (const row of claimed.rows) {
          if (options.failOnEventType === row.event_type) {
            throw new Error(`injected failure for ${row.event_type}`)
          }
          invalidated += await projectRow(client, installationId, row, stabilizationMs, options.purge)
          projected++
        }
        await client.query('COMMIT')
        if (invalidated > 0) {
          try {
            options.onInvalidated?.('session', invalidated)
          } catch {
            // A post-commit metric must never make the durable projection retry.
          }
        }
        return { projected }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } finally {
      client.release()
    }
  }

  return { projectOnce }
}

async function projectRow(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  row: InboxRow,
  stabilizationMs: number,
  purge?: SourceProjectorOptions['purge'],
): Promise<number> {
  // Deletion topics carry the purge semantics themselves: clear the session
  // body and derived rows, then mark this row projected (the tombstone fence
  // blocks any replayed content).
  if (DELETION_TOPICS.has(row.topic) && purge && row.session_id) {
    const invalidated = await purge.purgeSession({
      installationId,
      sessionId: row.session_id,
      reason: row.topic === 'session.access.revoked.v1' ? 'access_revoked' : 'user_deleted',
      sourceFeedId: String(row.feed_id),
    }, client)
    await client.query(
      `UPDATE memory_feed_inbox SET projection_state = 'projected', projected_at = NOW()
       WHERE installation_id = $1 AND feed_id = $2`,
      [installationId, row.feed_id],
    )
    return invalidated
  }
  // Tombstone fence first: a deleted session must never resurrect.
  if (row.session_id) {
    const tombstone = await client.query(
      `SELECT 1 FROM memory_session_tombstones
       WHERE installation_id = $1 AND session_id = $2`,
      [installationId, row.session_id],
    )
    if (tombstone.rowCount) {
      await client.query(
        `UPDATE memory_feed_inbox SET projection_state = 'purged', projected_at = NOW()
         WHERE installation_id = $1 AND feed_id = $2`,
        [installationId, row.feed_id],
      )
      return 0
    }
    await upsertSession(client, installationId, row)
  }

  const eventId = await insertSourceEvent(client, installationId, row)
  const data = row.data ?? {}

  if (row.turn_id) {
    await upsertTurn(client, installationId, row, eventId)
    // Terminal or late same-turn events (re)schedule episode compilation;
    // every event pushes availability past its own stabilization window, so
    // a late arrival re-delays the compile.
    await client.query(`
      INSERT INTO memory_jobs
        (job_id, installation_id, job_type, idempotency_key, priority, payload, available_at)
      VALUES (gen_random_uuid(), $1, 'compile_episode', $2, 80, '{}'::jsonb,
              NOW() + ($3 * INTERVAL '1 millisecond'))
      ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
        state = CASE
          WHEN memory_jobs.state IN ('completed', 'dead') THEN 'pending'
          ELSE memory_jobs.state
        END,
        available_at = EXCLUDED.available_at,
        attempts = CASE
          WHEN memory_jobs.state = 'running' THEN memory_jobs.attempts
          ELSE 0
        END,
        claimed_by = CASE
          WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL
          ELSE memory_jobs.claimed_by
        END,
        claim_expires_at = CASE
          WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL
          ELSE memory_jobs.claim_expires_at
        END,
        last_error_code = CASE
          WHEN memory_jobs.state = 'running' THEN 'rerun_required'
          ELSE NULL
        END,
        completed_at = CASE
          WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL
          ELSE memory_jobs.completed_at
        END
    `, [installationId, `compile_episode:${row.turn_id}`, stabilizationMs])
  }

  const artifact = classifyArtifact(row.event_type, data)
  if (artifact) {
    await client.query(`
      INSERT INTO source_artifacts
        (artifact_id, installation_id, session_id, turn_id, source_event_id,
         artifact_type, identity_key, path, call_id, status, details, occurred_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
      ON CONFLICT (installation_id, source_event_id, artifact_type, identity_key) DO NOTHING
    `, [
      installationId, row.session_id, row.turn_id, eventId, artifact.artifact_type,
      artifact.identity_key, artifact.path, artifact.call_id, artifact.status,
      JSON.stringify(artifact.details), row.recorded_at,
    ])
  }

  await observeRepository(client, installationId, data, row.recorded_at)
  await client.query(
    `UPDATE memory_feed_inbox SET projection_state = 'projected', projected_at = NOW()
     WHERE installation_id = $1 AND feed_id = $2`,
    [installationId, row.feed_id],
  )
  return 0
}

async function upsertSession(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  row: InboxRow,
): Promise<void> {
  const data = row.data ?? {}
  const agentType = row.event_type === 'session_discovered' && typeof data.agent === 'string'
    ? data.agent
    : typeof data.agent_type === 'string' ? data.agent_type : null
  const daemonId = typeof data.daemon_id === 'string' ? data.daemon_id : null
  const cwd = typeof data.cwd === 'string' ? data.cwd : null
  const worktreePath = typeof data.worktree_path === 'string' ? data.worktree_path : null
  const worktreeBranch = typeof data.worktree_branch === 'string' ? data.worktree_branch : null
  await client.query(`
    INSERT INTO source_sessions
      (installation_id, session_id, agent_type, daemon_id, status, cwd_observation,
       worktree_path, worktree_branch, first_recorded_at, last_recorded_at, last_feed_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
    ON CONFLICT (installation_id, session_id) DO UPDATE SET
      agent_type = COALESCE(EXCLUDED.agent_type, source_sessions.agent_type),
      daemon_id = COALESCE(EXCLUDED.daemon_id, source_sessions.daemon_id),
      status = COALESCE(EXCLUDED.status, source_sessions.status),
      cwd_observation = COALESCE(EXCLUDED.cwd_observation, source_sessions.cwd_observation),
      worktree_path = COALESCE(EXCLUDED.worktree_path, source_sessions.worktree_path),
      worktree_branch = COALESCE(EXCLUDED.worktree_branch, source_sessions.worktree_branch),
      last_recorded_at = EXCLUDED.last_recorded_at,
      last_feed_id = GREATEST(COALESCE(source_sessions.last_feed_id, 0), EXCLUDED.last_feed_id)
  `, [
    installationId, row.session_id, agentType, daemonId,
    typeof data.status === 'string' ? data.status : null,
    cwd, worktreePath, worktreeBranch, row.recorded_at, String(row.feed_id),
  ])
}

async function insertSourceEvent(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  row: InboxRow,
): Promise<string> {
  const result = await client.query<{ source_event_id: string }>(`
    INSERT INTO source_events
      (source_event_id, installation_id, origin, origin_position, canonical_event_key,
       session_id, turn_id, event_type, occurred_at, classification, payload, payload_hash)
    VALUES (gen_random_uuid(), $1, 'feed', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
    ON CONFLICT (installation_id, origin, origin_position) DO UPDATE SET
      payload_hash = source_events.payload_hash
    RETURNING source_event_id
  `, [
    installationId, String(row.feed_id), extractCanonicalEventKey(row.data ?? {}),
    row.session_id, row.turn_id, row.event_type, row.recorded_at,
    JSON.stringify(row.classification ?? {}), JSON.stringify(row.data ?? {}),
    canonicalPayloadHash(row.data ?? {}),
  ])
  return result.rows[0].source_event_id
}

async function upsertTurn(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  row: InboxRow,
  sourceEventId: string,
): Promise<void> {
  const data = row.data ?? {}
  const rawStatus = typeof data.turn_status === 'string' ? data.turn_status : data.status
  const status = typeof rawStatus === 'string' && TURN_STATES.has(rawStatus)
    ? rawStatus
    : null
  const existing = await client.query<{ state: string }>(`
    SELECT state FROM source_turns
    WHERE installation_id = $1 AND turn_id = $2
    FOR UPDATE
  `, [installationId, row.turn_id])
  const current = existing.rows[0]?.state
  let nextStatus: string | null = status
  let terminalAt: Date | null = null
  if (current && TERMINAL_TURN_STATES.has(current)) {
    // Terminal states never regress, even on late same-turn events.
    nextStatus = current
    const existingTerminal = await client.query<{ terminal_at: Date | null }>(`
      SELECT terminal_at FROM source_turns WHERE installation_id = $1 AND turn_id = $2
    `, [installationId, row.turn_id])
    terminalAt = existingTerminal.rows[0]?.terminal_at ?? row.recorded_at
  } else if (status && TERMINAL_TURN_STATES.has(status)) {
    terminalAt = row.recorded_at
  } else if (current) {
    nextStatus = status ?? current
  }

  const rawReason = typeof data.turn_reason === 'string' ? data.turn_reason : data.reason
  const reason = typeof rawReason === 'string' && rawReason.length > 0 ? rawReason : null
  await client.query(`
    INSERT INTO source_turns
      (installation_id, turn_id, session_id, state, reason, started_at, terminal_at,
       first_source_event_id, last_source_event_id, event_count)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)
    ON CONFLICT (installation_id, turn_id) DO UPDATE SET
      state = COALESCE(EXCLUDED.state, source_turns.state),
      terminal_at = COALESCE(source_turns.terminal_at, EXCLUDED.terminal_at),
      last_source_event_id = EXCLUDED.last_source_event_id,
      event_count = source_turns.event_count + 1,
      reason = COALESCE(EXCLUDED.reason, source_turns.reason),
      updated_at = NOW()
  `, [
    installationId, row.turn_id, row.session_id, nextStatus ?? 'running',
    reason, row.recorded_at, terminalAt, sourceEventId,
  ])
}

/**
 * Repository observations only appear when the payload carries an explicit
 * repository identity; commit snapshots additionally require a valid hex sha.
 * cwd/worktree paths are session observations and never repo identities.
 */
async function observeRepository(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  data: Record<string, unknown>,
  observedAt: Date,
): Promise<void> {
  const repositoryId = typeof data.repository_id === 'string' && data.repository_id.length > 0
    ? data.repository_id
    : null
  if (!repositoryId) return
  const inserted = await client.query<{ repository_id: string }>(`
    INSERT INTO repositories (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $3)
    ON CONFLICT (installation_id, repository_key) DO UPDATE SET
      first_observed_at = LEAST(repositories.first_observed_at, EXCLUDED.first_observed_at),
      last_observed_at = GREATEST(repositories.last_observed_at, EXCLUDED.last_observed_at)
    RETURNING repository_id
  `, [installationId, repositoryId, observedAt])
  const commitSha = typeof data.commit_sha === 'string'
    && COMMIT_SHA_PATTERN.test(data.commit_sha)
    ? data.commit_sha.toLowerCase()
    : null
  if (!commitSha) return
  await client.query(`
    INSERT INTO repo_snapshots
      (repo_snapshot_id, installation_id, repository_id, commit_sha, branch,
       worktree_identity, dirty, observed_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (installation_id, repository_id, commit_sha) DO UPDATE SET
      observed_at = LEAST(repo_snapshots.observed_at, EXCLUDED.observed_at),
      branch = COALESCE(EXCLUDED.branch, repo_snapshots.branch),
      worktree_identity = COALESCE(EXCLUDED.worktree_identity, repo_snapshots.worktree_identity),
      dirty = COALESCE(EXCLUDED.dirty, repo_snapshots.dirty)
  `, [
    installationId, inserted.rows[0].repository_id, commitSha,
    typeof data.branch === 'string' ? data.branch : null,
    typeof data.worktree_identity === 'string' ? data.worktree_identity : null,
    typeof data.dirty === 'boolean' ? data.dirty : null,
    observedAt,
  ])
}

export type SourceProjector = ReturnType<typeof createSourceProjector>
