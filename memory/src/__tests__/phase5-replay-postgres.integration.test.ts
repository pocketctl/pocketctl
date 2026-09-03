import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSkillGovernanceFixture, skillFixtureDocument } from '../testing/skill-fixture.js'
import { createSkillReviewService } from '../skills/review-service.js'
import { createSkillReplayService } from '../skills/replay-service.js'
import { SKILL_REPLAY_RUNNER_VERSION, replayTextHash, runRecordedReplayCase, type ReplayCase, type SkillReplayRunner } from '../skills/replay-runner.js'
import { loadSkillConfig } from '../skills/config.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createReviewPolicyRepository, DEFAULT_TEAM_REVIEW_POLICY } from '../governance/review-policy.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const context = { globalMode: 'enabled' as const, sharedMode: 'shadow' as const, config: loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' }) }
db('Phase 5 durable offline Replay', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    const client = await pool.connect()
    try {
      for (const migration of MEMORY_MIGRATIONS.filter(m => m.version <= 33)) {
        await client.query('BEGIN')
        for (const statement of migration.statements) await client.query(statement)
        await client.query('INSERT INTO memory_schema_migrations(version)VALUES($1)', [migration.version])
        await client.query('COMMIT')
      }
    } finally { client.release() }
  }, 60000)
  afterAll(async () => pool?.end())
  beforeEach(async () => pool.query('TRUNCATE memory_installations CASCADE'))
  async function fixture(kind: 'personal' | 'team' = 'personal') {
    const f = await createSkillGovernanceFixture(pool, context, kind)
    if (kind === 'team') await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version,repository_id,repo_snapshot_id)
      VALUES($1,$2,$3,$2::uuid::text,'ready','completed','fixture',$4,$5)`, [f.installationId,randomUUID(),f.sessionId,f.repositoryId,f.snapshotId])
    const draft = await createSkillReviewService({ pool, context }).execute(f.author, { action: 'draft', candidateId: f.candidateId, expectedRevision: 0 })
    const v = (await pool.query(`SELECT document_hash,policy_hash FROM memory_skill_versions WHERE version_id=$1`, [draft.versionId])).rows[0]
    const doc = skillFixtureDocument()
    const cases: ReplayCase[] = (['historical_session','golden_task'] as const).map((caseKind,i) => ({
      schema_version: 'skill-replay-case.v1', case_id: `case-${i}`, kind: caseKind, provenance: 'fixture',
      installation_id: f.installationId, repository_id: f.repositoryId, repo_snapshot_id: f.snapshotId,
      version_id: draft.versionId, policy_hash: v.policy_hash, document_hash: v.document_hash,
      reference_id: i === 0 ? f.sessionId : 'golden-method-1',
      steps: [{ step_index: 0, tool: doc.steps[0].tool, operation: doc.steps[0].operation,
        instruction_hash: replayTextHash(doc.steps[0].instruction), response: { matches: 2 } }],
      assertions: [{ assertion_id: 'found-match', validation_index: 0, validation_hash: replayTextHash(doc.validation[0]),
        step_index: 0, path: ['matches'], operator: 'equals', expected: 2 }],
    }))
    const loadCases = vi.fn(async (input: { caseIds: string[] }) => cases.filter(c => input.caseIds.includes(c.case_id)))
    const run = vi.fn(runRecordedReplayCase)
    const runner: SkillReplayRunner = { version: SKILL_REPLAY_RUNNER_VERSION, run }
    const service = createSkillReplayService({ pool, context, cases: { loadCases }, runner })
    const request = { skillId: draft.skillId, versionId: draft.versionId, expectedRevision: draft.revision, caseIds: cases.map(c => c.case_id), idempotencyKey: 'replay-1' }
    return { ...f, draft, cases, request, service, runner, run, loadCases }
  }
  test('migration 34 preserves governed versions; both case kinds pass with zero natural executions', async () => {
    const f = await fixture()
    await applyMemorySchema(pool); await applyMemorySchema(pool)
    expect((await pool.query(`SELECT MAX(version) AS version FROM memory_schema_migrations`)).rows[0].version).toBe(46)
    const result = await f.service.execute(f.author, f.request)
    expect(result).toMatchObject({ state: 'passed', eligible: true, naturalExecutionCount: 0,
      kinds: { historical_session: { total: 1, passed: 1 }, golden_task: { total: 1, passed: 1 } } })
    expect(f.run).toHaveBeenCalledTimes(2)
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_runs WHERE state='passed'`)).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_cases WHERE state='passed'`)).rowCount).toBe(2)
    expect(JSON.stringify((await pool.query(`SELECT * FROM memory_skill_replay_cases`)).rows)).not.toContain('matches')
    await f.service.execute(f.author, f.request)
    expect(f.run).toHaveBeenCalledTimes(2)
  })
  test('a failing case and a missing case kind cannot borrow previous success', async () => {
    const f = await fixture()
    await f.service.execute(f.author, f.request)
    f.cases[1].assertions[0].expected = 3
    const failed = await f.service.execute(f.author, { ...f.request, idempotencyKey: 'replay-failed' })
    expect(failed).toMatchObject({ state: 'failed', eligible: false, kinds: { golden_task: { failed: 1 } } })
    expect(await f.service.getEvidence(f.author, { skillId: f.draft.skillId, versionId: f.draft.versionId, expectedRevision: 1 })).toMatchObject({ runId: failed.runId, eligible: false })
    const partial = await f.service.execute(f.author, { ...f.request, idempotencyKey: 'partial', caseIds: ['case-0'] })
    expect(partial).toMatchObject({ state: 'failed', eligible: false, errorCode: 'missing_case_kind', kinds: { golden_task: { total: 0 } } })
  })
  test('untrusted response/assertion submission, reader dispatch and wrong case binding are denied before run', async () => {
    const f = await fixture('team'), reader = await f.actor(['reader'], ['read'])
    await expect(f.service.execute(f.author, { ...f.request, passed: true, cases: f.cases })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(f.service.execute(reader, f.request)).rejects.toMatchObject({ code: 'forbidden' })
    for (const field of ['installation_id','version_id','repository_id','repo_snapshot_id'] as const) {
      const original = f.cases[0][field]; f.cases[0][field] = randomUUID()
      await expect(f.service.execute(f.author, f.request)).rejects.toMatchObject({ code: 'case_invalid' })
      f.cases[0][field] = original
    }
    expect(f.run).not.toHaveBeenCalled()
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_runs`)).rowCount).toBe(0)
  })
  test('editing the Skill or policy invalidates historical replay eligibility', async () => {
    const f = await fixture('team')
    await f.service.execute(f.author, f.request)
    const policies = createReviewPolicyRepository(pool), head = (await policies.getHead(f.installationId))!
    await policies.publishVersion({ installationId: f.installationId, expectedRevision: head.revision, createdByMembershipId: null, document: { ...DEFAULT_TEAM_REVIEW_POLICY, minimum_approvals: 2 } })
    await expect(f.service.getEvidence(f.author, { skillId: f.draft.skillId, versionId: f.draft.versionId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'policy_changed' })
    await createSkillReviewService({ pool, context }).execute(f.author, { action: 'edit', skillId: f.draft.skillId, expectedRevision: 1, document: { ...skillFixtureDocument(), title: 'Changed' } })
    await expect(f.service.execute(f.author, { ...f.request, idempotencyKey: 'old' })).rejects.toMatchObject({ code: 'version_conflict' })
  })
  test.each(['revoke','delete','edit','abort'])('%s while the runner is active prevents late success', async (action) => {
    const f = await fixture('team'), controller = new AbortController()
    f.run.mockImplementationOnce(async (input, signal) => {
      expect((await pool.query(`SELECT 1 FROM memory_skill_replay_runs WHERE state='running'`)).rowCount).toBe(1)
      if (action === 'revoke') await pool.query(`UPDATE memory_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1`, [f.author.membershipId])
      if (action === 'delete') await pool.query(`DELETE FROM work_episodes WHERE episode_id=$1`, [f.episodeId])
      if (action === 'edit') await createSkillReviewService({ pool, context }).execute(f.author, { action: 'edit', skillId: f.draft.skillId, expectedRevision: 1, document: { ...skillFixtureDocument(), title: 'Edited during replay' } })
      if (action === 'abort') controller.abort()
      return runRecordedReplayCase(input, signal)
    })
    await expect(f.service.execute(f.author, f.request, controller.signal)).rejects.toThrow()
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_runs WHERE state='passed'`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_cases WHERE state='passed'`)).rowCount).toBe(0)
    if (action !== 'delete') expect((await pool.query(`SELECT state FROM memory_skill_replay_runs`)).rows).toEqual([{ state: 'cancelled' }])
  })
  test('purging a historical replay Session removes the whole run without deleting unrelated Skill source', async () => {
    const f = await fixture(), historySession = randomUUID()
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)VALUES($1,$2,NOW(),NOW())`, [f.installationId,historySession])
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version,repository_id,repo_snapshot_id)
      VALUES($1,$2,$3,$2::uuid::text,'ready','completed','fixture',$4,$5)`, [f.installationId,randomUUID(),historySession,f.repositoryId,f.snapshotId])
    f.cases[0].reference_id = historySession
    await f.service.execute(f.author, f.request)
    await createPurgeRepository(pool, { hmacKey: 'fixture-only' }).purgeSession({ installationId: f.installationId, sessionId: historySession, reason: 'fixture', sourceFeedId: null })
    expect((await pool.query(`SELECT 1 FROM memory_skill_versions WHERE version_id=$1`, [f.draft.versionId])).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_runs`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_cases`)).rowCount).toBe(0)
    await expect(f.service.execute(f.author, f.request)).rejects.toMatchObject({ code: 'source_invalid' })
  })
  test('an active duplicate does not dispatch; an expired lease is reclaimed and fences the old runner', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    f.run.mockImplementationOnce(async (input, signal) => { entered(); await blocked; return runRecordedReplayCase(input, signal) })
    const old = f.service.execute(f.author, f.request).then(value => ({ value, error: null }), error => ({ value: null, error }))
    await started
    try {
      expect(await f.service.execute(f.author, f.request)).toMatchObject({ state: 'running', eligible: false })
      expect(f.run).toHaveBeenCalledTimes(1)
      await pool.query(`UPDATE memory_skill_replay_runs SET lease_expires_at=clock_timestamp()-interval '1 second'`)
      const current = await f.service.execute(f.author, f.request)
      expect(current).toMatchObject({ state: 'passed', eligible: true })
      release()
      expect((await old).error).toMatchObject({ code: 'lease_lost' })
      expect((await pool.query(`SELECT state,attempt FROM memory_skill_replay_runs`)).rows).toEqual([{ state: 'passed', attempt: 2 }])
    } finally { release(); await old }
  })
  test('expired third attempt terminates without dispatch or partial success', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    f.run.mockImplementationOnce(async (input, signal) => { entered(); await blocked; return runRecordedReplayCase(input, signal) })
    const old = f.service.execute(f.author, f.request).catch(error => error)
    await started
    try {
      await pool.query(`UPDATE memory_skill_replay_runs SET attempt=3,lease_expires_at=clock_timestamp()-interval '1 second'`)
      expect(await f.service.execute(f.author, f.request)).toMatchObject({ state: 'cancelled', errorCode: 'attempts_exhausted', eligible: false })
      expect(f.run).toHaveBeenCalledTimes(1)
    } finally { release(); await old }
    expect((await pool.query(`SELECT state FROM memory_skill_replay_cases`)).rows).toEqual([{ state: 'cancelled' },{ state: 'cancelled' }])
  })
  test('recorded cases stay outside natural execution counts; changed recordings invalidate cached evidence', async () => {
    const f = await fixture()
    f.cases.forEach(c => { c.provenance = 'recorded' })
    expect(await f.service.execute(f.author, f.request)).toMatchObject({ state: 'passed', naturalExecutionCount: 0, provenance: { fixture: 0, recorded: 2 } })
    f.cases[0].steps[0].response = { matches: 0 }
    await expect(f.service.getEvidence(f.author, { skillId: f.draft.skillId, versionId: f.draft.versionId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'case_invalid' })
    await expect(f.service.execute(f.author, f.request)).rejects.toMatchObject({ code: 'case_invalid' })
    expect(f.run).toHaveBeenCalledTimes(2)
  })
  test('a recording changed during execution and a fabricated port success cannot be persisted', async () => {
    const f = await fixture()
    f.run.mockImplementationOnce(async (input, signal) => {
      f.cases[0].steps[0].response = { matches: 0 }
      return runRecordedReplayCase(input, signal)
    })
    await expect(f.service.execute(f.author, f.request)).rejects.toMatchObject({ code: 'case_invalid' })
    f.run.mockImplementationOnce(async (input, signal) => ({ ...await runRecordedReplayCase(input, signal), state: 'passed', errorCode: 'ok' }))
    await expect(f.service.execute(f.author, { ...f.request, idempotencyKey: 'fabricated' })).rejects.toMatchObject({ code: 'runner_failed' })
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_cases WHERE state='passed'`)).rowCount).toBe(0)
  })
  test('completion transaction failure rolls back every result before cancelling the run', async () => {
    const f = await fixture()
    await pool.query(`CREATE FUNCTION fixture_reject_replay_finish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state='passed' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER fixture_reject_replay_finish BEFORE UPDATE ON memory_skill_replay_runs FOR EACH ROW EXECUTE FUNCTION fixture_reject_replay_finish()`)
    try {
      await expect(f.service.execute(f.author, f.request)).rejects.toMatchObject({ code: 'runner_failed' })
      expect((await pool.query(`SELECT state FROM memory_skill_replay_runs`)).rows).toEqual([{ state: 'cancelled' }])
      expect((await pool.query(`SELECT state,assertion_results FROM memory_skill_replay_cases`)).rows).toEqual([
        { state: 'cancelled', assertion_results: [] }, { state: 'cancelled', assertion_results: [] }])
    } finally {
      await pool.query(`DROP TRIGGER fixture_reject_replay_finish ON memory_skill_replay_runs`)
      await pool.query(`DROP FUNCTION fixture_reject_replay_finish()`)
    }
  })
  test('terminal evidence is immutable and its case set cannot be extended after admission', async () => {
    const f = await fixture(), result = await f.service.execute(f.author, f.request)
    await expect(pool.query(`UPDATE memory_skill_replay_runs SET state='failed' WHERE run_id=$1`, [result.runId])).rejects.toThrow('skill_replay_immutable')
    await expect(pool.query(`UPDATE memory_skill_replay_cases SET input_hash=repeat('f',64) WHERE run_id=$1`, [result.runId])).rejects.toThrow('skill_replay_immutable')
    await expect(pool.query(`INSERT INTO memory_skill_replay_cases(installation_id,run_id,case_id,kind,provenance,reference_id,input_hash)
      VALUES($1,$2,'late-case','golden_task','fixture','later',repeat('a',64))`, [f.installationId,result.runId])).rejects.toThrow('skill_replay_case_set_closed')
    await pool.query(`DELETE FROM memory_skill_replay_cases WHERE run_id=$1 AND case_id='case-1'`, [result.runId])
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_runs`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_replay_cases`)).rowCount).toBe(0)
  })
  test('a history case must belong to the exact repository snapshot, and denials contain no recording payload', async () => {
    const f = await fixture(), wrongSession = randomUUID()
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)VALUES($1,$2,NOW(),NOW())`, [f.installationId,wrongSession])
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,compiler_version)
      VALUES($1,$2,$3,$2::uuid::text,'ready','completed','fixture')`, [f.installationId,randomUUID(),wrongSession])
    f.cases[0].reference_id = wrongSession
    await expect(f.service.execute(f.author, f.request)).rejects.toMatchObject({ code: 'source_invalid' })
    expect(f.run).not.toHaveBeenCalled()
    const audits = (await pool.query(`SELECT * FROM memory_skill_audit_events WHERE action='replay'`)).rows
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ outcome: 'denied', code: 'source_invalid' })
    expect(JSON.stringify(audits)).not.toContain('matches')
  })
})
