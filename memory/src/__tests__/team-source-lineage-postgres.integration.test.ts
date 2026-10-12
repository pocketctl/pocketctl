import {teamOriginalRoot,independentSourceCount} from '../episodes/source-lineage.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createExtractionRepository } from '../extraction/repository.js'
import { createJobRepository } from '../jobs/repository.js'
import { StaleJobFenceError } from '../generation/fence.js'
import { createCandidateExtractor } from '../extraction/extractor.js'
import { createCandidateDeduper } from '../extraction/deduper.js'
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

  const reserve = async (promptVersion='prompt-v1', installationId=INSTALLATION, digest=SOURCE_DIGEST, policy=Buffer.alloc(16,1)) => {
    const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1 LIMIT 1',[installationId])).rows[0]
    return store.reserveRun({installationId,episodeId:episode.episode_id,sourceDigest:digest,extractorVersion:'lineage-v1',promptVersion,modelConfigHash:Buffer.alloc(32,2),mode:'enabled',provider:'fixture',model:'small',staleAfterMs:60000,effectivePolicyHash:policy})
  }
  test('one authorized source/policy/model/prompt dispatch has one owner under concurrency',async()=>{
    const runs=await Promise.all([reserve(),reserve()]);expect(runs.filter(r=>r.owner)).toHaveLength(1);expect(new Set(runs.map(r=>r.runId)).size).toBe(1)
  })
  test('prompt version change creates new work rather than reusing incompatible output',async()=>{
    expect((await reserve()).owner).toBe(true);expect((await reserve('prompt-v2')).owner).toBe(true)
  })
  test('policy change creates independently attributable work',async()=>{
    expect((await reserve()).owner).toBe(true);expect((await reserve('prompt-v1',INSTALLATION,SOURCE_DIGEST,Buffer.alloc(16,3))).owner).toBe(true)
  })
  test('revoked source cannot reuse a previously reserved run',async()=>{
    await reserve();await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[INSTALLATION]);expect(await reserve()).toMatchObject({owner:false,sourceUnavailable:true,runId:''})
  })
  test('purged session cannot serve a cached or running source result',async()=>{
    await reserve();await pool.query("UPDATE source_sessions SET deleted_at=NOW() WHERE installation_id=$1",[INSTALLATION]);expect(await reserve()).toMatchObject({owner:false,sourceUnavailable:true,runId:''})
  })
  test('equal packets in separate authorized installations are never reused across readers',async()=>{
    const other='33333333-3333-4333-8333-333333333333'
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[other])
    await pool.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')",[other])
    await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'reader-copy',NOW(),NOW())",[other])
    await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,document,evidence_manifest,document_compiler_version,compiled_at) SELECT $1,gen_random_uuid(),'reader-copy','reader-turn',state,compiler_version,source_digest,document,evidence_manifest,document_compiler_version,compiled_at FROM work_episodes WHERE installation_id=$2",[other,INSTALLATION])
    expect((await reserve()).owner).toBe(true);expect((await reserve('prompt-v1',other)).owner).toBe(true)
  })
  test('reader replicas share original call lineage but retain separate authorization domains',()=>{
    const a={source_kind:'team_session',team_id:'team',team_session_id:'session',team_call_id:'call',read_scope:{participant_user_id:1}}
    const b={...a,read_scope:{participant_user_id:2}}
    expect(teamOriginalRoot(a)).toBe(teamOriginalRoot(b))
    expect(independentSourceCount([{episodeId:'a',sessionId:'a',sourceRootIds:[teamOriginalRoot(a)!]},{episodeId:'b',sessionId:'b',sourceRootIds:[teamOriginalRoot(b)!]}])).toBe(1)
  })
})
