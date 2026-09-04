import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createExtractionRepository } from '../extraction/repository.js'
import { createCandidateExtractor } from '../extraction/extractor.js'
import { createClaimRepository } from '../claims/repository.js'
import { createClaimIndexer } from '../retrieval/indexer.js'
import { createCandidateDeduper } from '../extraction/deduper.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const MANIFEST = {
  'h0-aaaaaaaa': { kind: 'episode' },
  'h1-bbbbbbbb': { kind: 'episode' },
}
const DOCUMENT = {
  schema_version: 1,
  objective: [{ text: 'goal', evidence_handle: 'h0-aaaaaaaa' }],
  final_outcome: { text: 'done', evidence_handle: 'h1-bbbbbbbb' },
}
const VALID_OUTPUT = {
  candidates: [
    {
      claim_type: 'repository_convention',
      statement: 'Vitest colocates with sources',
      confidence: 0.9,
      scope_kind: 'installation',
      scope_key: 'global',
      evidence_handles: ['h0-aaaaaaaa'],
    },
    {
      claim_type: 'work_method',
      statement: 'Write regression tests before closing bugs',
      confidence: 0.8,
      scope_kind: 'installation',
      scope_key: 'global',
      evidence_handles: ['h0-aaaaaaaa'],
    },
  ],
}

async function seedEpisodeChain(pool: pg.Pool, installationId: string, sessionId: string) {
  await pool.query(`
    INSERT INTO source_sessions
      (installation_id, session_id, first_recorded_at, last_recorded_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (installation_id, session_id) DO NOTHING
  `, [installationId, sessionId])
  await pool.query(`
    INSERT INTO source_events
      (source_event_id, installation_id, origin, origin_position, session_id, turn_id,
       event_type, occurred_at, payload, payload_hash)
    VALUES (gen_random_uuid(), $1, 'feed', $2 || '-event', $2, $3, 'user_goal', NOW(),
            '{"text":"goal"}'::jsonb, sha256(convert_to('goal','utf8')))
  `, [installationId, sessionId, `${sessionId}-turn`])
  await pool.query(`
    INSERT INTO source_turns (installation_id, turn_id, session_id, state, terminal_at)
    VALUES ($1, $2, $3, 'completed', NOW())
  `, [installationId, `${sessionId}-turn`, sessionId])
  await pool.query(`
    INSERT INTO work_episodes
      (installation_id, episode_id, session_id, turn_id, state, compiler_version,
       source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
    VALUES ($1, gen_random_uuid(), $2, $3, 'ready', 'v1', $4::bytea, $5::jsonb,
            $6::jsonb, 'memory-episode-packet-v1', NOW())
  `, [installationId, sessionId, `${sessionId}-turn`, Buffer.alloc(32, 7),
      JSON.stringify(DOCUMENT), JSON.stringify(MANIFEST)])
}

