import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createClaimRepository } from '../claims/repository.js'
import { createReviewService } from '../claims/review-service.js'
import { createIdempotencyStore } from '../api/idempotency.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '77777777-7777-4777-8777-777777777777'
const EVIDENCE_HANDLE = 'h0-aaaaaaaa'
const EPISODE_DOCUMENT = {
  final_outcome: { text: 'Vitest files live next to sources', evidence_handle: EVIDENCE_HANDLE },
}
const EVIDENCE_MANIFEST = {
  [EVIDENCE_HANDLE]: { kind: 'episode' },
}

describeWithDatabase('candidate review ledger transactions (PostgreSQL)', () => {
  let pool: pg.Pool
  let claims: ReturnType<typeof createClaimRepository>
  let review: ReturnType<typeof createReviewService>
  let idempotency: ReturnType<typeof createIdempotencyStore>
  let candidateId: string
  let episodeId: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    claims = createClaimRepository(pool)
    review = createReviewService(pool, claims)
    idempotency = createIdempotencyStore(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_idempotency_keys, memory_feedback, memory_jobs,
               claim_search_documents, knowledge_evidence, memory_candidates,
               memory_extraction_runs, knowledge_versions, knowledge_claims,
               work_episodes, source_turns, source_events, source_sessions,
               memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions
        (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-1', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
      VALUES ($1, 'turn-1', 'ses-1', 'completed', NOW())
    `, [INSTALLATION])
    const episode = await pool.query<{ episode_id: string }>(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         document, evidence_manifest, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1', $2::jsonb, $3::jsonb, NOW())
      RETURNING episode_id::text
    `, [INSTALLATION, JSON.stringify(EPISODE_DOCUMENT), JSON.stringify(EVIDENCE_MANIFEST)])
    episodeId = episode.rows[0].episode_id
    const run = await pool.query<{ run_id: string }>(`
      INSERT INTO memory_extraction_runs
        (run_id, installation_id, episode_id, episode_source_digest, extractor_version,
         prompt_version, model_config_hash, input_digest, mode, state, provider, model)
      VALUES (gen_random_uuid(), $1, $2, 'x'::bytea, 'e1', 'p1', 'x'::bytea, 'x'::bytea,
              'enabled', 'succeeded', 'openai-compatible', 'm')
      RETURNING run_id::text
    `, [INSTALLATION, episodeId])
    const candidate = await pool.query<{ candidate_id: string }>(`
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type, statement,
         structured_content, normalized_key, scope_kind, scope_key, confidence, freshness_at,
         evidence_handles, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 0, 'repository_convention',
              'Vitest files live next to sources', '{"owner":"memory"}'::jsonb,
              'key-1', 'installation', 'global',
              0.9, NOW(), $4::jsonb, 'validated')
      RETURNING candidate_id::text
    `, [INSTALLATION, run.rows[0].run_id, episodeId, JSON.stringify([EVIDENCE_HANDLE])])
    candidateId = candidate.rows[0].candidate_id
  })

  test('accept as-is creates claim + version + evidence + pointer + feedback + index job', async () => {
    const result = await review.acceptCandidate({
      installationId: INSTALLATION, candidateId, expectedRevision: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const claim = await pool.query<{
      state: string; current_version_id: string | null
    }>(`SELECT state, current_version_id::text FROM knowledge_claims WHERE claim_id = $1`, [result.claimId])
    expect(claim.rows[0]).toMatchObject({ state: 'active' })
    expect(claim.rows[0].current_version_id).toBe(result.versionId)
    const version = await pool.query<{ version_number: string; authority: string; statement: string; structured_content: Record<string, unknown> }>(`
      SELECT version_number::text, authority, statement, structured_content
      FROM knowledge_versions WHERE version_id = $1
    `, [result.versionId])
    expect(version.rows[0]).toMatchObject({ version_number: '1', authority: 'user_accepted' })
    expect(version.rows[0].structured_content).toEqual({ owner: 'memory' })
    const evidence = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_evidence WHERE version_id = $1`, [result.versionId])
    expect(evidence.rows[0].count).toBeGreaterThanOrEqual(1)
    const feedback = await pool.query<{ action: string }>(`
      SELECT action FROM memory_feedback WHERE candidate_id = $1
    `, [candidateId])
    expect(feedback.rows[0].action).toBe('candidate_accepted')
    const jobs = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_jobs WHERE job_type = 'index_claim_version'`)
    expect(jobs.rows[0].count).toBe(1)
    const candidate = await pool.query<{ status: string }>(`
      SELECT status FROM memory_candidates WHERE candidate_id = $1
    `, [candidateId])
    expect(candidate.rows[0].status).toBe('accepted')
  })

  test('accept with correction records user_corrected authority and the edited statement', async () => {
    const result = await review.acceptCandidate({
      installationId: INSTALLATION, candidateId, expectedRevision: 1,
      editedStatement: 'Vitest files colocate with sources (edited)',
    })
    expect(result.ok).toBe(true)
    const version = await pool.query<{
      authority: string; statement: string; normalized_key: string
      freshness_at: Date; candidate_freshness_at: Date
    }>(`
      SELECT v.authority, v.statement, c.normalized_key, v.freshness_at,
             candidate.freshness_at AS candidate_freshness_at
      FROM knowledge_versions v JOIN knowledge_claims c ON c.claim_id = v.claim_id
      JOIN memory_candidates candidate ON candidate.candidate_id = v.source_candidate_id
      WHERE v.version_id = $1
    `, [(result as { ok: true; versionId: string }).versionId])
    expect(version.rows[0]).toMatchObject({
      authority: 'user_corrected',
      statement: 'Vitest files colocate with sources (edited)',
    })
    expect(version.rows[0].normalized_key).toContain('Vitest files colocate with sources (edited)')
    expect(version.rows[0].freshness_at).toEqual(version.rows[0].candidate_freshness_at)
    const feedback = await pool.query<{ action: string }>(`
      SELECT action FROM memory_feedback WHERE candidate_id = $1
    `, [candidateId])
    expect(feedback.rows[0].action).toBe('candidate_corrected')
  })

  test('stale expected revisions are rejected with the current state', async () => {
    const result = await review.acceptCandidate({
      installationId: INSTALLATION, candidateId, expectedRevision: 99,
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', currentRevision: 1, state: 'validated' },
    })
  })

  test('concurrent acceptance of the same candidate allows exactly one winner', async () => {
    const [a, b] = await Promise.all([
      review.acceptCandidate({ installationId: INSTALLATION, candidateId, expectedRevision: 1 }),
      review.acceptCandidate({ installationId: INSTALLATION, candidateId, expectedRevision: 1 }),
    ])
    const winners = [a, b].filter(result => result.ok).length
    expect(winners).toBe(1)
    const claimsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims`)
    expect(claimsCount.rows[0].count).toBe(1)
  })

  test('a different candidate cannot reuse an existing claim identity or its revision token', async () => {
    const first = await review.acceptCandidate({
      installationId: INSTALLATION, candidateId, expectedRevision: 1,
    })
    expect(first.ok).toBe(true)
    const duplicate = await pool.query<{ candidate_id: string }>(`
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type, statement,
         normalized_key, scope_kind, scope_key, confidence, freshness_at, evidence_handles, status)
      SELECT gen_random_uuid(), installation_id, run_id, episode_id, 1, claim_type, statement,
             normalized_key, scope_kind, scope_key, confidence, freshness_at, evidence_handles, 'validated'
      FROM memory_candidates WHERE candidate_id = $1
      RETURNING candidate_id::text
    `, [candidateId])
    const second = await review.acceptCandidate({
      installationId: INSTALLATION,
      candidateId: duplicate.rows[0].candidate_id,
      expectedRevision: 1,
    })
    expect(second).toMatchObject({ ok: false, error: { code: 'identity_conflict' } })
    const versions = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions`)
    expect(versions.rows[0].count).toBe(1)
  })

  test('a duplicate idempotency key replays the original acceptance metadata', async () => {
    const runAccept = () => idempotency.execute({
      installationId: INSTALLATION,
      operation: 'accept_candidate',
      key: 'idem-key-1',
      requestCanonical: JSON.stringify({ candidateId, expectedRevision: 1 }),
      run: async client => {
        const transactionPool = createTransactionBoundPool(client)
        const transactionClaims = createClaimRepository(transactionPool)
        const result = await createReviewService(transactionPool, transactionClaims).acceptCandidate({
          installationId: INSTALLATION, candidateId, expectedRevision: 1,
        })
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, metadata: { claim_id: result.claimId, version_id: result.versionId, state: 'active' } }
      },
    })
    const first = await runAccept()
    expect(first.kind).toBe('completed')
    const second = await runAccept()
    expect(second.kind).toBe('replayed')
    if (second.kind === 'replayed' && first.kind === 'completed') {
      expect(second.metadata.claim_id).toBe(first.metadata.claim_id)
    }
    const claimsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims`)
    expect(claimsCount.rows[0].count).toBe(1)
  })

  test('a same-key different-request replay is a conflict', async () => {
    const base = {
      installationId: INSTALLATION,
      operation: 'accept_candidate',
      key: 'idem-key-2',
    }
    await idempotency.execute({
      ...base,
      requestCanonical: 'a',
      run: async () => ({ ok: true, metadata: { id: 1 } }),
    })
    const conflict = await idempotency.execute({
      ...base,
      requestCanonical: 'b',
      run: async () => ({ ok: true, metadata: { id: 2 } }),
    })
    expect(conflict.kind).toBe('conflict')
  })

  test('a failed idempotent mutation rolls back both business rows and its reservation', async () => {
    const failed = await idempotency.execute({
      installationId: INSTALLATION,
      operation: 'atomic_failure',
      key: 'idem-atomic-failure',
      requestCanonical: 'same-request',
      run: async client => {
        await client.query(`
          INSERT INTO memory_feedback (feedback_id, installation_id, action)
          VALUES (gen_random_uuid(), $1, 'recall_used')
        `, [INSTALLATION])
        return { ok: false, error: { code: 'forced_failure' } }
      },
    })
    expect(failed.kind).toBe('failed')
    const feedback = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_feedback`)
    const reservations = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_idempotency_keys`)
    expect(feedback.rows[0].count).toBe(0)
    expect(reservations.rows[0].count).toBe(0)
  })

  test('concurrent duplicate idempotency requests execute the transaction once', async () => {
    const execute = () => idempotency.execute({
      installationId: INSTALLATION,
      operation: 'atomic_concurrent',
      key: 'idem-atomic-concurrent',
      requestCanonical: 'same-request',
      run: async client => {
        await client.query(`
          INSERT INTO memory_feedback (feedback_id, installation_id, action)
          VALUES (gen_random_uuid(), $1, 'recall_used')
        `, [INSTALLATION])
        return { ok: true, metadata: { recorded: true } }
      },
    })
    const outcomes = await Promise.all([execute(), execute()])
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['completed', 'replayed'])
    const feedback = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_feedback`)
    expect(feedback.rows[0].count).toBe(1)
  })

  test('a failed evidence insert rolls the whole acceptance back and keeps the candidate reviewable', async () => {
    // Force the evidence insert to fail inside the acceptance transaction; a
    // mid-transaction failure must roll back claim+version and leave the
    // candidate untouched and reviewable.
    await pool.query(`
      CREATE OR REPLACE FUNCTION memory_test_fail_evidence() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'evidence_blocked'; END $fn$ LANGUAGE plpgsql
    `)
    await pool.query(`
      CREATE TRIGGER memory_test_fail_evidence_trigger
      BEFORE INSERT ON knowledge_evidence
      FOR EACH ROW EXECUTE FUNCTION memory_test_fail_evidence()
    `)
    try {
      await expect(review.acceptCandidate({
        installationId: INSTALLATION, candidateId, expectedRevision: 1,
      })).rejects.toThrow('evidence_blocked')
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS memory_test_fail_evidence_trigger ON knowledge_evidence`)
      await pool.query(`DROP FUNCTION IF EXISTS memory_test_fail_evidence()`)
    }
    const claimsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims`)
    expect(claimsCount.rows[0].count).toBe(0)
    const versionsCount = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions`)
    expect(versionsCount.rows[0].count).toBe(0)
    const feedbackCount = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_feedback`)
    expect(feedbackCount.rows[0].count).toBe(0)
    const candidate = await pool.query<{ status: string }>(`
      SELECT status FROM memory_candidates WHERE candidate_id = $1
    `, [candidateId])
    expect(candidate.rows[0].status).toBe('validated')
  })

  test('the review queue lists validated and conflict candidates, never shadow', async () => {
    await pool.query(`
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type, statement,
         normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
      SELECT gen_random_uuid(), $1, run_id, $2, 1, 'work_method', 'shadow one',
             'key-2', 'installation', 'global', 0.5, NOW(), 'shadow'
      FROM memory_extraction_runs LIMIT 1
    `, [INSTALLATION, episodeId])
    await pool.query(`
      INSERT INTO memory_candidates
        (candidate_id, installation_id, run_id, episode_id, ordinal, claim_type, statement,
         normalized_key, scope_kind, scope_key, confidence, freshness_at, status)
      SELECT gen_random_uuid(), $1, run_id, $2, 2, 'work_method', 'conflicting one',
             'key-3', 'installation', 'global', 0.5, NOW(), 'conflict'
      FROM memory_extraction_runs LIMIT 1
    `, [INSTALLATION, episodeId])
    const queue = await review.reviewQueue({ installationId: INSTALLATION })
    const statuses = queue.map(row => row.status)
    expect(statuses).toContain('validated')
    expect(statuses).toContain('conflict')
    expect(statuses).not.toContain('shadow')
    expect(queue.find(row => row.candidate_id === candidateId)?.structured_content).toEqual({ owner: 'memory' })
  })
})
