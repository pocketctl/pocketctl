import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSkillAdmissionService } from '../skills/admission-service.js'
import { loadSkillConfig } from '../skills/config.js'
import { createSkillWorker } from '../skills/worker.js'
import { createSkillGenerator } from '../skills/generator.js'
import { createJobRepository } from '../jobs/repository.js'
import type { TextGenerator } from '../ports/text-generator.js'
import type { V2GrantFacts } from '../governance/authorization.js'
import { createPurgeRepository } from '../purge/repository.js'
import { resolveSkillSource } from '../skills/source-resolver.js'
import { persistSkillTask } from '../skills/repository.js'
import {createProviderBudgetStore,withTextProviderBudget} from '../model/provider-budget.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
const url = process.env.MEMORY_TEST_DATABASE_URL, db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
db('Phase 5 fenced Skill worker', () => {
  let pool: pg.Pool
  const config = loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' }), context = { globalMode: 'enabled' as const, sharedMode: 'off' as const, config }
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 8 }); await assertMemoryTestDatabase(pool, url!); await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public'); await applyMemorySchema(pool) }, 60000)
  afterAll(async () => pool?.end())
  beforeEach(async () => pool.query('TRUNCATE memory_installations CASCADE'))
  async function fixture() {
    const installationId = randomUUID(), repositoryId = randomUUID(), snapshotId = randomUUID(), episodeId = randomUUID(), sessionId = randomUUID(), excerpt = 'tests passed', hash = createHash('sha256').update(excerpt).digest('hex').slice(0, 16)
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)VALUES($1,'pocketctl-memory','active','ready',1)`, [installationId])
    await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id)VALUES($1,'personal',$1)`, [installationId])
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)VALUES($1,$2,NOW(),NOW())`, [installationId, sessionId])
    await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at)VALUES($1,$2,$2::uuid::text,NOW(),NOW())`, [installationId, repositoryId])
    await pool.query(`INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at)VALUES($1,$2,$3,$4,NOW())`, [installationId, snapshotId, repositoryId, 'a'.repeat(40)])
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
      VALUES($1,$2,$3,$2::uuid::text,'ready','completed',NOW()-INTERVAL'1s','fixture',$4,$5,decode($6,'hex'),$7,$8,'v1',NOW())`, [installationId, episodeId, sessionId, repositoryId, snapshotId, 'a'.repeat(64),
      { tests: [{ status: 'passed', text: excerpt, evidence_handle: 'e1' }] }, { e1: { kind: 'episode', excerpt_hash: hash, excerpt_length: excerpt.length, truncated: false } }])
    const grant: V2GrantFacts = {
      primaryInstallationId: installationId, configVersion: '1', scopeBindings: [{
        installation_id: installationId,
        owner_scope_kind: 'personal', owner_scope_id: installationId, membership_id: null, membership_revision: '0', authorization_epoch: '1', permissions: ['read', 'contribute']
      }]
    }
    const scheduled = await createSkillAdmissionService({ pool, context }).schedule({ installationId, grant, candidateKey: 'tests', source: { kind: 'episode', episodeId } })
    const jobs = createJobRepository(pool), claim = (await jobs.claimJobs({ workerId: 'skill-worker', limit: 1, leaseMs: 30000 }))[0]!
    return { installationId, episodeId, sessionId, repositoryId, grant, scheduled, jobs, claim, fence: { jobId: claim.job_id, claimedBy: 'skill-worker', claimEpoch: claim.claim_epoch } }
  }
  const doc = () => ({
    schema_version: 'skill-candidate.v1', title: 'Test method', trigger: 'When tests fail', preconditions: ['Repo read'],
    steps: [{ instruction: 'Search source', tool: 'search', permissions: ['repository:read'], operation: 'read' }], validation: ['Run test'], failure_handling: ['Report'], rollback: ['Stop'], source_tokens: ['source-1']
  })
  function worker(response: unknown = { ok: true, value: doc(), usage: { inputTokens: 11, outputTokens: 7, model: 'fixture' } }) {
    const call = vi.fn().mockResolvedValue(response)
    const generator = createSkillGenerator({ provider: { generateJson: call } as TextGenerator, timeoutMs: 100 })
    return { call, handler: createSkillWorker({ pool, context, generator }).handle }
  }
  test('successful generation persists the exact pre-call budget reservation for publication revalidation',async()=>{
    const f=await fixture(),key=`skill-budget-${randomUUID()}`
    const provider=withTextProviderBudget({generateJson:async()=>({ok:true,value:doc(),usage:{inputTokens:11,outputTokens:7,model:'fixture'}})} as TextGenerator,
      createProviderBudgetStore(pool),{key,maxRequests:1,maxInputTokens:100000,maxOutputTokens:100,maxOutputTokensPerRequest:100})
    const handler=createSkillWorker({pool,context,generator:createSkillGenerator({provider,timeoutMs:100})}).handle
    await handler(f.claim,new AbortController().signal,{fence:f.fence})
    const rows=(await pool.query(`SELECT r.state,b.budget_key,b.state AS budget_state,b.actual_input_tokens::int,b.actual_output_tokens::int
      FROM memory_skill_task_runs r JOIN memory_provider_budget_reservations b ON b.reservation_id=r.budget_reservation_id WHERE r.task_id=$1`,[f.scheduled.taskId])).rows
    expect(rows).toEqual([{state:'candidate',budget_key:key,budget_state:'settled',actual_input_tokens:11,actual_output_tokens:7}])
  })
  async function waitForBlockedSession() {
    for (let i = 0; i < 100; i++) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event='advisory' AND query LIKE '%purge:session:%'`)
      if (waiting.rowCount) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('worker did not reach the session lifecycle lock')
  }
  test.each(['compile', 'admission'])('source-first locking permits concurrent %s without deadlock', async (writer) => {
    const f = await fixture(), w = worker(), client = await pool.connect()
    let running: Promise<void> | undefined
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL statement_timeout='3s'`)
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2,0))`, [f.installationId, f.sessionId])
      const request = { installationId: f.installationId, grant: f.grant, source: { kind: 'episode' as const, episodeId: f.episodeId } }
      const resolved = writer === 'admission' ? await resolveSkillSource(client, request, context) : null
      running = w.handler(f.claim, new AbortController().signal, { fence: f.fence })
      // Attach a handler while the controlled transaction is held to prevent unhandled rejection.
      void running.catch(() => undefined)
      await waitForBlockedSession()
      if (writer === 'compile') {
        // Same advisory order and source UPDATE as the episode compiler.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1,0))`, [f.installationId])
        await client.query(`UPDATE work_episodes SET source_digest=decode($2,'hex') WHERE episode_id=$1`, [f.episodeId, 'd'.repeat(64)])
      } else {
        expect(await persistSkillTask(client, { resolved: resolved!, candidateKey: 'tests', grant: f.grant, source: request.source })).toMatchObject({ deduplicated: true })
      }
      await client.query('COMMIT')
      if (writer === 'compile') await expect(running).rejects.toThrow()
      else await running
      expect(w.call).toHaveBeenCalledTimes(writer === 'compile' ? 0 : 1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await running?.catch(() => undefined)
    }
  })
  test.each(['session', 'repository'])('a %s purge during generation fences the late output', async (scope) => {
    const f = await fixture(), w = worker(), purge = createPurgeRepository(pool, { hmacKey: 'fixture-only' })
    w.call.mockImplementationOnce(async () => {
      if (scope === 'session') await purge.purgeSession({ installationId: f.installationId, sessionId: f.sessionId, reason: 'fixture', sourceFeedId: null })
      else await purge.purgeRepository({ installationId: f.installationId, repositoryId: f.repositoryId, reasonCode: 'fixture' })
      return { ok: true, value: doc(), usage: { inputTokens: 1, outputTokens: 1, model: 'fixture' } }
    })
    await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toThrow()
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_jobs WHERE job_type='extract_skill_candidate' AND state='running'`)).rowCount).toBe(0)
  })
  test('a valid candidate at the canonical 32000-character limit commits without retry',async()=>{
    const f=await fixture(),document=doc()
    document.steps=Array.from({length:8},()=>({...document.steps[0]!,instruction:'x'.repeat(3800)}))
    document.trigger='x'.repeat(document.trigger.length+32000-canonicalJsonString(document).length)
    expect(canonicalJsonString(document)).toHaveLength(32000)
    const w=worker({ok:true,value:document,usage:{inputTokens:11,outputTokens:7,model:'fixture'}})
    await w.handler(f.claim,new AbortController().signal,{fence:f.fence})
    expect((await pool.query(`SELECT document FROM memory_skill_archives WHERE task_id=$1`,[f.scheduled.taskId])).rows).toEqual([{document}])
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`,[f.claim.job_id])).rows).toEqual([{state:'completed'}])
    expect(w.call).toHaveBeenCalledTimes(1)
  })
  test('atomically commits Archive, Candidate, Generation Run and job completion', async () => {
    const f = await fixture(), w = worker()
    await w.handler(f.claim, new AbortController().signal, { fence: f.fence })
    expect(w.call).toHaveBeenCalledTimes(1)
    expect((await pool.query(`SELECT state FROM memory_skill_tasks`)).rows).toEqual([{ state: 'candidate' }])
    expect((await pool.query(`SELECT state FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'candidate' }])
    expect((await pool.query(`SELECT state,output_kind,input_tokens::text,output_tokens::text FROM memory_generation_runs WHERE operation='extract_skill_candidate'`)).rows)
      .toEqual([{ state: 'succeeded', output_kind: 'skill_candidate', input_tokens: '11', output_tokens: '7' }])
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(1)
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [f.claim.job_id])).rows).toEqual([{ state: 'completed' }])
  })
  test('source invalidation removes visible content and cancels the head', async () => {
    const f = await fixture(), w = worker()
    await w.handler(f.claim, new AbortController().signal, { fence: f.fence })
    await pool.query(`UPDATE work_episodes SET source_digest=decode($2,'hex') WHERE installation_id=$1`, [f.installationId, 'f'.repeat(64)])
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT state,error_code FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'cancelled', error_code: 'source_invalidated' }])
    expect((await pool.query(`SELECT state FROM memory_skill_tasks`)).rows).toEqual([{ state: 'cancelled' }])
  })
  test('expired un-reclaimed lease and another process holding the task key both block dispatch', async () => {
    let f = await fixture(), w = worker()
    await pool.query(`UPDATE memory_jobs SET claim_expires_at=NOW()-INTERVAL'1s' WHERE job_id=$1`, [f.claim.job_id])
    await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toMatchObject({ kind: 'lost_lease' })
    expect(w.call).not.toHaveBeenCalled()
    await pool.query('TRUNCATE memory_installations CASCADE')
    f = await fixture()
    w = worker()
    const client = await pool.connect(), key = `skill:worker:${f.installationId}:${f.scheduled.taskId}`
    try {
      await client.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [key])
      await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toMatchObject({ code: 'skill_key_busy', kind: 'transient' })
      expect(w.call).not.toHaveBeenCalled()
    }
    finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [key])
      client.release()
    }
  })
  test('lease lost while the Provider responds cannot persist its late result', async () => {
    const f = await fixture(), w = worker()
    w.call.mockImplementationOnce(async () => { await pool.query(`UPDATE memory_jobs SET claim_epoch=claim_epoch+1,state='pending',claimed_by=NULL WHERE job_id=$1`, [f.claim.job_id]); return { ok: true, value: doc(), usage: { inputTokens: 1, outputTokens: 1, model: 'fixture' } } })
    await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toThrow()
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(0)
  })
  test.each(['archive_before', 'archive_after', 'candidate_apply', 'task_cas'])('crash at %s rolls back the entire output transaction and retry recovers', async (point) => {
    const f = await fixture(), w = worker()
    const table = point.startsWith('archive') ? 'memory_skill_archives' : point === 'candidate_apply' ? 'memory_skill_candidates' : 'memory_skill_task_runs'
    const timing = point === 'archive_after' ? 'AFTER' : 'BEFORE', event = point === 'task_cas' ? 'UPDATE' : 'INSERT'
    await pool.query(`CREATE FUNCTION phase5_crash() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF TG_OP='INSERT' THEN RAISE EXCEPTION 'fixture_crash';
      ELSIF NEW.state='candidate' THEN RAISE EXCEPTION 'fixture_crash';END IF;RETURN NEW;END$$`)
    await pool.query(`CREATE TRIGGER phase5_crash ${timing} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION phase5_crash()`)
    try {
      await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toThrow(/fixture_crash/)
      expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
      expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(0)
    }
    finally {
      await pool.query(`DROP TRIGGER phase5_crash ON ${table};DROP FUNCTION phase5_crash()`)
    }
    await pool.query(`UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL WHERE job_id=$1`, [f.claim.job_id])
    const retried = (await f.jobs.claimJobs({ workerId: 'restarted-worker', limit: 1, leaseMs: 30000 }))[0]!
    await w.handler(retried, new AbortController().signal, { fence: { jobId: retried.job_id, claimedBy: 'restarted-worker', claimEpoch: retried.claim_epoch } })
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(1)
    expect(w.call).toHaveBeenCalledTimes(2)
    // A committed duplicate observes the completed candidate without re-generating.
    await w.handler(retried, new AbortController().signal, { fence: { jobId: retried.job_id, claimedBy: 'restarted-worker', claimEpoch: retried.claim_epoch } })
    expect(w.call).toHaveBeenCalledTimes(2)
  })
  test('lost lease and stale generation never call Provider or write candidate', async () => {
    let f = await fixture(), w = worker()
    await pool.query(`UPDATE memory_jobs SET state='pending',claimed_by=NULL WHERE job_id=$1`, [f.claim.job_id])
    await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toThrow()
    expect(w.call).not.toHaveBeenCalled()
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(0)
    await pool.query('TRUNCATE memory_installations CASCADE')
    f = await fixture()
    w = worker()
    await pool.query(`UPDATE memory_skill_tasks SET current_generation=2`)
    await w.handler(f.claim, new AbortController().signal, { fence: f.fence })
    expect(w.call).not.toHaveBeenCalled()
    expect((await pool.query(`SELECT state FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'stale_generation' }])
  })
  test('invalid output is permanently retained without a visible Archive', async () => {
    const f = await fixture(), w = worker({ ok: true, value: { ...doc(), publisher: 'model' }, usage: { inputTokens: 2, outputTokens: 2, model: 'fixture' } })
    await w.handler(f.claim, new AbortController().signal, { fence: f.fence })
    expect((await pool.query(`SELECT state,error_code FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'failed', error_code: 'skill_output_invalid' }])
    expect((await pool.query(`SELECT state,error_code FROM memory_generation_runs WHERE operation='extract_skill_candidate'`)).rows).toEqual([{ state: 'failed', error_code: 'skill_output_invalid' }])
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [f.claim.job_id])).rows).toEqual([{ state: 'dead' }])
    expect((await pool.query(`SELECT error_code FROM memory_dead_letters WHERE job_id=$1`, [f.claim.job_id])).rows).toEqual([{ error_code: 'skill_output_invalid' }])
  })
  test('worker enforces the configured cap even for a replacement generator', async () => {
    const f = await fixture(), provider = vi.fn().mockResolvedValue({ ok: true, value: doc(), usage: { inputTokens: 1, outputTokens: 1, model: 'fixture' } })
    const generator = createSkillGenerator({ provider: { generateJson: provider } as TextGenerator, timeoutMs: 100 })
    await createSkillWorker({ pool, context: { ...context, config: { ...config, maxCandidateChars: 100 } }, generator })
      .handle(f.claim, new AbortController().signal, { fence: f.fence })
    expect((await pool.query(`SELECT state,error_code FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'failed', error_code: 'skill_output_size_exceeded' }])
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
  })
  test('retry exhaustion closes ledgers and re-admission creates a fresh generation', async () => {
    const f = await fixture(), w = worker({ ok: false, code: 'http_error', retryable: true })
    await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toMatchObject({ kind: 'transient' })
    await pool.query(`UPDATE memory_jobs SET attempts=12 WHERE job_id=$1`, [f.claim.job_id])
    expect(await f.jobs.rescheduleJob({ ...f.fence, errorCode: 'http_error' })).toBe(true)
    expect((await pool.query(`SELECT state FROM memory_skill_tasks`)).rows).toEqual([{ state: 'dead' }])
    expect((await pool.query(`SELECT state FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'failed' }])
    expect((await pool.query(`SELECT 1 FROM memory_dead_letters WHERE job_id=$1`, [f.claim.job_id])).rowCount).toBe(1)
    const next = await createSkillAdmissionService({ pool, context }).schedule({ installationId: f.installationId, grant: f.grant,
      candidateKey: 'tests', source: { kind: 'episode', episodeId: f.episodeId } })
    expect(next).toMatchObject({ taskId: f.scheduled.taskId, generation: 2, deduplicated: false })
  })
  test('A to B to A never returns a historical completed generation', async () => {
    const f = await fixture(), w = worker()
    await w.handler(f.claim, new AbortController().signal, { fence: f.fence })
    const otherEpisode = randomUUID()
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,
      repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
      SELECT installation_id,$2,session_id,$2::uuid::text,state,outcome,ready_at,compiler_version,
        repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at
      FROM work_episodes WHERE episode_id=$1`, [f.episodeId, otherEpisode])
    const service = createSkillAdmissionService({ pool, context })
    const base = { installationId: f.installationId, grant: f.grant, candidateKey: 'tests' }
    const second = await service.schedule({ ...base, source: { kind: 'episode', episodeId: otherEpisode } })
    const claim = (await f.jobs.claimJobs({ workerId: 'skill-worker', limit: 1, leaseMs: 30000 }))[0]!
    await w.handler(claim, new AbortController().signal, { fence: { ...f.fence, jobId: claim.job_id, claimEpoch: claim.claim_epoch } })
    const third = await service.schedule({ ...base, source: { kind: 'episode', episodeId: f.episodeId } })
    expect(second.generation).toBe(2)
    expect(third).toMatchObject({ taskId: f.scheduled.taskId, generation: 3, deduplicated: false })
  })
  test('purging an older source session leaves the current generation from another session runnable', async () => {
    const f = await fixture(), w = worker()
    await w.handler(f.claim, new AbortController().signal, { fence: f.fence })
    const episodeId = randomUUID(), sessionId = randomUUID()
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)
      VALUES($1,$2,NOW(),NOW())`, [f.installationId, sessionId])
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,
      repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
      SELECT installation_id,$2,$3,$2::uuid::text,state,outcome,ready_at,compiler_version,
        repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at
      FROM work_episodes WHERE episode_id=$1`, [f.episodeId, episodeId, sessionId])
    const next = await createSkillAdmissionService({ pool, context }).schedule({ installationId: f.installationId, grant: f.grant,
      candidateKey: 'tests', source: { kind: 'episode', episodeId } })
    await createPurgeRepository(pool, { hmacKey: 'fixture-only' }).purgeSession({ installationId: f.installationId, sessionId: f.sessionId, reason: 'fixture', sourceFeedId: null })
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [next.jobId])).rows).toEqual([{ state: 'pending' }])
    const claim = (await f.jobs.claimJobs({ workerId: 'skill-worker', limit: 1, leaseMs: 30000 }))[0]!
    await w.handler(claim, new AbortController().signal, { fence: { ...f.fence, jobId: claim.job_id, claimEpoch: claim.claim_epoch } })
    expect((await pool.query(`SELECT state,current_generation FROM memory_skill_tasks`)).rows).toEqual([{ state: 'candidate', current_generation: '2' }])
  })
  test('transient provider failure leaves the same generation pending for bounded job retry', async () => {
    const f = await fixture(), w = worker({ ok: false, code: 'http_error', retryable: true })
    await expect(w.handler(f.claim, new AbortController().signal, { fence: f.fence })).rejects.toMatchObject({ kind: 'transient' })
    expect((await pool.query(`SELECT state,generation_run_id,error_code FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'pending', generation_run_id: null, error_code: 'http_error' }])
    expect((await pool.query(`SELECT state FROM memory_generation_runs WHERE operation='extract_skill_candidate'`)).rows).toEqual([{ state: 'failed' }])
    expect((await pool.query(`SELECT state FROM memory_jobs WHERE job_id=$1`, [f.claim.job_id])).rows).toEqual([{ state: 'running' }])
  })
  test('off mode and missing Provider complete safely without dispatch', async () => {
    let f = await fixture()
    let h = createSkillWorker({ pool, context: { ...context, config: loadSkillConfig({}) } })
    await h.handle(f.claim, new AbortController().signal, { fence: f.fence })
    expect((await pool.query(`SELECT state,error_code FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'cancelled', error_code: 'skill_disabled' }])
    await pool.query('TRUNCATE memory_installations CASCADE')
    f = await fixture()
    h = createSkillWorker({ pool, context })
    await h.handle(f.claim, new AbortController().signal, { fence: f.fence })
    expect((await pool.query(`SELECT state,error_code FROM memory_skill_task_runs`)).rows).toEqual([{ state: 'failed', error_code: 'skill_provider_unavailable' }])
  })
})