describeWithDatabase('phase one purge and replay cannot resurrect (PostgreSQL)', () => {
  let pool: pg.Pool
  let purge: ReturnType<typeof createPurgeRepository>
  let extractionStore: ReturnType<typeof createExtractionRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    purge = createPurgeRepository(pool, { hmacKey: 'purge-hmac-0123456789abcdef0123456789' })
    extractionStore = createExtractionRepository(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_purge_receipts, memory_dead_letters, memory_jobs, memory_session_tombstones,
               memory_usage_outbox, memory_snapshot_runs, memory_snapshot_events, memory_feed_inbox,
               knowledge_tombstones, memory_idempotency_keys, memory_feedback,
               claim_search_documents, knowledge_evidence, memory_candidates,
               memory_extraction_runs, knowledge_claims, knowledge_versions,
               source_artifacts, source_turns, source_events, source_sessions,
               repositories, repo_snapshots, work_episodes, memory_installations,
               memory_provider_state
      RESTART IDENTITY CASCADE
    `)
    for (const installationId of [INSTALLATION, OTHER]) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_feature_settings (installation_id, extraction_mode, embedding_mode)
        VALUES ($1, 'enabled', 'off')
      `, [installationId])
      await seedEpisodeChain(pool, installationId, 'ses-1')
    }
  })

  function extractorWith(results: unknown[]) {
    let index = 0
    return createCandidateExtractor({
      store: extractionStore,
      textGenerator: {
        generateJson: (async () => {
          const next = results[index++]
          if (next === undefined) throw new Error('exhausted')
          if (typeof next === 'object' && next !== null && 'throw' in (next as object)) {
            throw new Error(String((next as { throw: unknown }).throw))
          }
          return next as never
        }) as never,
      },
      provider: 'openai-compatible',
      model: 'm',
      timeoutMs: 5_000,
      deduper: createCandidateDeduper(pool, {
        tombstoneHmacKeys: [{ version: 'legacy', key: 'purge-hmac-0123456789abcdef0123456789' }],
      }),
    })
  }

  async function acceptCandidateFromRun(installationId: string): Promise<string> {
    // The fixture extractor runs without the deduper, so candidates land as
    // shadow; promote them to the reviewable state the ledger requires.
    await pool.query(`
      UPDATE memory_candidates SET status = 'validated' WHERE installation_id = $1
    `, [installationId])
    const candidate = await pool.query<{ candidate_id: string }>(`
      SELECT candidate_id::text FROM memory_candidates
      WHERE installation_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [installationId])
    const claims = createClaimRepository(pool)
    const accepted = await claims.acceptCandidate({
      installationId, candidateId: candidate.rows[0].candidate_id, expectedRevision: 1,
    })
    if (!accepted.ok) throw new Error('accept failed in fixture')
    return accepted.claimId
  }

  async function phase1ContentCounts(installationId: string) {
    const tables = [
      ['memory_extraction_runs', 'installation_id'],
      ['memory_candidates', 'installation_id'],
      ['knowledge_claims', 'installation_id'],
      ['knowledge_versions', 'installation_id'],
      ['knowledge_evidence', 'installation_id'],
      ['claim_search_documents', 'installation_id'],
      ['memory_feedback', 'installation_id'],
      ['memory_idempotency_keys', 'installation_id'],
      ['knowledge_tombstones', 'installation_id'],
    ] as const
    const counts: Record<string, number> = {}
    for (const [table, column] of tables) {
      const rows = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`,
        [installationId],
      )
      counts[table] = rows.rows[0].count
    }
    return counts
  }

  test('session delete invalidates dependent candidates, claims, index and projections', async () => {
    const extractor = extractorWith([{ ok: true, value: VALID_OUTPUT, usage: { inputTokens: 5, outputTokens: 5, model: 'm' } }])
    await extractor.extract({ installationId: INSTALLATION, turnId: 'ses-1-turn', signal: new AbortController().signal })
    const claimId = await acceptCandidateFromRun(INSTALLATION)
    const indexer = createClaimIndexer({ pool })
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      SELECT $1, current_version_id, 'Vitest colocates with sources'
      FROM knowledge_claims WHERE claim_id = $2 AND current_version_id IS NOT NULL
    `, [INSTALLATION, claimId])

    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null,
    })

    const counts = await phase1ContentCounts(INSTALLATION)
    expect(counts.memory_candidates).toBe(0)
    expect(counts.knowledge_claims).toBe(0)
    expect(counts.knowledge_versions).toBe(0)
    expect(counts.knowledge_evidence).toBe(0)
    expect(counts.claim_search_documents).toBe(0)
    expect(counts.memory_extraction_runs).toBe(0)
    // Other installations are untouched.
    expect((await phase1ContentCounts(OTHER)).knowledge_claims).toBe(0)
    const otherEpisodes = await pool.query(
      `SELECT COUNT(*)::int AS count FROM work_episodes WHERE installation_id = $1`, [OTHER],
    )
    expect(otherEpisodes.rows[0].count).toBe(1)
  })

  test('session delete removes affected old versions but preserves an independently evidenced current version', async () => {
    await seedEpisodeChain(pool, INSTALLATION, 'ses-2')
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global',
              'old-secret-normalized-key', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const oldVersion = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'Deleted session statement', 'user_accepted', 1)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    const currentVersion = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence,
         valid_until)
      VALUES (gen_random_uuid(), $1, $2, 2, 'Independent replacement statement', 'user_corrected', 1,
              NOW() + INTERVAL '1 day')
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    const episodes = await pool.query<{ episode_id: string; session_id: string }>(`
      SELECT episode_id::text, session_id FROM work_episodes
      WHERE installation_id = $1 AND session_id IN ('ses-1', 'ses-2')
    `, [INSTALLATION])
    for (const [versionId, sessionId] of [
      [oldVersion.rows[0].version_id, 'ses-1'],
      [currentVersion.rows[0].version_id, 'ses-2'],
    ]) {
      const episodeId = episodes.rows.find(row => row.session_id === sessionId)!.episode_id
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        VALUES (gen_random_uuid(), $1, $2, $3, 'episode', $4,
                sha256(convert_to($4, 'utf8')), NOW(), 0)
      `, [INSTALLATION, versionId, episodeId, `${sessionId} evidence`])
    }
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, currentVersion.rows[0].version_id])

    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null,
    })
    const retained = await pool.query<{
      current_version_id: string; normalized_key: string; revision: string; valid_until: Date | null
    }>(`
      SELECT c.current_version_id::text, c.normalized_key, c.revision::text, v.valid_until
      FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id = c.current_version_id
      WHERE c.claim_id = $1
    `, [claim.rows[0].claim_id])
    expect(retained.rows[0].current_version_id).toBe(currentVersion.rows[0].version_id)
    expect(retained.rows[0].normalized_key).not.toContain('old-secret')
    expect(Number(retained.rows[0].revision)).toBe(2)
    expect(retained.rows[0].valid_until).toBeInstanceOf(Date)
    const versions = await pool.query<{ statement: string }>(`
      SELECT statement FROM knowledge_versions WHERE claim_id = $1
    `, [claim.rows[0].claim_id])
    expect(versions.rows).toEqual([{ statement: 'Independent replacement statement' }])
  })

  test('purging the current Version reopens and reindexes the newest surviving Version', async () => {
    await seedEpisodeChain(pool, INSTALLATION, 'ses-2')
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global',
              'current-purged-key', 'active') RETURNING claim_id::text
    `, [INSTALLATION])
    const oldVersion = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority,
         confidence, valid_until)
      VALUES (gen_random_uuid(), $1, $2, 1, 'Surviving historical statement',
              'user_accepted', 1, '2026-08-25T10:00:00.000Z')
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    const currentVersion = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence,
         valid_from)
      VALUES (gen_random_uuid(), $1, $2, 2, 'Purged current statement', 'user_corrected', 1,
              '2026-08-25T10:00:00.000Z')
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    const episodes = await pool.query<{ episode_id: string; session_id: string }>(`
      SELECT episode_id::text, session_id FROM work_episodes
      WHERE installation_id = $1 AND session_id IN ('ses-1', 'ses-2')
    `, [INSTALLATION])
    for (const [versionId, sessionId] of [
      [oldVersion.rows[0].version_id, 'ses-2'],
      [currentVersion.rows[0].version_id, 'ses-1'],
    ]) {
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        VALUES (gen_random_uuid(), $1, $2, $3, 'episode', $4,
                sha256(convert_to($4, 'utf8')), NOW(), 0)
      `, [INSTALLATION, versionId,
        episodes.rows.find(row => row.session_id === sessionId)!.episode_id,
        `${sessionId} fallback evidence`])
    }
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, currentVersion.rows[0].version_id])

    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null,
    })
    const retained = await pool.query<{ current_version_id: string; valid_until: Date | null }>(`
      SELECT c.current_version_id::text, v.valid_until
      FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id = c.current_version_id
      WHERE c.claim_id = $1
    `, [claim.rows[0].claim_id])
    expect(retained.rows[0]).toEqual({ current_version_id: oldVersion.rows[0].version_id, valid_until: null })
    const reindex = await pool.query<{ payload: { version_id?: string } }>(`
      SELECT payload FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'index_claim_version'
        AND idempotency_key LIKE 'purge-reindex:%'
    `, [INSTALLATION])
    expect(reindex.rows).toEqual([{ payload: { version_id: oldVersion.rows[0].version_id } }])
  })

  test('session delete preserves a version that still has evidence from another session', async () => {
    await seedEpisodeChain(pool, INSTALLATION, 'ses-2')
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'global',
              'shared-version-key', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, 'Shared independently evidenced statement',
              'user_accepted', 1)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    const episodes = await pool.query<{ episode_id: string; session_id: string }>(`
      SELECT episode_id::text, session_id FROM work_episodes
      WHERE installation_id = $1 AND session_id IN ('ses-1', 'ses-2')
      ORDER BY session_id
    `, [INSTALLATION])
    for (const [ordinal, episode] of episodes.rows.entries()) {
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        VALUES (gen_random_uuid(), $1, $2, $3, 'episode', $4,
                sha256(convert_to($4, 'utf8')), NOW(), $5)
      `, [INSTALLATION, version.rows[0].version_id, episode.episode_id,
          `${episode.session_id} evidence`, ordinal])
    }

    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null,
    })

    const retained = await pool.query<{ version_count: number; evidence_count: number; revision: string }>(`
      SELECT
        (SELECT COUNT(*)::int FROM knowledge_versions WHERE claim_id = $1) AS version_count,
        (SELECT COUNT(*)::int FROM knowledge_evidence WHERE version_id = $2) AS evidence_count,
        revision::text
      FROM knowledge_claims WHERE claim_id = $1
    `, [claim.rows[0].claim_id, version.rows[0].version_id])
    expect(retained.rows[0]).toMatchObject({ version_count: 1, evidence_count: 1, revision: '2' })
    const tombstones = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_tombstones`)
    expect(tombstones.rows[0].count).toBe(0)
  })

  test('a late extraction job racing session purge leaves no orphans', async () => {
    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null,
    })
    const extractor = extractorWith([{ ok: true, value: VALID_OUTPUT, usage: { inputTokens: 1, outputTokens: 1, model: 'm' } }])
    const outcome = await extractor.extract({
      installationId: INSTALLATION, turnId: 'ses-1-turn', signal: new AbortController().signal,
    })
    // The episode is gone: no run, no candidates, no claims — regardless of
    // the model outcome.
    expect(['episode_missing', 'skipped_mode_off']).toContain(outcome.kind)
    const counts = await phase1ContentCounts(INSTALLATION)
    expect(counts.memory_extraction_runs).toBe(0)
    expect(counts.memory_candidates).toBe(0)
  })

  test('installation purge removes every phase one row and leaves a receipt', async () => {
    const extractor = extractorWith([{ ok: true, value: VALID_OUTPUT, usage: { inputTokens: 2, outputTokens: 2, model: 'm' } }])
    await extractor.extract({ installationId: INSTALLATION, turnId: 'ses-1-turn', signal: new AbortController().signal })
    await acceptCandidateFromRun(INSTALLATION)

    const receipt = await purge.purgeInstallation({
      installationId: INSTALLATION, requestId: crypto.randomUUID(), reason: 'uninstall',
    })
    expect(receipt).toContain('memory-phase0')
    const counts = await phase1ContentCounts(INSTALLATION)
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} must be empty`).toBe(0)
    }
  })

  test('feed replay after a session purge cannot resurrect candidates or claims', async () => {
    const extractor = extractorWith([
      { ok: true, value: VALID_OUTPUT, usage: { inputTokens: 3, outputTokens: 3, model: 'm' } },
      { ok: true, value: VALID_OUTPUT, usage: { inputTokens: 3, outputTokens: 3, model: 'm' } },
    ])
    await extractor.extract({ installationId: INSTALLATION, turnId: 'ses-1-turn', signal: new AbortController().signal })
    const purgedClaimId = await acceptCandidateFromRun(INSTALLATION)
    const purgedStatement = await pool.query<{ statement: string }>(`
      SELECT v.statement FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id = c.current_version_id
      WHERE c.claim_id = $1
    `, [purgedClaimId])

    await purge.purgeSession({
      installationId: INSTALLATION, sessionId: 'ses-1', reason: 'user_deleted', sourceFeedId: null,
    })

    // Replay: re-seed the same session bytes and extract again.
    await seedEpisodeChain(pool, INSTALLATION, 'ses-1')
    await pool.query(`
      DELETE FROM memory_session_tombstones WHERE installation_id = $1 AND session_id = 'ses-1'
    `, [INSTALLATION]).catch(() => undefined)
    const replay = await extractor.extract({
      installationId: INSTALLATION, turnId: 'ses-1-turn', signal: new AbortController().signal,
    })
    expect(replay.kind).toBe('succeeded')
    const replayed = await pool.query<{ candidate_id: string; status: string }>(`
      SELECT candidate_id::text, status FROM memory_candidates
      WHERE installation_id = $1 AND statement = $2
      ORDER BY created_at DESC LIMIT 1
    `, [INSTALLATION, purgedStatement.rows[0].statement])
    expect(replayed.rows[0].status).toBe('rejected_by_validator')
    const acceptance = await createClaimRepository(pool).acceptCandidate({
      installationId: INSTALLATION,
      candidateId: replayed.rows[0].candidate_id,
      expectedRevision: 1,
    })
    expect(acceptance).toMatchObject({ ok: false, error: { code: 'candidate_not_reviewable' } })
    const claims = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims WHERE installation_id = $1`, [INSTALLATION])
    expect(claims.rows[0].count).toBe(0)
  })

  test('snapshot rebuild never mutates the ledger and drops stale projections', async () => {
    const extractor = extractorWith([{ ok: true, value: VALID_OUTPUT, usage: { inputTokens: 4, outputTokens: 4, model: 'm' } }])
    await extractor.extract({ installationId: INSTALLATION, turnId: 'ses-1-turn', signal: new AbortController().signal })
    const claimId = await acceptCandidateFromRun(INSTALLATION)
    const beforeVersions = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions WHERE installation_id = $1`, [INSTALLATION])

    // Simulated rebuild: re-run the index projection for the active claim.
    const indexer = createClaimIndexer({ pool })
    const versionId = await pool.query<{ version_id: string }>(`
      SELECT current_version_id::text AS version_id FROM knowledge_claims WHERE claim_id = $1
    `, [claimId])
    await indexer.indexVersion(INSTALLATION, versionId.rows[0].version_id, new AbortController().signal)

    const afterVersions = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions WHERE installation_id = $1`, [INSTALLATION])
    expect(afterVersions.rows[0].count).toBe(beforeVersions.rows[0].count)
    const statements = await pool.query(`SELECT statement FROM knowledge_versions WHERE installation_id = $1 ORDER BY version_number`, [INSTALLATION])
    for (const row of statements.rows) {
      expect(['Vitest colocates with sources', 'Write regression tests before closing bugs']).toContain(row.statement)
    }
    const docs = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents WHERE installation_id = $1`, [INSTALLATION])
    expect(docs.rows[0].count).toBe(1)
  })
})
