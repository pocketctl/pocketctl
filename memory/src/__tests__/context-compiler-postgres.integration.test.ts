import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
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
import {createAdmissionService} from '../context/admission-service.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'dededede-dede-4ded-8ded-dededededede'
const REPOSITORY = 'edededed-eded-4ded-8ded-edededededed'
const KEY = { keyId: 'k1', hmacKey: Buffer.alloc(32, 3) }

describeWithDatabase('context pack compilation (PostgreSQL)', () => {
  let pool: pg.Pool
  let compiler: ReturnType<typeof createContextCompiler>
  let packs: ReturnType<typeof createPackRepository>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    const search = createSearchService({ pool, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'k' })
    const trajectory = createTrajectoryRepository(pool)
    const policyRepository = createPolicyRepository(pool)
    const policyResolver = createPolicyResolver({ pool, repository: policyRepository })
    packs = createPackRepository(pool)
    compiler = createContextCompiler({
      pool,
      retrieval: createContextRetrieval({ pool, search, trajectory }),
      scope: createScopeResolver(pool),
      loadouts: createLoadoutRepository(pool),
      settings: createContextSettingsRepository(pool),
      packs,
      generation: createGenerationRunRepository(pool),
      policyResolver,
    })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_context_feedback, memory_context_injections,
               memory_context_pack_evidence, memory_context_pack_items,
               memory_context_packs, memory_generation_run_policies,
               memory_generation_runs, memory_retrieval_candidates,
               memory_retrieval_stages, memory_retrieval_trajectories,
               claim_search_documents, knowledge_evidence, knowledge_versions,
               knowledge_claims, work_episodes, source_turns, source_events,
               source_sessions, memory_context_loadout_items,
               memory_context_loadouts, memory_context_settings,
               memory_feature_settings, repositories, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO repositories
        (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
      VALUES ($1, $2, 'compiler-fixture', NOW(), NOW())
    `, [REPOSITORY, INSTALLATION])
    await pool.query(`
      INSERT INTO source_sessions (installation_id, session_id, first_recorded_at, last_recorded_at)
      VALUES ($1, 'ses-c', NOW(), NOW())
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO work_episodes
        (installation_id, episode_id, session_id, turn_id, state, compiler_version,
         source_digest, document, evidence_manifest, document_compiler_version, compiled_at)
      VALUES ($1, gen_random_uuid(), 'ses-c', 'turn-1', 'ready', 'c',
              decode(md5('c'),'hex'), '{}'::jsonb, '{}'::jsonb, 'd', NOW())
    `, [INSTALLATION])
    await createContextSettingsRepository(pool).upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'enabled', maxTokens: null, expectedRevision: 1,
    })
  })

  async function seedClaim(input: { key: string; statement: string; claimType?: string }): Promise<void> {
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, $2, 'repository', $4, $3, 'active')
      RETURNING claim_id::text
    `, [INSTALLATION, input.claimType ?? 'repository_convention', input.key, REPOSITORY])
    const version = await pool.query<{ version_id: string }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority,
         confidence, freshness_at, repository_id)
      VALUES (gen_random_uuid(), $1, $2, 1, $3, 'user_accepted', 0.9, NOW(), $4)
      RETURNING version_id::text
    `, [INSTALLATION, claim.rows[0].claim_id, input.statement, REPOSITORY])
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, version.rows[0].version_id])
    const episode = await pool.query<{ episode_id: string }>(
      `SELECT episode_id::text FROM work_episodes LIMIT 1`)
    await pool.query(`
      INSERT INTO knowledge_evidence
        (evidence_id, installation_id, version_id, episode_id, evidence_kind, excerpt, excerpt_hash, occurred_at, ordinal)
      VALUES (gen_random_uuid(), $1, $2, $3, 'episode', 'x', sha256(convert_to('x','utf8')), NOW(), 0)
    `, [INSTALLATION, version.rows[0].version_id, episode.rows[0].episode_id])
    await pool.query(`
      INSERT INTO claim_search_documents (installation_id, version_id, document)
      VALUES ($1, $2, $3)
    `, [INSTALLATION, version.rows[0].version_id, input.statement])
  }

  test('enabled mode with a probed adapter persists a ready pack atomically', async () => {
    await seedClaim({ key: 'auth-path', statement: 'Web obtains capability grant before memory access grant compile' })
    const outcome = await compiler.compile({
      installationId: INSTALLATION, sessionId: 'ses-c', clientRequestId: 'cr-1',
      agent: 'codex', adapterCapability: 'native_hidden_v1',
      repositoryId: REPOSITORY, query: 'capability grant memory access', requestKey: KEY,
    })
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    const stored = await packs.get(outcome.packId)
    expect(stored).not.toBeNull()
    expect(stored!.state).toBe('ready')
    expect(stored!.stable_tokens + stored!.dynamic_tokens).toBeLessThanOrEqual(2000)
    // Items and their evidence references committed with the pack.
    const itemCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memory_context_pack_items WHERE pack_id = $1`, [outcome.packId])
    expect(itemCount.rows[0].n).toBe(outcome.itemCount)
    const evidenceCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memory_context_pack_evidence WHERE pack_id = $1`, [outcome.packId])
    expect(evidenceCount.rows[0].n).toBeGreaterThanOrEqual(outcome.itemCount)
    // The generation run completed with the pack as its output reference.
    const run = await pool.query<{ state: string; output_kind: string }>(`
      SELECT state, output_kind FROM memory_generation_runs
      WHERE installation_id = $1 AND operation = 'compile_context'
    `, [INSTALLATION])
    expect(run.rows[0]).toMatchObject({ state: 'succeeded', output_kind: 'context_pack' })
  })

  test('compilation is deterministic: identical inputs yield the same pack row', async () => {
    await seedClaim({ key: 'det-1', statement: 'deterministic compile marker for identical inputs' })
    const request = {
      installationId: INSTALLATION, sessionId: 'ses-c', clientRequestId: 'cr-det',
      agent: 'codex', adapterCapability: 'native_hidden_v1' as const,
      repositoryId: REPOSITORY, query: 'deterministic compile marker', requestKey: KEY,
    }
    const first = await compiler.compile(request)
    const second = await compiler.compile(request)
    expect(first.kind).toBe('ready')
    expect(second.kind).toBe('ready')
    // Same (session, client request, policy, input) — the unique active pack.
    const rows = await pool.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM memory_context_packs
      WHERE session_id = 'ses-c' AND client_request_id = 'cr-det' AND state <> 'invalidated'
    `)
    expect(rows.rows[0].n).toBe(1)
  })

  test('mode off persists nothing', async () => {
    await createContextSettingsRepository(pool).upsert({
      installationId: INSTALLATION, scopeKind: 'installation', scopeKey: 'global',
      agent: null, mode: 'off', maxTokens: null, expectedRevision: 1,
    })
    const outcome = await compiler.compile({
      installationId: INSTALLATION, sessionId: 'ses-c', clientRequestId: 'cr-off',
      agent: 'codex', adapterCapability: 'native_hidden_v1',
      repositoryId: REPOSITORY, query: 'anything', requestKey: KEY,
    })
    expect(outcome).toEqual({ kind: 'off' })
    const packs = await pool.query(`SELECT COUNT(*)::int AS n FROM memory_context_packs`)
    expect(packs.rows[0].n).toBe(0)
  })
  test('consumption metadata changes create a new compilation generation instead of replaying a ready pack',async()=>{
    await seedClaim({key:'metadata-generation',statement:'metadata generation marker'})
    const request={installationId:INSTALLATION,sessionId:'ses-c',clientRequestId:'cr-generation',agent:'codex',adapterCapability:'native_hidden_v1' as const,repositoryId:REPOSITORY,query:'metadata generation marker',requestKey:KEY}
    const first=await compiler.compile(request)
    expect(first.kind).toBe('ready')
    await pool.query("UPDATE knowledge_claims SET consumption_hold_reason='identity_requires_review' WHERE installation_id=$1",[INSTALLATION])
    const held=await compiler.compile(request)
    expect(held.kind).toBe('empty')
    await pool.query('UPDATE knowledge_claims SET consumption_hold_reason=NULL WHERE installation_id=$1',[INSTALLATION])
    const resumed=await compiler.compile(request)
    expect(resumed.kind).toBe('ready')
    if(first.kind==='ready'&&resumed.kind==='ready')expect(resumed.packId).not.toBe(first.packId)
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_generation_runs')).rows[0].n).toBe(3)
  })
  test('a source mutation between retrieval and persistence returns retryable degradation and no ready pack',async()=>{
    await seedClaim({key:'concurrent-source',statement:'concurrent source marker'})
    const persist=packs.persist.bind(packs)
    const boundary=vi.spyOn(packs,'persist').mockImplementationOnce(async input=>{
      await pool.query("UPDATE knowledge_claims SET consumption_hold_reason='fixture_hold' WHERE installation_id=$1",[INSTALLATION])
      return persist(input)
    })
    try{
      expect(await compiler.compile({installationId:INSTALLATION,sessionId:'ses-c',clientRequestId:'cr-race',agent:'codex',adapterCapability:'native_hidden_v1',repositoryId:REPOSITORY,query:'concurrent source marker',requestKey:KEY})).toEqual({kind:'degraded',reason:'context_consumption_changed'})
      expect((await pool.query("SELECT 1 FROM memory_context_packs WHERE state='ready'")).rowCount).toBe(0)
      expect((await pool.query("SELECT state,error_code FROM memory_generation_runs WHERE operation='compile_context'")).rows[0]).toEqual({state:'failed',error_code:'context_consumption_changed'})
    }finally{boundary.mockRestore()}
  })

  test.each(['repository', 'snapshot'])('a tombstoned %s cannot mint a fresh Context pack', async tombstone => {
    await seedClaim({key:'deleted-source',statement:'deleted source applicability marker'})
    const claim=(await pool.query('SELECT claim_id,current_version_id FROM knowledge_claims WHERE installation_id=$1',[INSTALLATION])).rows[0]
    const snapshot=crypto.randomUUID(),commit='b'.repeat(40)
    await pool.query("UPDATE repositories SET canonical_remote='https://example.test/fixture.git' WHERE repository_id=$1",[REPOSITORY])
    await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[INSTALLATION,REPOSITORY,snapshot,commit])
    const app={scopeKind:'branch',scopeKey:'main',canonicalRepositoryKey:'example.test/fixture',repositoryId:REPOSITORY,snapshotId:snapshot,branch:'main',status:'verified'}
    await pool.query("UPDATE knowledge_claims SET scope_kind='branch',scope_key='main',canonical_repository_key=$2 WHERE claim_id=$1",[claim.claim_id,app.canonicalRepositoryKey])
    await pool.query("UPDATE knowledge_versions SET repo_snapshot_id=$2,branch='main',applicability=$3 WHERE version_id=$1",[claim.current_version_id,snapshot,app])
    if(tombstone==='repository')await pool.query("INSERT INTO memory_repository_tombstones(installation_id,repository_id,reason_code) VALUES($1,$2,'fixture')",[INSTALLATION,REPOSITORY])
    else await pool.query("INSERT INTO memory_source_snapshot_tombstones(installation_id,snapshot_id,repository_id,commit_sha,reason_code) VALUES($1,$2,$3,$4,'fixture')",[INSTALLATION,crypto.randomUUID(),REPOSITORY,commit])
    // Registry rows remain: deletion proof must survive a fresh generation and omitted commit hint.
    const outcome=await compiler.compile({installationId:INSTALLATION,sessionId:'ses-c',clientRequestId:'cr-tomb-'+tombstone,agent:'codex',adapterCapability:'native_hidden_v1',repositoryId:REPOSITORY,branch:'main',query:'deleted source applicability marker',requestKey:KEY})
    expect(outcome.kind).toBe('empty')
    expect((await pool.query("SELECT 1 FROM memory_context_packs WHERE state='ready'")).rowCount).toBe(0)
  })

  test.each(['branch','snapshot','task'])('explicit %s applicability is retained in the frozen pack query context',async scopeKind=>{
    await seedClaim({key:'frozen-'+scopeKind,statement:'frozen applicability marker'})
    const claim=(await pool.query('SELECT claim_id,current_version_id FROM knowledge_claims WHERE installation_id=$1',[INSTALLATION])).rows[0]
    const snapshot=crypto.randomUUID(),commit='a'.repeat(40),scopeKey=scopeKind==='branch'?'main':scopeKind==='snapshot'?snapshot:'task-a'
    await pool.query("UPDATE repositories SET canonical_remote='https://example.test/fixture.git' WHERE repository_id=$1",[REPOSITORY])
    await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[INSTALLATION,REPOSITORY,snapshot,commit])
    const app={scopeKind,scopeKey,canonicalRepositoryKey:'example.test/fixture',repositoryId:REPOSITORY,snapshotId:snapshot,branch:'main',status:'verified'}
    await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3,canonical_repository_key=$4 WHERE claim_id=$1',[claim.claim_id,scopeKind,scopeKey,app.canonicalRepositoryKey])
    await pool.query("UPDATE knowledge_versions SET repo_snapshot_id=$2,branch='main',applicability=$3 WHERE version_id=$1",[claim.current_version_id,snapshot,app])
    const outcome=await compiler.compile({installationId:INSTALLATION,sessionId:'ses-c',clientRequestId:'cr-frame-'+scopeKind,agent:'codex',adapterCapability:'native_hidden_v1',repositoryId:REPOSITORY,commitSha:commit,branch:'main',taskScopeKey:scopeKind==='task'?'task-a':null,query:'frozen applicability marker',requestKey:KEY})
    expect(outcome.kind).toBe('ready')
    if(outcome.kind!=='ready')return
    const admission=createAdmissionService({pool,nonceHmacKey:Buffer.alloc(32,7)})
    expect((await admission.admit({installationId:INSTALLATION,sessionId:'ses-c',clientRequestId:'cr-frame-'+scopeKind,packId:outcome.packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1'})).ok).toBe(true)
  })
})
