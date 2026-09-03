import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createExtractionRepository } from '../extraction/repository.js'
import { createJobRepository } from '../jobs/repository.js'
import { StaleJobFenceError } from '../generation/fence.js'
import { createCandidateExtractor } from '../extraction/extractor.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import type { ModelJsonResult } from '../ports/text-generator.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '22222222-2222-4222-8222-222222222222'

const MANIFEST = {
  'h0-aaaaaaaa': { kind: 'event', excerpt_hash: 'x', excerpt_length: 10, truncated: false },
  'h1-bbbbbbbb': { kind: 'artifact', excerpt_hash: 'y', excerpt_length: 12, truncated: false },
}

const DOCUMENT = {
  schema_version: 1,
  objective: [{ text: 'Fix the login flake', evidence_handle: 'h0-aaaaaaaa' }],
  repository: { repository_id: null, repo_snapshot_id: null, branch: null, commit_sha: null, worktree_identity: null },
  timeline: [
    { kind: 'user_goal', status: null, summary: 'user_goal text=Fix the login flake', evidence_handle: 'h0-aaaaaaaa' },
  ],
  files: [], symbols: [], tests: [], approvals: [], corrections: [], failures: [],
  final_outcome: { text: 'turn completed: done', evidence_handle: 'h1-bbbbbbbb' },
  incomplete: [],
}

const SOURCE_DIGEST = Buffer.alloc(32, 7)

function okResult(value: unknown, tokens = { in: 12, out: 6 }): ModelJsonResult<unknown> {
  return { ok: true, value, usage: { inputTokens: tokens.in, outputTokens: tokens.out, model: 'extractor-small' } }
}

function invalidResult(): ModelJsonResult<unknown> {
  return {
    ok: false, code: 'invalid_json', retryable: false,
    usage: { inputTokens: 4, outputTokens: 2, model: 'extractor-small' },
  }
}

function validOutput() {
  return {
    candidates: [
      {
        claim_type: 'repository_convention',
        statement: 'Vitest files live next to sources',
        confidence: 0.9,
        scope_kind: 'installation',
        scope_key: 'global',
        evidence_handles: ['h0-aaaaaaaa'],
      },
      {
        claim_type: 'bug_root_cause',
        statement: 'Login flake came from clock skew',
        confidence: 0.8,
        scope_kind: 'installation',
        scope_key: 'global',
        evidence_handles: ['h0-aaaaaaaa', 'h1-bbbbbbbb'],
      },
    ],
  }
}

