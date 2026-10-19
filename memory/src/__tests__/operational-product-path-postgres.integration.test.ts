import { createMemoryPool } from '../db.js'
import { createClaimIndexer } from '../retrieval/indexer.js'
import { createSearchService } from '../retrieval/search-service.js'
import { createContextRetrieval } from '../context/retrieval.js'
import { createTrajectoryRepository } from '../context/trajectory-repository.js'
import { createContextSettingsRepository } from '../context/settings-repository.js'
import { createLoadoutRepository } from '../context/loadout-repository.js'
import { createScopeResolver } from '../context/scope-resolver.js'
import { createPackRepository } from '../context/pack-repository.js'
import { createGenerationRunRepository } from '../generation/repository.js'
import { createContextCompiler } from '../context/compiler.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'
import { createAdmissionService } from '../context/admission-service.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createClaimRepository } from '../claims/repository.js'
import { createReviewService } from '../claims/review-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '77777777-7777-4777-8777-777777777777'
const EVIDENCE_HANDLE = 'h0-aaaaaaaa'
const TOMBSTONE_KEY = { version: 'test-v1', key: 'candidate-review-test-key'.repeat(2) }
const EPISODE_DOCUMENT = {
  final_outcome: { text: 'Vitest files live next to sources', evidence_handle: EVIDENCE_HANDLE },
}
const EVIDENCE_MANIFEST = {
  [EVIDENCE_HANDLE]: { kind: 'episode' },
}

describeWithDatabase('operational candidate to Context product path (PostgreSQL)', () => {
  let pool: pg.Pool
  let claims: ReturnType<typeof createClaimRepository>
  let review: ReturnType<typeof createReviewService>
  let candidateId: string
  let episodeId: string

  beforeAll(async () => {
    pool = createMemoryPool({ databaseUrl: databaseUrl!, dbPoolMax: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    claims = createClaimRepository(pool, { tombstoneHmacKeys: [TOMBSTONE_KEY] })
    review = createReviewService(pool, claims)
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
         document, evidence_manifest, compiled_at, source_digest)
      VALUES ($1, gen_random_uuid(), 'ses-1', 'turn-1', 'ready', 'v1', $2::jsonb, $3::jsonb, NOW(), 'x'::bytea)
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

  test('reviewed evidence becomes an indexed immutable claim, selected Context and single-use consumption', async () => {
    await pool.query("INSERT INTO memory_governance_v2_states(installation_id,phase,identity_generation,writer_floor) VALUES($1,'active',2,'identity_v2') ON CONFLICT(installation_id) DO UPDATE SET phase='active',identity_generation=2,writer_floor='identity_v2'",[INSTALLATION])
    const repositoryId = '99999999-9999-4999-8999-999999999999'
    await pool.query(`INSERT INTO repositories(repository_id,installation_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
      VALUES($1,$2,'operational-e2e','https://github.com/pocketctl/operational-e2e-fixture.git',NOW(),NOW()) ON CONFLICT DO NOTHING`,[repositoryId,INSTALLATION])
    await pool.query('UPDATE work_episodes SET repository_id=$2 WHERE episode_id=$1',[episodeId,repositoryId])
    await pool.query("UPDATE memory_candidates SET repository_id=$2::uuid,scope_kind='repository',scope_key=$2::text WHERE candidate_id=$1",[candidateId,repositoryId])
    const queued = (await review.reviewQueue({installationId:INSTALLATION})).find(x=>x.candidate_id===candidateId)!
    expect(queued).toBeDefined()
    const accepted = await review.acceptCandidate({installationId:INSTALLATION,candidateId,
      expectedRevision:Number(queued.revision),expectedHash:queued.content_hash,reviewDurationMs:1500})
    expect(accepted.ok).toBe(true)
    if(!accepted.ok)throw Error('review failed')
    expect((await pool.query('SELECT identity_generation,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[accepted.claimId])).rows[0]).toMatchObject({identity_generation:2,consumption_hold_reason:null})
    const version = (await pool.query('SELECT authority,statement FROM knowledge_versions WHERE version_id=$1',[accepted.versionId])).rows[0]
    expect(version).toMatchObject({authority:'user_accepted',statement:'Vitest files live next to sources'})
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_evidence_capsules WHERE version_id=$1',[accepted.versionId])).rows[0].n).toBeGreaterThan(0)
    await pool.query("INSERT INTO memory_feature_settings(installation_id,embedding_mode,embedding_consent_fingerprint) VALUES($1,'enabled','e2e-fixture') ON CONFLICT(installation_id) DO UPDATE SET embedding_mode='enabled',embedding_consent_fingerprint='e2e-fixture'",[INSTALLATION])
    // Synthetic vectors prove indexing plumbing only, not external provider quality.
    const embed={provider:'fixture',model:'fixture-embedding',dimensions:3,
      embed:async()=>({vectors:[[1,0,0]],model:'fixture-embedding',tokens:8})}
    const indexer=createClaimIndexer({pool,embed,embeddingConsentFingerprint:'e2e-fixture'})
    await indexer.indexVersion(INSTALLATION,accepted.versionId,new AbortController().signal)
    const indexed=(await pool.query('SELECT embedding_status,embedding_dimensions,document FROM claim_search_documents WHERE version_id=$1',[accepted.versionId])).rows[0]
    expect(indexed).toMatchObject({embedding_status:'ready',embedding_dimensions:3})
    expect(indexed.document).toContain(version.statement)
    await createContextSettingsRepository(pool).upsert({installationId:INSTALLATION,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:2000,expectedRevision:1})
    const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'e2e'})
    const packs=createPackRepository(pool)
    const compiler=createContextCompiler({pool,retrieval:createContextRetrieval({pool,search,trajectory:createTrajectoryRepository(pool)}),
      scope:createScopeResolver(pool),loadouts:createLoadoutRepository(pool),settings:createContextSettingsRepository(pool),packs,
      generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
    const result=await compiler.compile({installationId:INSTALLATION,sessionId:'ses-1',clientRequestId:'product-path',agent:'codex',
      adapterCapability:'native_hidden_v1',repositoryId,query:'Vitest files sources',requestKey:{keyId:'e2e',hmacKey:Buffer.alloc(32,4)}})
    expect(result.kind).toBe('ready')
    if(result.kind!=='ready')throw Error('context not ready')
    const items=await pool.query('SELECT version_id,claim_id FROM memory_context_pack_items WHERE pack_id=$1',[result.packId])
    expect(items.rows).toContainEqual(expect.objectContaining({version_id:accepted.versionId,claim_id:accepted.claimId}))
    const admission=createAdmissionService({pool,nonceHmacKey:Buffer.alloc(32,5)})
    const ticket=await admission.admit({installationId:INSTALLATION,sessionId:'ses-1',clientRequestId:'product-path',packId:result.packId,
      agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1'})
    expect(ticket.ok).toBe(true)
    if(!ticket.ok||!('nonce' in ticket))throw Error('admission failed')
    const input={installationId:INSTALLATION,sessionId:'ses-1',packId:result.packId,injectionId:ticket.injectionId,nonce:ticket.nonce}
    const consumed=await admission.consume(input)
    expect(consumed.ok).toBe(true)
    if(!consumed.ok)throw Error('consume failed')
    expect(consumed.pack.stableText+consumed.pack.dynamicText).toContain(version.statement)
    expect(await admission.consume(input)).toEqual({ok:false,error:'already_consumed'})
  })
})
