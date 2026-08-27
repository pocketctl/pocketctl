import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSearchService } from '../retrieval/search-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_INSTALLATION = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REPOSITORY_ID = 'aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SNAPSHOT_ID = 'aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describeWithDatabase('hybrid claim search (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_sessions,
               memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    for (const installationId of [INSTALLATION, OTHER_INSTALLATION]) {
      await pool.query(`
        INSERT INTO memory_installations
          (installation_id, provider_id, relay_status, local_status, config_version)
        VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
      `, [installationId])
      await pool.query(`
        INSERT INTO memory_feature_settings (installation_id) VALUES ($1)
      `, [installationId])
      await pool.query(`
        INSERT INTO source_sessions
          (installation_id, session_id, first_recorded_at, last_recorded_at)
        VALUES ($1, 'ses-1', NOW(), NOW())
      `, [installationId])
      const episode = await pool.query<{ episode_id: string }>(`
        INSERT INTO work_episodes
          (installation_id, episode_id, session_id, turn_id, state, compiler_version, compiled_at)
        VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1', NOW())
        RETURNING episode_id::text
      `, [installationId])
      await pool.query(`SELECT $1::text`, [episode.rows[0].episode_id])
      // store per-installation episode id for seeding below
      await pool.query(`
        INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key)
        VALUES (gen_random_uuid(), $1, 'report_usage', $2)
      `, [installationId, `seed:${installationId}`]).catch(() => undefined)
      await pool.query(`DELETE FROM memory_jobs WHERE installation_id = $1`, [installationId])
    }
  })

  interface SeedClaimInput {
    installationId: string
    key: string
    claimType?: string
    statement: string
    branch?: string | null
    repositoryId?: string | null
    repoSnapshotId?: string | null
    freshnessAt?: Date
    validFrom?: Date | null
    validUntil?: Date | null
    state?: string
    withEvidence?: boolean
    withDocument?: boolean
  }

  async function seedClaim(input: SeedClaimInput): Promise<{ claimId: string; versionId: string }> {
    const episode = await pool.query<{ episode_id: string }>(`
      SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [input.installationId])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, $2, 'installation', 'global', $3, $4)
      RETURNING claim_id::text
    `, [input.installationId, input.claimType ?? 'repository_convention',
      input.key, input.state ?? 'active'])
    const claimId = claim.rows[0].claim_id
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority,
         confidence, freshness_at, repository_id, repo_snapshot_id, branch, valid_from, valid_until)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 0.9, $4, $5, $6, $7, $8, $9)
      RETURNING version_id::text
    `, [input.installationId, claimId, input.statement, input.freshnessAt ?? new Date(),
        input.repositoryId ?? null, input.repoSnapshotId ?? null, input.branch ?? null,
        input.validFrom ?? null, input.validUntil ?? null])
    const versionId = version.rows[0].version_id
    await pool.query(`
      UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1
    `, [claimId, versionId])
    if (input.withEvidence !== false && episode.rows[0]) {
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        VALUES (gen_random_uuid(), $1, $2, $3, 'episode', $4,
                sha256(convert_to($4, 'utf8')), NOW(), 0)
      `, [input.installationId, versionId, episode.rows[0].episode_id, `evidence for ${input.key}`])
    }
    if (input.withDocument !== false) {
      await pool.query(`
        INSERT INTO claim_search_documents (installation_id, version_id, document)
        VALUES ($1, $2, $3)
      `, [input.installationId, versionId, `${input.statement} ${input.claimType ?? ''} ${input.branch ?? ''}`])
    }
    return { claimId, versionId }
  }

  function service() {
    return createSearchService({ pool, recallEmbeddingTimeoutMs: 500, cursorSigningKey: 'test-cursor-signing-key' })
  }

  test('metadata isolation: another installation is invisible', async () => {
    await seedClaim({ installationId: INSTALLATION, key: 'vitest-convention', statement: 'Vitest files live next to sources' })
    await seedClaim({ installationId: OTHER_INSTALLATION, key: 'vitest-convention', statement: 'Vitest files live next to sources' })
    const result = await service().search({
      installationId: INSTALLATION, query: 'vitest files sources',
    })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].claimType).toBe('repository_convention')
  })

  test('top-N ordering is deterministic across identical runs', async () => {
    for (let i = 0; i < 5; i++) {
      await seedClaim({
        installationId: INSTALLATION, key: `vitest-convention-${i}`,
        statement: `Vitest files live next to sources variant ${i}`,
      })
    }
    const search = service()
    const first = await search.search({ installationId: INSTALLATION, query: 'vitest files sources', limit: 5 })
    const second = await search.search({ installationId: INSTALLATION, query: 'vitest files sources', limit: 5 })
    expect(first.hits.map(hit => hit.versionId)).toEqual(second.hits.map(hit => hit.versionId))
    expect(first.hits.length).toBe(5)
  })

  test('equal relevance ties use Version freshness, not applicability start', async () => {
    const older = await seedClaim({
      installationId: INSTALLATION, key: 'freshness-old', statement: 'Equal freshness ranking fact',
      freshnessAt: new Date('2025-01-01T00:00:00.000Z'),
      validFrom: new Date('2026-06-01T00:00:00.000Z'),
    })
    const newer = await seedClaim({
      installationId: INSTALLATION, key: 'freshness-new', statement: 'Equal freshness ranking fact',
      freshnessAt: new Date('2026-01-01T00:00:00.000Z'),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
    })
    const result = await service().search({
      installationId: INSTALLATION, query: 'Equal freshness ranking fact', limit: 2,
    })
    expect(result.hits.map(hit => hit.versionId)).toEqual([newer.versionId, older.versionId])
    expect(result.hits[0].freshnessAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  test('expired validity and revoked claims are excluded', async () => {
    await seedClaim({
      installationId: INSTALLATION, key: 'expired-one',
      statement: 'Expired convention about vitest files',
      validUntil: new Date(Date.now() - 3_600_000),
    })
    await seedClaim({
      installationId: INSTALLATION, key: 'revoked-one',
      statement: 'Revoked convention about vitest files', state: 'revoked',
    })
    await seedClaim({
      installationId: INSTALLATION, key: 'live-one',
      statement: 'Live convention about vitest files',
    })
    const result = await service().search({
      installationId: INSTALLATION, query: 'vitest files',
    })
    expect(result.hits.map(hit => hit.statement)).toEqual(['Live convention about vitest files'])
  })

  test('zero-evidence claims never surface', async () => {
    await seedClaim({
      installationId: INSTALLATION, key: 'no-evidence',
      statement: 'Claim without evidence must not surface vitest',
      withEvidence: false,
    })
    const result = await service().search({
      installationId: INSTALLATION, query: 'claim without evidence',
    })
    expect(result.hits).toEqual([])
  })

  test('branch and snapshot applicability filter the pool', async () => {
    await pool.query(`
      INSERT INTO repositories
        (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES ($1, $2, 'repo-branch-test', NOW(), NOW())
    `, [REPOSITORY_ID, INSTALLATION])
    await pool.query(`
      INSERT INTO repo_snapshots
        (repo_snapshot_id, installation_id, repository_id, commit_sha, observed_at)
      VALUES ($1, $2, $3, 'abc123def4567890abcd', NOW())
    `, [SNAPSHOT_ID, INSTALLATION, REPOSITORY_ID])
    await seedClaim({
      installationId: INSTALLATION, key: 'branch-main', statement: 'Branch scoped vitest fact',
      branch: 'main', repositoryId: REPOSITORY_ID, repoSnapshotId: SNAPSHOT_ID,
    })
    await seedClaim({
      installationId: INSTALLATION, key: 'branch-dev', statement: 'Other branch scoped vitest fact',
      branch: 'dev', repositoryId: REPOSITORY_ID,
    })
    const search = service()
    const mainOnly = await search.search({
      installationId: INSTALLATION, query: 'vitest fact', branch: 'main',
    })
    expect(mainOnly.hits.map(hit => hit.statement)).toEqual(['Branch scoped vitest fact'])
    const snapshotOnly = await search.search({
      installationId: INSTALLATION, query: 'vitest fact', repoSnapshotId: SNAPSHOT_ID,
    })
    expect(snapshotOnly.hits.map(hit => hit.statement)).toEqual(['Branch scoped vitest fact'])
  })

  test('as_of honours historical validity windows', async () => {
    await seedClaim({
      installationId: INSTALLATION, key: 'windowed',
      statement: 'Vitest windowed validity fact',
      validFrom: new Date(Date.now() + 3_600_000), // starts in the future
    })
    const now = await service().search({ installationId: INSTALLATION, query: 'vitest windowed' })
    expect(now.hits).toEqual([])
  })

  test('as_of returns the immutable Version that was effective before correction', async () => {
    const first = await seedClaim({
      installationId: INSTALLATION,
      key: 'historical-correction',
      statement: 'Original historical vitest convention',
    })
    const effectiveFrom = new Date('2020-01-01T00:00:00.000Z')
    const correctedAt = new Date('2021-01-01T00:00:00.000Z')
    await pool.query(`
      UPDATE knowledge_versions
      SET created_at = $2, valid_from = $2, valid_until = $3
      WHERE installation_id = $1 AND version_id = $4
    `, [INSTALLATION, effectiveFrom, correctedAt, first.versionId])
    const second = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority,
         confidence, valid_from, created_at)
      VALUES (gen_random_uuid(), $1, $2, 2, 'Corrected current vitest convention',
              'user_corrected', 0.9, $3, $3)
      RETURNING version_id::text
    `, [INSTALLATION, first.claimId, correctedAt])
    const episode = await pool.query<{ episode_id: string }>(`
      SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, 'episode', 'correction evidence',
              sha256(convert_to('correction evidence', 'utf8')), $4, 0)
    `, [INSTALLATION, second.rows[0].version_id, episode.rows[0].episode_id, correctedAt])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'Corrected current vitest convention')
    `, [INSTALLATION, second.rows[0].version_id])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [first.claimId, second.rows[0].version_id])
    await pool.query(`DELETE FROM claim_search_documents WHERE version_id = $1`, [first.versionId])

    const historical = await service().search({
      installationId: INSTALLATION,
      query: 'historical vitest convention',
      asOf: new Date('2020-06-01T00:00:00.000Z'),
    })
    expect(historical.hits.map(hit => hit.versionId)).toEqual([first.versionId])
    const wrongHistorical = await service().search({
      installationId: INSTALLATION,
      query: 'Corrected current',
      asOf: new Date('2020-06-01T00:00:00.000Z'),
    })
    expect(wrongHistorical.hits).toEqual([])
    const current = await service().search({
      installationId: INSTALLATION,
      query: 'current vitest convention',
    })
    expect(current.hits.map(hit => hit.versionId)).toEqual([second.rows[0].version_id])
  })

  test('lexical recall covers 10k active versions with p95 below 500ms', async () => {
    const episode = await pool.query<{ episode_id: string }>(`
      SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [INSTALLATION])
    const generatedRows = `
      SELECT g,
        (substr(md5('claim-' || g::text),1,8) || '-' || substr(md5('claim-' || g::text),9,4)
          || '-4' || substr(md5('claim-' || g::text),14,3) || '-8'
          || substr(md5('claim-' || g::text),18,3) || '-' || substr(md5('claim-' || g::text),21,12))::uuid AS claim_id,
        CASE WHEN g = 9999 THEN 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid ELSE
          (substr(md5('version-' || g::text),1,8) || '-' || substr(md5('version-' || g::text),9,4)
            || '-4' || substr(md5('version-' || g::text),14,3) || '-8'
            || substr(md5('version-' || g::text),18,3) || '-' || substr(md5('version-' || g::text),21,12))::uuid END AS version_id,
        CASE WHEN g = 9999 THEN 'needle beyond arbitrary prefilter' ELSE 'unrelated filler ' || g::text END AS statement
      FROM generate_series(1, 10000) g
    `
    await pool.query(`
      WITH generated AS (${generatedRows})
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      SELECT claim_id, $1, 'work_method', 'installation', 'global',
             'work_method|global|' || statement, 'active'
      FROM generated
    `, [INSTALLATION])
    await pool.query(`
      WITH generated AS (${generatedRows})
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      SELECT version_id, $1, claim_id, 1, statement, 'user_accepted', 0.9 FROM generated
    `, [INSTALLATION])
    await pool.query(`
      WITH generated AS (${generatedRows})
      UPDATE knowledge_claims c SET current_version_id = g.version_id
      FROM generated g WHERE c.claim_id = g.claim_id AND c.installation_id = $1
    `, [INSTALLATION])
    await pool.query(`
      WITH generated AS (${generatedRows}), evidenced AS (
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        SELECT gen_random_uuid(), $1, version_id, $2, 'episode', 'bulk evidence',
               sha256(convert_to('bulk evidence', 'utf8')), NOW(), 0 FROM generated
        RETURNING version_id
      )
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      SELECT $1, e.version_id, g.statement
      FROM evidenced e JOIN generated g ON g.version_id = e.version_id
    `, [INSTALLATION, episode.rows[0].episode_id])

    const result = await service().search({
      installationId: INSTALLATION,
      query: 'needle beyond arbitrary prefilter',
    })
    expect(result.hits.map(hit => hit.versionId))
      .toContain('ffffffff-ffff-4fff-8fff-ffffffffffff')

    // Warm the PostgreSQL relation/index pages, then measure the same service
    // boundary used by REST and MCP. The target is frozen in plan section 14.
    await service().search({ installationId: INSTALLATION, query: 'unrelated filler 5000' })
    const durations: number[] = []
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now()
      await service().search({
        installationId: INSTALLATION,
        query: index % 2 === 0 ? 'needle beyond arbitrary prefilter' : `unrelated filler ${index + 1}`,
      })
      durations.push(performance.now() - started)
    }
    durations.sort((left, right) => left - right)
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]
    console.info(JSON.stringify({
      gate: 'memory_lexical_10k',
      activeVersions: 10_000,
      samples: durations.length,
      medianMs: Number(durations[Math.floor(durations.length / 2)].toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
      maxMs: Number(durations.at(-1)!.toFixed(2)),
    }))
    expect(p95).toBeLessThan(500)
  }, 30_000)

  test('English FTS and Chinese/code trigram recall both work', async () => {
    await seedClaim({
      installationId: INSTALLATION, key: 'english-fts',
      statement: 'The drain worker claims jobs with SKIP LOCKED semantics',
    })
    await seedClaim({
      installationId: INSTALLATION, key: 'chinese-trgm',
      statement: '登录接口的时钟偏移容差必须设置为三十秒 clockSkewTolerance',
    })
    const search = service()
    const english = await search.search({ installationId: INSTALLATION, query: 'SKIP LOCKED' })
    expect(english.hits.length).toBeGreaterThanOrEqual(1)
    const chinese = await search.search({ installationId: INSTALLATION, query: '时钟偏移容差' })
    expect(chinese.hits.map(hit => hit.statement)[0]).toContain('时钟偏移')
    const code = await search.search({ installationId: INSTALLATION, query: 'clockSkewTolerance' })
    expect(code.hits.length).toBeGreaterThanOrEqual(1)
  })

  test('embedding failures degrade to lexical with a flag, never an error', async () => {
    await pool.query(`
      UPDATE memory_feature_settings SET embedding_mode = 'enabled' WHERE installation_id = $1
    `, [INSTALLATION])
    await seedClaim({ installationId: INSTALLATION, key: 'degrade-me', statement: 'Degrade to lexical vitest fact' })
    const embed = {
      provider: 'openai-compatible',
      model: 'embed-small',
      dimensions: 2,
      embed: vi.fn(async () => { throw new Error('provider down') }),
    }
    const result = await createSearchService({ pool, embed, recallEmbeddingTimeoutMs: 500, cursorSigningKey: 'test-cursor-signing-key' })
      .search({ installationId: INSTALLATION, query: 'degrade lexical vitest' })
    expect(result.degradedComponents).toEqual(['embedding'])
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
  })

  test('embedding shadow records usage and rank overlap without changing fused results', async () => {
    const first = await seedClaim({
      installationId: INSTALLATION, key: 'shadow-a', statement: 'Shadow lexical candidate alpha',
    })
    const second = await seedClaim({
      installationId: INSTALLATION, key: 'shadow-b', statement: 'Shadow lexical candidate beta',
    })
    await pool.query(`
      UPDATE memory_feature_settings SET embedding_mode = 'shadow' WHERE installation_id = $1
    `, [INSTALLATION])
    await pool.query(`
      UPDATE claim_search_documents SET embedding = CASE version_id
        WHEN $2::uuid THEN ARRAY[1,0]::real[] ELSE ARRAY[0,1]::real[] END,
        embedding_provider = 'openai-compatible', embedding_model = 'embed-small',
        embedding_dimensions = 2, embedding_status = 'ready'
      WHERE installation_id = $1 AND version_id = ANY($3::uuid[])
    `, [INSTALLATION, second.versionId, [first.versionId, second.versionId]])
    const lexical = await service().search({
      installationId: INSTALLATION, query: 'shadow lexical candidate', limit: 2,
    })
    const embed = {
      provider: 'openai-compatible', model: 'embed-small', dimensions: 2,
      embed: vi.fn(async () => ({ vectors: [[1, 0]], model: 'embed-small', tokens: 5, costMicros: 9 })),
    }
    const shadow = await createSearchService({
      pool, embed, recallEmbeddingTimeoutMs: 500, cursorSigningKey: 'test-cursor-signing-key',
    }).search({ installationId: INSTALLATION, query: 'shadow lexical candidate', limit: 2 })
    expect(shadow.hits.map(hit => hit.versionId)).toEqual(lexical.hits.map(hit => hit.versionId))
    expect(shadow.hits.every(hit => !hit.sources.includes('vector'))).toBe(true)
    expect(shadow.shadowComparison?.topK).toBeGreaterThanOrEqual(1)
    expect(shadow.shadowComparison!.overlapCount).toBeLessThanOrEqual(shadow.shadowComparison!.topK)
    const usage = await pool.query<{ operation: string; embedding_tokens: string; cost_micros: string }>(`
      SELECT operation, embedding_tokens::text, cost_micros::text
      FROM memory_usage_outbox WHERE installation_id = $1
    `, [INSTALLATION])
    expect(usage.rows).toContainEqual({ operation: 'embedding', embedding_tokens: '5', cost_micros: '9' })
  })

  test('cursor pagination walks a stable order', async () => {
    for (let i = 0; i < 4; i++) {
      await seedClaim({
        installationId: INSTALLATION, key: `page-${i}`,
        statement: `Pagination candidate vitest ${i}`,
      })
    }
    const search = service()
    const first = await search.search({ installationId: INSTALLATION, query: 'pagination candidate vitest', limit: 2 })
    expect(first.nextCursor).toBeTruthy()
    const second = await search.search({
      installationId: INSTALLATION, query: 'pagination candidate vitest', limit: 2,
      cursor: first.nextCursor,
    })
    const allIds = [...first.hits.map(hit => hit.versionId), ...second.hits.map(hit => hit.versionId)]
    expect(new Set(allIds).size).toBe(allIds.length)
    const full = await search.search({ installationId: INSTALLATION, query: 'pagination candidate vitest', limit: 10 })
    expect(full.hits.map(hit => hit.versionId)).toEqual(allIds)
    await expect(search.search({
      installationId: INSTALLATION,
      query: 'different query',
      cursor: first.nextCursor,
    })).rejects.toThrow(/invalid_cursor/)
    await expect(search.search({
      installationId: INSTALLATION,
      query: 'pagination candidate vitest',
      cursor: `${first.nextCursor}tampered`,
    })).rejects.toThrow(/invalid_cursor/)
  })

  test('an implicit as_of is frozen in the signed pagination cursor', async () => {
    const initial = new Date('2026-08-25T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(initial)
    try {
      for (let i = 0; i < 4; i++) {
        await seedClaim({
          installationId: INSTALLATION, key: `clock-page-${i}`,
          statement: `Cursor clock candidate vitest ${i}`,
          ...(i === 3 ? { validUntil: new Date(initial.getTime() + 500) } : {}),
        })
      }
      const search = service()
      const fullAtInitial = await search.search({
        installationId: INSTALLATION, query: 'cursor clock candidate vitest', limit: 10,
        asOf: initial,
      })
      const first = await search.search({
        installationId: INSTALLATION, query: 'cursor clock candidate vitest', limit: 2,
      })
      vi.advanceTimersByTime(1_000)
      const second = await search.search({
        installationId: INSTALLATION, query: 'cursor clock candidate vitest', limit: 2,
        cursor: first.nextCursor,
      })
      expect([...first.hits, ...second.hits].map(hit => hit.versionId))
        .toEqual(fullAtInitial.hits.map(hit => hit.versionId))
    } finally {
      vi.useRealTimers()
    }
  })
})