describeWithDatabase('candidate extraction (PostgreSQL)', () => {
  let pool: pg.Pool
  let store: ReturnType<typeof createExtractionRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    store = createExtractionRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_usage_outbox, memory_jobs, memory_candidates, memory_extraction_runs,
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
      INSERT INTO memory_feature_settings (installation_id, extraction_mode)
      VALUES ($1, 'enabled')
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions
        (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-1', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO source_events
        (source_event_id, installation_id, origin, origin_position, session_id, turn_id,
         event_type, occurred_at, payload, payload_hash)
      VALUES (gen_random_uuid(), $1, 'feed', '1', 'ses-1', 'turn-1', 'user_goal', NOW(),
              $2::jsonb, $3)
    `, [INSTALLATION, JSON.stringify({ text: 'goal' }), canonicalPayloadHash({ text: 'goal' })])
    await pool.query(`
      INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
      VALUES ($1, 'turn-1', 'ses-1', 'completed', NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'memory-phase0-episodes-v1',
              $2, $3::jsonb, $4::jsonb, 'memory-episode-packet-v1', NOW())
    `, [INSTALLATION, SOURCE_DIGEST, JSON.stringify(DOCUMENT), JSON.stringify(MANIFEST)])
  })

  function generator(results: ModelJsonResult<unknown>[]) {
    const fn = vi.fn(async (): Promise<ModelJsonResult<unknown>> => {
      const next = results.shift()
      if (!next) throw new Error('generator exhausted')
      return next
    })
    return fn
  }

  function extractorWith(
    fn: ReturnType<typeof generator>,
    modelConfigFingerprint?: string,
    maxRunsPerEpisode?: number,
  ) {
    return createCandidateExtractor({
      store,
      textGenerator: { generateJson: fn as never },
      provider: 'openai-compatible',
      model: 'extractor-small',
      modelConfigFingerprint,
      timeoutMs: 5_000,
      maxRunsPerEpisode,
    })
  }

  test('persists a succeeded run, shadow candidates and a usage fact', async () => {
    const extractor = extractorWith(generator([okResult(validOutput())]))
    const outcome = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(outcome).toMatchObject({ kind: 'succeeded', candidateCount: 2 })

    const run = await pool.query<{ state: string; input_tokens: string; output_tokens: string }>(`
      SELECT state, input_tokens::text, output_tokens::text FROM memory_extraction_runs
    `)
    expect(run.rows[0].state).toBe('succeeded')
    expect(Number(run.rows[0].input_tokens)).toBe(12)
    expect(Number(run.rows[0].output_tokens)).toBe(6)

    const candidates = await pool.query<{ status: string; claim_type: string }>(`
      SELECT status, claim_type FROM memory_candidates ORDER BY ordinal
    `)
    expect(candidates.rows.map(row => row.status)).toEqual(['shadow', 'shadow'])
    expect(candidates.rows.map(row => row.claim_type)).toEqual([
      'repository_convention', 'bug_root_cause',
    ])

    const usage = await pool.query<{ operation: string; input_tokens: string }>(`
      SELECT operation, input_tokens::text FROM memory_usage_outbox
    `)
    expect(usage.rows[0].operation).toBe('candidate_extract')
    expect(Number(usage.rows[0].input_tokens)).toBe(12)
  })

  test('repeated extraction of identical input never calls the model twice', async () => {
    const fn = generator([okResult(validOutput())])
    const extractor = extractorWith(fn)
    const first = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    const second = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(first.kind).toBe('succeeded')
    expect(second).toMatchObject({ kind: 'skipped_existing', state: 'succeeded' })
    expect(fn).toHaveBeenCalledTimes(1)
    const runs = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_extraction_runs`)
    expect(runs.rows[0].count).toBe(1)
    const candidates = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_candidates`)
    expect(candidates.rows[0].count).toBe(2)
  })

  test('provider configuration fingerprint change creates a fresh extraction run', async () => {
    const firstFn = generator([okResult(validOutput())])
    const secondFn = generator([okResult(validOutput())])
    const first = await extractorWith(firstFn, 'provider-origin-a').extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    const second = await extractorWith(secondFn, 'provider-origin-b').extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(first.kind).toBe('succeeded')
    expect(second.kind).toBe('succeeded')
    expect(firstFn).toHaveBeenCalledTimes(1)
    expect(secondFn).toHaveBeenCalledTimes(1)
    const runs = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_extraction_runs`)
    expect(runs.rows[0].count).toBe(2)
  })

  test('concurrent extractors race to exactly one model call', async () => {
    const fn = generator([okResult(validOutput())])
    const extractor = extractorWith(fn)
    const [a, b] = await Promise.all([
      extractor.extract({ installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal }),
      extractor.extract({ installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal }),
    ])
    const outcomes = [a, b]
    expect(outcomes.filter(outcome => outcome.kind === 'succeeded')).toHaveLength(1)
    const duplicate = outcomes.find(outcome => outcome.kind !== 'succeeded')
    expect(duplicate).toBeDefined()
    if (duplicate?.kind === 'failed') {
      expect(duplicate).toMatchObject({ errorCode: 'run_in_progress', retryable: true })
    } else {
      expect(duplicate).toMatchObject({ kind: 'skipped_existing', state: 'succeeded' })
    }
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('a retryable failure retires the failed run so a bounded retry may proceed', async () => {
    const fn = generator([
      { ok: false, code: 'http_error', retryable: true, detail: 'server_error' },
      okResult(validOutput()),
    ])
    const extractor = extractorWith(fn)
    const first = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(first).toMatchObject({ kind: 'failed', retryable: true })
    const second = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(second.kind).toBe('succeeded')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('a pre-dispatch budget rejection leaves no run counted against the episode ceiling', async () => {
    const rejected = generator([{
      ok: false, code: 'budget_exceeded', retryable: false, detail: 'text_requests',
    }])
    const outcome = await extractorWith(rejected, undefined, 1).extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'budget_exceeded' })
    const runs = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_extraction_runs`)
    expect(runs.rows[0].count).toBe(0)
  })

  test('two invalid outputs quarantine the run with no candidates', async () => {
    const extractor = extractorWith(generator([invalidResult(), invalidResult()]))
    const outcome = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('quarantined')
    const run = await pool.query<{ state: string; error_code: string | null }>(`
      SELECT state, error_code FROM memory_extraction_runs
    `)
    expect(run.rows[0].state).toBe('quarantined')
    expect(run.rows[0].error_code).toContain('invalid_output')
    const candidates = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_candidates`)
    expect(candidates.rows[0].count).toBe(0)
    const usage = await pool.query<{ input_tokens: string; output_tokens: string }>(`
      SELECT input_tokens::text, output_tokens::text FROM memory_usage_outbox
    `)
    expect(usage.rows).toEqual([{ input_tokens: '8', output_tokens: '4' }])
  })

  test('shadow mode still extracts, records usage, and hides candidates from review', async () => {
    await pool.query(`
      UPDATE memory_feature_settings SET extraction_mode = 'shadow' WHERE installation_id = $1
    `, [INSTALLATION])
    const extractor = extractorWith(generator([okResult(validOutput())]))
    const outcome = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('succeeded')
    const run = await pool.query<{ mode: string }>(`SELECT mode FROM memory_extraction_runs`)
    expect(run.rows[0].mode).toBe('shadow')
    const candidates = await pool.query<{ status: string }>(`SELECT status FROM memory_candidates`)
    expect(candidates.rows.every(row => row.status === 'shadow')).toBe(true)
  })

  test('mode off skips before touching the runs table', async () => {
    await pool.query(`
      UPDATE memory_feature_settings SET extraction_mode = 'off' WHERE installation_id = $1
    `, [INSTALLATION])
    const fn = generator([])
    const extractor = extractorWith(fn)
    const outcome = await extractor.extract({
      installationId: INSTALLATION, turnId: 'turn-1', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('skipped_mode_off')
    expect(fn).not.toHaveBeenCalled()
    const runs = await pool.query(`SELECT COUNT(*)::int AS count FROM memory_extraction_runs`)
    expect(runs.rows[0].count).toBe(0)
  })

  describe('fenced extraction writes (ADR-P2-09)', () => {
    async function freshRun() {
      const episode = await pool.query<{ episode_id: string }>(
        `SELECT episode_id::text FROM work_episodes LIMIT 1`)
      const reserved = await store.reserveRun({
        installationId: INSTALLATION,
        episodeId: episode.rows[0].episode_id,
        sourceDigest: SOURCE_DIGEST,
        extractorVersion: 'ext-v1',
        promptVersion: 'prompt-v1',
        modelConfigHash: Buffer.alloc(32, 9),
        mode: 'enabled',
        provider: 'openai-compatible',
        model: 'extractor-small',
        staleAfterMs: 60_000,
      })
      expect(reserved.owner).toBe(true)
      return { runId: reserved.runId!, episodeId: episode.rows[0].episode_id }
    }

    async function claimedFence(idemKey: string) {
      const jobs = createJobRepository(pool)
      await jobs.enqueueJob({
        installationId: INSTALLATION,
        jobType: 'extract_candidates',
        idempotencyKey: idemKey,
      })
      const [claim] = await jobs.claimJobs({ workerId: 'w1', limit: 1, leaseMs: 60_000 })
      return { jobs, claim }
    }

    async function staleIt(fence: { job_id: string; claim_epoch: number }) {
      await pool.query(
        `UPDATE memory_jobs SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE job_id = $1`,
        [fence.job_id],
      )
    }

    const candidateRow = (ordinal: number) => ({
      ordinal,
      claimType: 'test_invariant',
      statement: `fenced statement ${ordinal}`,
      structuredContent: {},
      normalizedKey: `fence-nk-${ordinal}`,
      scopeKind: 'task',
      scopeKey: 'turn:fence',
      repositoryId: null,
      repoSnapshotId: null,
      branch: null,
      evidenceHandles: ['h0-aaaaaaaa'],
      confidence: '0.9000',
      freshnessAt: new Date(),
      validFrom: null,
      validUntil: null,
      status: 'validated' as const,
      validation: {},
      duplicateOfClaimId: null,
    })

    test('persistCandidates rejects a stale fence: no candidates, no usage, run stays running', async () => {
      const { runId, episodeId } = await freshRun()
      const { jobs, claim } = await claimedFence('extract:turn-1:fence-stale')
      await staleIt(claim)
      await jobs.claimJobs({ workerId: 'w2', limit: 1, leaseMs: 60_000 })

      await expect(store.persistCandidates({
        runId,
        installationId: INSTALLATION,
        episodeId,
        candidateStatus: 'validated',
        candidates: [candidateRow(0), candidateRow(1)],
        usage: { inputTokens: 10, outputTokens: 5, costMicros: 1 },
        fence: { jobId: claim.job_id, claimedBy: 'w1', claimEpoch: claim.claim_epoch },
      })).rejects.toBeInstanceOf(StaleJobFenceError)

      const candidates = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_candidates WHERE run_id = $1`, [runId])
      expect(candidates.rows[0].n).toBe(0)
      const run = await pool.query<{ state: string }>(`SELECT state FROM memory_extraction_runs WHERE run_id = $1`, [runId])
      expect(run.rows[0].state).toBe('running')
      const usage = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_usage_outbox WHERE usage_id = $1`, [`extraction:${runId}`])
      expect(usage.rows[0].n).toBe(0)
    })

    test('markRun rejects a stale fence and leaves run + usage untouched', async () => {
      const { runId } = await freshRun()
      const { jobs, claim } = await claimedFence('extract:turn-2:fence-stale')
      await staleIt(claim)
      await jobs.claimJobs({ workerId: 'w2', limit: 1, leaseMs: 60_000 })

      await expect(store.markRun({
        runId,
        state: 'failed',
        errorCode: 'late_owner',
        inputTokens: 3,
        outputTokens: 2,
        costMicros: 0,
        fence: { jobId: claim.job_id, claimedBy: 'w1', claimEpoch: claim.claim_epoch },
      })).rejects.toBeInstanceOf(StaleJobFenceError)

      const run = await pool.query<{ state: string; error_code: string | null }>(
        `SELECT state, error_code FROM memory_extraction_runs WHERE run_id = $1`, [runId])
      expect(run.rows[0].state).toBe('running')
      expect(run.rows[0].error_code).toBeNull()
      const usage = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_usage_outbox WHERE usage_id = $1`, [`extraction:${runId}`])
      expect(usage.rows[0].n).toBe(0)
    })

    test('a valid fence persists candidates, run completion and usage exactly once', async () => {
      const { runId, episodeId } = await freshRun()
      const { claim } = await claimedFence('extract:turn-3:fence-ok')

      await store.persistCandidates({
        runId,
        installationId: INSTALLATION,
        episodeId,
        candidateStatus: 'validated',
        candidates: [candidateRow(0)],
        usage: { inputTokens: 7, outputTokens: 4, costMicros: 2 },
        fence: { jobId: claim.job_id, claimedBy: 'w1', claimEpoch: claim.claim_epoch },
      })

      const candidates = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_candidates WHERE run_id = $1`, [runId])
      expect(candidates.rows[0].n).toBe(1)
      const run = await pool.query<{ state: string }>(`SELECT state FROM memory_extraction_runs WHERE run_id = $1`, [runId])
      expect(run.rows[0].state).toBe('succeeded')
      const usage = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_usage_outbox WHERE usage_id = $1`, [`extraction:${runId}`])
      expect(usage.rows[0].n).toBe(1)
    })
  })

})
