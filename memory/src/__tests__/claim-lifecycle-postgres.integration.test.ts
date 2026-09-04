import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createClaimRepository } from '../claims/repository.js'
import { createLifecycleService } from '../claims/lifecycle-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '88888888-8888-4888-8888-888888888888'
const EVIDENCE_HANDLE = 'h0-aaaaaaaa'

describeWithDatabase('claim lifecycle transactions (PostgreSQL)', () => {
  let pool: pg.Pool
  let claims: ReturnType<typeof createClaimRepository>
  let lifecycle: ReturnType<typeof createLifecycleService>
  let claimId: string
  let version1: string
  let episodeId: string

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    claims = createClaimRepository(pool)
    lifecycle = createLifecycleService(pool, claims)
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
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1',
              $2::jsonb, $3::jsonb, NOW())
      RETURNING episode_id::text
    `, [INSTALLATION,
      JSON.stringify({ final_outcome: { text: 'Vitest files live next to sources', evidence_handle: EVIDENCE_HANDLE } }),
      JSON.stringify({ [EVIDENCE_HANDLE]: { kind: 'episode' } })])
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
         normalized_key, scope_kind, scope_key, confidence, freshness_at, evidence_handles, status)
      VALUES (gen_random_uuid(), $1, $2, $3, 0, 'repository_convention',
              'Vitest files live next to sources', 'key-1', 'installation', 'global',
              0.9, NOW(), $4::jsonb, 'validated')
      RETURNING candidate_id::text
    `, [INSTALLATION, run.rows[0].run_id, episodeId, JSON.stringify([EVIDENCE_HANDLE])])
    const accepted = await claims.acceptCandidate({
      installationId: INSTALLATION, candidateId: candidate.rows[0].candidate_id, expectedRevision: 1,
    })
    if (!accepted.ok) throw new Error('seed acceptance failed')
    claimId = accepted.claimId
    version1 = accepted.versionId
  })

  test('correction inserts immutable Version N+1 and moves the pointer atomically', async () => {
    const corrected = await lifecycle.correctClaim({
      installationId: INSTALLATION,
      claimId,
      expectedRevision: 1,
      statement: 'Vitest files colocate with sources, never a central tests/ tree',
      evidence: [{
        episodeId,
        evidenceKind: 'episode',
        locator: { key: 'user_correction' },
        excerpt: 'user corrected the convention wording',
        occurredAt: new Date(),
      }],
    })
    expect(corrected.ok).toBe(true)
    if (!corrected.ok) return
    expect(corrected.versionNumber).toBe(2)
    const versions = await pool.query<{
      version_id: string; version_number: string; statement: string
      freshness_at: Date; valid_from: Date | null; valid_until: Date | null
    }>(`
      SELECT version_id::text, version_number::text, statement, freshness_at, valid_from, valid_until
      FROM knowledge_versions
      WHERE claim_id = $1 ORDER BY version_number
    `, [claimId])
    expect(versions.rows.map(row => row.version_number)).toEqual(['1', '2'])
    expect(versions.rows[0].statement).toBe('Vitest files live next to sources')
    expect(versions.rows[1].statement).toContain('central tests/ tree')
    expect(versions.rows[0].valid_until).toBeInstanceOf(Date)
    expect(versions.rows[1].valid_from).toEqual(versions.rows[0].valid_until)
    expect(versions.rows[1].freshness_at).toEqual(versions.rows[1].valid_from)
    const claim = await pool.query<{ current_version_id: string; revision: string; normalized_key: string }>(`
      SELECT current_version_id::text, revision::text, normalized_key FROM knowledge_claims WHERE claim_id = $1
    `, [claimId])
    expect(claim.rows[0].current_version_id).toBe(corrected.versionId)
    expect(Number(claim.rows[0].revision)).toBe(2)
    expect(claim.rows[0].normalized_key).toContain('central tests/ tree')
    // Stale correction attempts now conflict.
    const stale = await lifecycle.correctClaim({
      installationId: INSTALLATION, claimId, expectedRevision: 1,
      statement: 'nope',
      evidence: [{
        episodeId,
        evidenceKind: 'episode',
        locator: {},
        excerpt: 'x',
        occurredAt: new Date(),
      }],
    })
    expect(stale).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
  })

  test('correction rejects evidence whose event belongs to another episode', async () => {
    const foreignEvent = await pool.query<{ source_event_id: string }>(`
      INSERT INTO source_events
        (source_event_id, installation_id, origin, origin_position, session_id, turn_id,
         event_type, occurred_at, payload, payload_hash)
      VALUES (gen_random_uuid(), $1, 'feed', 'foreign-event', 'ses-1', 'foreign-turn',
              'message', NOW(), '{}'::jsonb, sha256('foreign'::bytea))
      RETURNING source_event_id::text
    `, [INSTALLATION])
    const corrected = await lifecycle.correctClaim({
      installationId: INSTALLATION, claimId, expectedRevision: 1,
      statement: 'must not land',
      evidence: [{
        episodeId, evidenceKind: 'event', sourceEventId: foreignEvent.rows[0].source_event_id,
        locator: {}, excerpt: 'foreign', occurredAt: new Date(),
      }],
    })
    expect(corrected).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: 'evidence provenance' } })
    const versions = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_versions WHERE claim_id = $1`, [claimId])
    expect(versions.rows[0].count).toBe(1)
  })

  test('revoke moves active → revoked, drops the search projection and stays idempotent', async () => {
    await pool.query(`
      INSERT INTO claim_search_documents
        (installation_id, version_id, document, embedding_status)
      VALUES ($1, $2, 'Vitest files live next to sources', 'pending')
    `, [INSTALLATION, version1])
    const first = await lifecycle.revokeClaim({
      installationId: INSTALLATION, claimId, expectedRevision: 1,
    })
    expect(first.ok).toBe(true)
    const claim = await pool.query<{ state: string; revision: string }>(`
      SELECT state, revision::text FROM knowledge_claims WHERE claim_id = $1
    `, [claimId])
    expect(claim.rows[0].state).toBe('revoked')
    expect(Number(claim.rows[0].revision)).toBe(2)
    const docs = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents`)
    expect(docs.rows[0].count).toBe(0)
    const feedback = await pool.query<{ action: string }>(`
      SELECT action FROM memory_feedback WHERE claim_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [claimId])
    expect(feedback.rows[0].action).toBe('claim_revoked')
    // Second revoke on the already-revoked claim is an idempotent success.
    const second = await lifecycle.revokeClaim({ installationId: INSTALLATION, claimId })
    expect(second.ok).toBe(true)
  })

  test('supersede points the old claim at its successor', async () => {
    const successor = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'repository_convention', 'installation', 'global',
              'key-successor', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const result = await lifecycle.supersedeClaim({
      installationId: INSTALLATION, claimId,
      supersededByClaimId: successor.rows[0].claim_id,
      expectedRevision: 1,
    })
    expect(result.ok).toBe(true)
    const claim = await pool.query<{ state: string; revision: string; superseded_by_claim_id: string | null }>(`
      SELECT state, revision::text, superseded_by_claim_id::text FROM knowledge_claims WHERE claim_id = $1
    `, [claimId])
    expect(claim.rows[0]).toMatchObject({
      state: 'superseded',
      superseded_by_claim_id: successor.rows[0].claim_id,
      revision: '2',
    })
  })

  test('the database-clock expiry sweep expires due claims without mutating versions', async () => {
    // Make the current version's validity lapse in the past.
    await pool.query(`
      UPDATE knowledge_versions SET valid_until = NOW() - INTERVAL '1 hour'
      WHERE version_id = $1
    `, [version1])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, 'Vitest files live next to sources')
    `, [INSTALLATION, version1])
    const expired = await lifecycle.expireDueClaims()
    expect(expired).toBe(1)
    const claim = await pool.query<{ state: string; revision: string }>(`
      SELECT state, revision::text FROM knowledge_claims WHERE claim_id = $1
    `, [claimId])
    expect(claim.rows[0].state).toBe('expired')
    expect(Number(claim.rows[0].revision)).toBe(2)
    const docs = await pool.query(`SELECT COUNT(*)::int AS count FROM claim_search_documents`)
    expect(docs.rows[0].count).toBe(0)
    const feedback = await pool.query<{ action: string }>(`
      SELECT action FROM memory_feedback WHERE claim_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [claimId])
    expect(feedback.rows[0].action).toBe('claim_expired')
    const version = await pool.query<{ version_number: string; valid_until: Date }>(`
      SELECT version_number::text, valid_until FROM knowledge_versions WHERE version_id = $1
    `, [version1])
    expect(version.rows[0].version_number).toBe('1')
    expect(version.rows[0].valid_until).not.toBeNull()
    // Re-running the sweep is idempotent.
    expect(await lifecycle.expireDueClaims()).toBe(0)
  })
})
