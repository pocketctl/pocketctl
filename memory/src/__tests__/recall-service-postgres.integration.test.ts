import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createRecallService } from '../retrieval/recall-service.js'
import { createSearchService } from '../retrieval/search-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describeWithDatabase('recall bundle assembly (PostgreSQL)', () => {
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
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id) VALUES ($1)
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
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, outcome, compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'completed', 'v1', NOW())
    `, [INSTALLATION])
  })

  async function seedClaim(statement: string, key: string): Promise<{ claimId: string; versionId: string }> {
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'bug_root_cause', 'installation', 'global', $2, 'active')
      RETURNING claim_id::text
    `, [INSTALLATION, key])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 0.9)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id, statement])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    const episode = await pool.query<{ episode_id: string }>(`
      SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, 'episode', $4,
              sha256(convert_to($4, 'utf8')), NOW(), 0)
    `, [INSTALLATION, version.rows[0].version_id, episode.rows[0].episode_id, `evidence ${key}`])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, $3)
    `, [INSTALLATION, version.rows[0].version_id, statement])
    return { claimId: claim.rows[0].claim_id, versionId: version.rows[0].version_id }
  }

  function recallService() {
    return createRecallService(pool, createSearchService({
      pool,
      recallEmbeddingTimeoutMs: 500,
      cursorSigningKey: 'test-cursor-signing-key',
    }))
  }

  test('assembles bounded claims with evidence, episodes and a request id', async () => {
    await seedClaim('Login flake root cause was JWT clock skew', 'clock-skew')
    const result = await recallService().recall({
      installationId: INSTALLATION, query: 'login flake clock skew',
    })
    expect(result.requestId).toBeTruthy()
    expect(result.claims.length).toBe(1)
    const claim = result.claims[0]
    expect(claim.statement).toContain('clock skew')
    expect(claim.evidence.length).toBeGreaterThanOrEqual(1)
    expect(claim.evidence[0].excerpt).toContain('evidence clock-skew')
    expect(result.relatedEpisodes.length).toBe(1)
    expect(result.relatedEpisodes[0].sessionId).toBe('ses-1')
    expect(result.coverageGaps).toEqual([])
    expect(result.totalChars).toBeLessThanOrEqual(12_000)
  })

  test('evidence per claim respects maxEvidencePerClaim', async () => {
    const seeded = await seedClaim('Multi evidence claim about vitest colocation', 'multi-evidence')
    const episode = await pool.query<{ episode_id: string }>(`
      SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [INSTALLATION])
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      await pool.query(`
        INSERT INTO knowledge_evidence
          (evidence_id, installation_id, version_id, episode_id, evidence_kind,
           excerpt, excerpt_hash, occurred_at, ordinal)
        VALUES (gen_random_uuid(), $1, $2, $3, 'episode', $4,
                sha256(convert_to($4, 'utf8')), NOW(), $5)
      `, [INSTALLATION, seeded.versionId, episode.rows[0].episode_id, `extra evidence ${ordinal}`, ordinal])
    }
    const result = await recallService().recall({
      installationId: INSTALLATION, query: 'multi evidence vitest',
      maxEvidencePerClaim: 2,
    })
    expect(result.claims[0].evidence.length).toBe(2)
  })

  test('the character budget truncates evidence deterministically', async () => {
    await seedClaim('Budget claim vitest with long evidence lines', 'budget')
    const episode = await pool.query<{ episode_id: string }>(`
      SELECT episode_id::text FROM work_episodes WHERE installation_id = $1 LIMIT 1
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind,
         excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1,
              (SELECT version_id FROM knowledge_versions WHERE installation_id = $1 LIMIT 1),
              $2, 'episode', $3, sha256(convert_to($3, 'utf8')), NOW(), 1)
    `, [INSTALLATION, episode.rows[0].episode_id, 'x'.repeat(900)])
    const result = await recallService().recall({
      installationId: INSTALLATION, query: 'budget claim vitest',
      maxChars: 1_200,
    })
    expect(result.totalChars).toBe(JSON.stringify(result).length)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_200)
    const truncated = result.claims[0].evidence.find(evidence => evidence.truncated)
    if (truncated) expect(truncated.excerpt.length).toBeLessThan(900)
  })

  test('no matches yields a coverage gap, not an error', async () => {
    const result = await recallService().recall({
      installationId: INSTALLATION, query: 'completely unrelated quantum computing',
    })
    expect(result.claims).toEqual([])
    expect(result.coverageGaps).toContain('no_matching_active_claims')
  })

  test('recall performs no model calls (embedding mode off)', async () => {
    await seedClaim('No model calls during recall vitest', 'no-model')
    const result = await recallService().recall({
      installationId: INSTALLATION, query: 'no model calls vitest',
    })
    expect(result.degradedComponents).toEqual([])
    expect(result.claims.length).toBe(1)
  })
})
