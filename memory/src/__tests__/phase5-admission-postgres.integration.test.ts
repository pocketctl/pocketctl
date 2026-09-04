import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { loadSkillConfig } from '../skills/config.js'
import { createSkillAdmissionService } from '../skills/admission-service.js'
import type { V2GrantFacts } from '../governance/authorization.js'
import { createSkillWorker } from '../skills/worker.js'
import { createSkillGenerator } from '../skills/generator.js'
import { createJobRepository } from '../jobs/repository.js'
import type { TextGenerator } from '../ports/text-generator.js'
const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
db('Phase 5 source admission and atomic scheduling', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 8 }); await assertMemoryTestDatabase(pool, url!); await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public'); await applyMemorySchema(pool) }, 60000)
  afterAll(async () => pool?.end())
  beforeEach(async () => pool.query(`TRUNCATE memory_installations CASCADE`))
  async function fixture(overrides: {
    secret?: boolean
    passed?: boolean
    ready?: boolean
  } = {}) {
    const installationId = randomUUID(), repositoryId = randomUUID(), snapshotId = randomUUID(), episodeId = randomUUID()
    const sessionId = `session-${randomUUID()}`
    const excerpt = overrides.secret ? 'api_key=fixture-secret-value' : 'tests passed'
    const excerptHash = createHash('sha256').update(excerpt).digest('hex').slice(0, 16)
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`, [installationId])
    await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id)
      VALUES($1,'personal',$1)`, [installationId])
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)
      VALUES($1,$2,NOW(),NOW())`, [installationId, sessionId])
    await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at)
      VALUES($1,$2,$2::uuid::text,NOW(),NOW())`, [installationId, repositoryId])
    await pool.query(`INSERT INTO repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at)
      VALUES($1,$2,$3,$4,NOW())`, [installationId, snapshotId, repositoryId, 'a'.repeat(40)])
    await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,
      ready_at,compiler_version,repository_id,repo_snapshot_id,source_digest,document,evidence_manifest,
      document_compiler_version,compiled_at)
      VALUES($1,$2,$3,$2::uuid::text,$4,'completed',NOW()-INTERVAL '1 second','fixture',$5,$6,decode($7,'hex'),$8,$9,'packet.v1',NOW())`, [installationId, episodeId, sessionId, overrides.ready === false ? 'open' : 'ready', repositoryId, snapshotId, 'a'.repeat(64),
      { tests: [{ status: overrides.passed === false ? 'failed' : 'passed', text: excerpt, evidence_handle: 'e1' }] },
      { e1: { kind: 'episode', excerpt_hash: excerptHash, excerpt_length: excerpt.length, truncated: false } }])
    const grant: V2GrantFacts = {
      primaryInstallationId: installationId, configVersion: '1', scopeBindings: [{
        installation_id: installationId, owner_scope_kind: 'personal', owner_scope_id: installationId, membership_id: null,
        membership_revision: '0', authorization_epoch: '1', permissions: ['read', 'contribute']
      }]
    }
    return { installationId, repositoryId, snapshotId, episodeId, sessionId, grant }
  }
  const service = (onOutcome?: (outcome: 'admitted' | 'deduplicated' | 'rejected') => void) => createSkillAdmissionService({
    pool, onOutcome, context: {
      globalMode: 'enabled', sharedMode: 'off',
      config: loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' })
    }
  })
  test('migration 32 is additive and enables exactly one task/job for concurrent duplicate input', async () => {
    expect(MEMORY_MIGRATIONS.map(m => m.version)).toEqual(Array.from({ length: 46 }, (_, i) => i + 1))
    const f = await fixture(), input = { installationId: f.installationId, grant: f.grant, candidateKey: 'tests', source: { kind: 'episode', episodeId: f.episodeId } }
    const outcomes: string[] = []
    const results = await Promise.all(Array.from({ length: 8 }, () => service(outcome => outcomes.push(outcome)).schedule(input)))
    expect(outcomes.filter(outcome => outcome === 'admitted')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome === 'deduplicated')).toHaveLength(7)
    expect(new Set(results.map(r => r.taskId)).size).toBe(1)
    expect(new Set(results.map(r => r.runId)).size).toBe(1)
    expect(results.filter(r => !r.deduplicated)).toHaveLength(1)
    expect((await pool.query(`SELECT 1 FROM memory_jobs WHERE job_type='extract_skill_candidate'`)).rowCount).toBe(1)
    const row = (await pool.query(`SELECT state,current_generation,current_input_digest FROM memory_skill_tasks`)).rows[0]
    expect(row).toMatchObject({ state: 'pending', current_generation: '1' })
    expect(row.current_input_digest).toMatch(/^[0-9a-f]{64}$/)
  })
  test('changed trusted source creates a new generation and fences the old job', async () => {
    const f = await fixture(), base = { installationId: f.installationId, grant: f.grant, candidateKey: 'tests', source: { kind: 'episode', episodeId: f.episodeId } }
    const one = await service().schedule(base)
    await pool.query(`UPDATE work_episodes SET source_digest=decode($2,'hex') WHERE installation_id=$1`, [f.installationId, 'b'.repeat(64)])
    const two = await service().schedule(base)
    expect(two).toMatchObject({ taskId: one.taskId, generation: 2, deduplicated: false })
    expect((await pool.query(`SELECT state,error_code FROM memory_skill_task_runs ORDER BY generation`)).rows)
      .toEqual([{ state: 'cancelled', error_code: 'source_invalidated' }, { state: 'pending', error_code: null }])
    expect((await pool.query(`SELECT state,last_error_code FROM memory_jobs ORDER BY created_at`)).rows)
      .toEqual([{ state: 'completed', last_error_code: 'source_invalidated' }, { state: 'pending', last_error_code: null }])
  })
  test('queue failure rolls back task and run atomically', async () => {
    const f = await fixture()
    await pool.query(`CREATE FUNCTION phase5_reject_job() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.job_type='extract_skill_candidate' THEN RAISE EXCEPTION 'fixture_queue_failure';END IF;RETURN NEW;END$$`)
    await pool.query(`CREATE TRIGGER phase5_reject_job BEFORE INSERT ON memory_jobs FOR EACH ROW EXECUTE FUNCTION phase5_reject_job()`)
    await expect(service().schedule({ installationId: f.installationId, grant: f.grant, candidateKey: 'fail', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow(/fixture_queue_failure/)
    expect((await pool.query(`SELECT 1 FROM memory_skill_tasks`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_task_runs`)).rowCount).toBe(0)
    await pool.query(`DROP TRIGGER phase5_reject_job ON memory_jobs;DROP FUNCTION phase5_reject_job()`)
  })
  test('shared input uses published Claim authority and target Evidence, never a synthetic completed episode', async () => {
    const f = await fixture(), member = randomUUID(), claimId = randomUUID(), versionId = randomUUID(), policyId = randomUUID(), policyVersion = randomUUID()
    await pool.query(`UPDATE memory_owner_scopes SET owner_scope_kind='team' WHERE installation_id=$1`, [f.installationId])
    await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles)VALUES($1,$2,ARRAY['contributor'])`, [f.installationId, member])
    await pool.query(`UPDATE work_episodes SET session_id='shared-governance',outcome=NULL,repository_id=NULL,repo_snapshot_id=NULL,source_digest=NULL,document='{}',evidence_manifest='{}' WHERE episode_id=$1`, [f.episodeId])
    await pool.query(`DELETE FROM source_sessions WHERE installation_id=$1`, [f.installationId])
    await pool.query(`INSERT INTO memory_review_policy_sets(policy_id,installation_id)VALUES($1,$2)`, [policyId, f.installationId])
    await pool.query(`INSERT INTO memory_review_policy_versions(policy_version_id,policy_id,version_number,document,content_hash)
      VALUES($1,$2,1,'{}','fixture')`, [policyVersion, policyId])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,current_version_id,owner_scope_kind,owner_scope_id)
        VALUES($1,$2,'work_method','repository',$3,'shared-method','active',$4,'team',$2)`, [claimId, f.installationId, f.repositoryId, versionId])
      await client.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,source_promotion_candidate_id)
        VALUES($1,$2,$3,1,'Shared method','team_published',1,$4)`, [versionId, f.installationId, claimId, randomUUID()])
      await client.query('COMMIT')
    }
    catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
    finally {
      client.release()
    }
    const excerpt = 'shared reviewed method evidence'
    await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
      VALUES($1,$2,$3,$4,'episode',$5,$6,NOW(),1,'shared')`, [randomUUID(), f.installationId, versionId, f.episodeId, excerpt, createHash('sha256').update(excerpt).digest()])
    await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,
      review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,'personal','fixture')`, [randomUUID(), f.installationId, versionId, randomUUID(), policyVersion, [randomUUID()], member])
    f.grant.scopeBindings[0] = { ...f.grant.scopeBindings[0]!, owner_scope_kind: 'team', membership_id: member, membership_revision: '1' }
    const context = { globalMode: 'enabled' as const, sharedMode: 'shadow' as const, config: loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' }) }
    const shared = createSkillAdmissionService({ pool, context })
    await expect(shared.schedule({ installationId: f.installationId, grant: f.grant, candidateKey: 'synthetic', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow(/skill_shared_episode_denied/)
    const request = { installationId: f.installationId, grant: f.grant, candidateKey: 'shared-claim', source: { kind: 'claim_version', versionId, repositoryId: f.repositoryId, repoSnapshotId: f.snapshotId } }
    const scheduled = await shared.schedule(request)
    expect((await pool.query(`SELECT source_kind,episode_id,claim_version_id,owner_scope_kind FROM memory_skill_task_runs WHERE run_id=$1`, [scheduled.runId])).rows)
      .toEqual([{ source_kind: 'claim_version', episode_id: null, claim_version_id: versionId, owner_scope_kind: 'team' }])
    const provider: TextGenerator = { generateJson: async <T>() => ({ ok: true as const, value: {
      schema_version: 'skill-candidate.v1', title: 'Shared method', trigger: 'Search repository', preconditions: ['Read access'],
      steps: [{ instruction: 'Read source', tool: 'search', permissions: ['repository:read'], operation: 'read' }],
      validation: ['Check result'], failure_handling: ['Stop'], rollback: ['No changes'], source_tokens: ['source-1']
    } as T, usage: { inputTokens: 1, outputTokens: 1, model: 'fixture' } }) }
    const claim = (await createJobRepository(pool).claimJobs({ workerId: 'shared-fixture', limit: 1, leaseMs: 30000 }))[0]!
    await createSkillWorker({ pool, context, generator: createSkillGenerator({ provider, timeoutMs: 100 }) })
      .handle(claim, new AbortController().signal, { fence: { jobId: claim.job_id, claimedBy: 'shared-fixture', claimEpoch: claim.claim_epoch } })
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(1)
    // This is the incumbent update performed by governance's coexist publication.
    await pool.query(`UPDATE knowledge_claims SET conflict_group_id=$2,conflict_variant=1 WHERE claim_id=$1`, [claimId, randomUUID()])
    expect((await pool.query(`SELECT 1 FROM memory_skill_archives`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT state FROM memory_skill_tasks WHERE task_id=$1`, [scheduled.taskId])).rows).toEqual([{ state: 'cancelled' }])
    await pool.query(`UPDATE knowledge_claims SET conflict_group_id=NULL,conflict_variant=0 WHERE claim_id=$1`, [claimId])
    await pool.query(`DELETE FROM memory_authority_records WHERE installation_id=$1`, [f.installationId])
    await expect(shared.schedule({ ...request, candidateKey: 'no-authority' })).rejects.toThrow(/skill_claim_scope_invalid/)
  })
  test('rejects unproven value, secrets, tombstones, stale permissions, off mode and shared synthetic episodes', async () => {
    for (const spec of [{ passed: false }, { secret: true }, { ready: false }]) {
      const f = await fixture(spec)
      await expect(service().schedule({ installationId: f.installationId, grant: f.grant, candidateKey: 'denied', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow()
      await pool.query(`TRUNCATE memory_installations CASCADE`)
    }
    const f = await fixture()
    await pool.query(`INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at)VALUES($1,$2,'deleted',NOW())`, [f.installationId, f.sessionId])
    await expect(service().schedule({ installationId: f.installationId, grant: f.grant, candidateKey: 'tombstone', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow()
    const stale = { ...f.grant, scopeBindings: [{ ...f.grant.scopeBindings[0]!, permissions: ['read'] }] }
    await expect(service().schedule({ installationId: f.installationId, grant: stale, candidateKey: 'stale', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow(/skill_forbidden/)
    const off = createSkillAdmissionService({ pool, context: { globalMode: 'enabled', sharedMode: 'off', config: loadSkillConfig({}) } })
    await expect(off.schedule({ installationId: f.installationId, grant: f.grant, candidateKey: 'off', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow(/skill_disabled/)
    await pool.query(`UPDATE memory_owner_scopes SET owner_scope_kind='team' WHERE installation_id=$1`, [f.installationId])
    f.grant.scopeBindings[0]!.owner_scope_kind = 'team'
    f.grant.scopeBindings[0]!.membership_id = randomUUID()
    await expect(service().schedule({ installationId: f.installationId, grant: f.grant, candidateKey: 'shared', source: { kind: 'episode', episodeId: f.episodeId } })).rejects.toThrow()
  })
})
