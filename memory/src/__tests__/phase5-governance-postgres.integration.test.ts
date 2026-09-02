import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSkillReviewService } from '../skills/review-service.js'
import { loadSkillConfig } from '../skills/config.js'
import { createReviewPolicyRepository, DEFAULT_TEAM_REVIEW_POLICY } from '../governance/review-policy.js'

import { createSkillGovernanceFixture, skillFixtureDocument as document } from '../testing/skill-fixture.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const context = { globalMode: 'enabled' as const, sharedMode: 'shadow' as const, config: loadSkillConfig({ MEMORY_SKILL_MODE: 'shadow' }) }


db('Phase 5 Skill versions and human governance', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    const client = await pool.connect()
    try {
      for (const migration of MEMORY_MIGRATIONS.filter(m => m.version <= 32)) {
        await client.query('BEGIN')
        for (const statement of migration.statements) await client.query(statement)
        await client.query('INSERT INTO memory_schema_migrations(version)VALUES($1)', [migration.version])
        await client.query('COMMIT')
      }
    } finally { client.release() }
  }, 60000)
  afterAll(async () => pool?.end())
  beforeEach(async () => pool.query('TRUNCATE memory_installations CASCADE'))
  const service = () => createSkillReviewService({ pool, context })

  const fixture = (kind: 'personal' | 'team' | 'organization' = 'personal', high = false) => createSkillGovernanceFixture(pool, context, kind, high)
  async function draft(f: Awaited<ReturnType<typeof fixture>>) {
    return service().execute(f.author, { action: 'draft', candidateId: f.candidateId, expectedRevision: 0 })
  }

  test('migration 33 preserves existing generated candidates and is idempotent', async () => {
    const f = await fixture()
    await applyMemorySchema(pool)
    await applyMemorySchema(pool)
    expect((await pool.query(`SELECT MAX(version) AS version FROM memory_schema_migrations`)).rows[0].version).toBe(38)
    expect((await pool.query(`SELECT 1 FROM memory_skill_candidates WHERE candidate_id=$1`, [f.candidateId])).rowCount).toBe(1)
    expect(await draft(f)).toMatchObject({ state: 'draft', revision: 1 })
  })

  test('candidate to draft to reviewed, immutable edit resets review and appends a version', async () => {
    const f = await fixture(), one = await draft(f)
    expect(one).toMatchObject({ revision: 1, state: 'draft' })
    const reviewed = await service().execute(f.author, { action: 'approve', skillId: one.skillId, expectedRevision: 1 })
    expect(reviewed).toMatchObject({ revision: 2, state: 'reviewed', versionId: one.versionId })
    const edited = await service().execute(f.author, { action: 'edit', skillId: one.skillId, expectedRevision: 2, document: { ...document(), title: 'Improved method' } })
    expect(edited).toMatchObject({ revision: 3, state: 'draft' })
    expect(edited.versionId).not.toBe(one.versionId)
    expect((await pool.query(`SELECT version_number FROM memory_skill_versions ORDER BY version_number`)).rows).toEqual([{ version_number: 1 }, { version_number: 2 }])
    expect((await pool.query(`SELECT version_id FROM memory_skill_review_decisions`)).rows).toEqual([{ version_id: one.versionId }])
    await expect(pool.query(`UPDATE memory_skill_versions SET document='{}' WHERE version_id=$1`, [one.versionId])).rejects.toThrow(/immutable/)
    expect((await pool.query(`SELECT action,outcome FROM memory_skill_audit_events ORDER BY created_at`)).rows)
      .toEqual([{ action: 'draft', outcome: 'allowed' }, { action: 'approve', outcome: 'allowed' }, { action: 'edit', outcome: 'allowed' }])
  })
  test('rejects actor injection and reader mutation with durable content-free denials', async () => {
    const f = await fixture('team'), d = await draft(f), reader = await f.actor(['reader'], ['read'])
    await expect(service().execute(reader, { action: 'approve', skillId: d.skillId, expectedRevision: 1, actorId: f.author.membershipId, reason: 'secret-body' })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 })
    await expect(service().execute(reader, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'forbidden', statusCode: 403 })
    const rows = (await pool.query(`SELECT * FROM memory_skill_audit_events WHERE outcome='denied'`)).rows
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain('secret-body')
    expect((await pool.query(`SELECT revision,state FROM memory_skill_heads`)).rows).toEqual([{ revision: '1', state: 'draft' }])
  })
  test('shared high risk cannot be self-reviewed; reviewer cannot revoke or impersonate publisher', async () => {
    const f = await fixture('team', true), d = await draft(f)
    await expect(service().execute(f.author, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'self_review_denied' })
    const reviewer = await f.actor(['reviewer'], ['read','review'])
    expect(await service().execute(reviewer, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).toMatchObject({ state: 'reviewed', revision: 2 })
    await expect(service().execute(reviewer, { action: 'revoke', skillId: d.skillId, expectedRevision: 2 })).rejects.toMatchObject({ code: 'forbidden' })
    const publisher = await f.actor(['publisher'], ['read','review','publish'])
    expect(await service().execute(publisher, { action: 'revoke', skillId: d.skillId, expectedRevision: 2 })).toMatchObject({ state: 'revoked', revision: 3 })
    await expect(service().execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 3, document: document() })).rejects.toMatchObject({ code: 'state_conflict' })
  })
  test('organization counts only independent, still-current reviewer memberships', async () => {
    const f = await fixture('organization'), d = await draft(f)
    const r1 = await f.actor(['reviewer'], ['read','review']), r2 = await f.actor(['reviewer'], ['read','review']), r3 = await f.actor(['reviewer'], ['read','review'])
    expect(await service().execute(r1, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).toMatchObject({ state: 'draft', revision: 2 })
    await pool.query(`UPDATE memory_scope_memberships SET membership_revision=2,state='revoked' WHERE membership_id=$1`, [r1.membershipId])
    expect(await service().execute(r2, { action: 'approve', skillId: d.skillId, expectedRevision: 2 })).toMatchObject({ state: 'draft', revision: 3 })
    expect(await service().execute(r3, { action: 'approve', skillId: d.skillId, expectedRevision: 3 })).toMatchObject({ state: 'reviewed', revision: 4 })
  })
  test('concurrent edit and review have exactly one CAS winner', async () => {
    const f = await fixture('team'), d = await draft(f), reviewer = await f.actor(['reviewer'], ['read','review'])
    const outcomes = await Promise.allSettled([
      service().execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 1, document: { ...document(), title: 'New version' } }),
      service().execute(reviewer, { action: 'approve', skillId: d.skillId, expectedRevision: 1 }),
    ])
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find(o => o.status === 'rejected')).toMatchObject({ reason: { code: 'revision_conflict', statusCode: 409 } })
  })
  test('policy changes invalidate old decisions until a new version binds the new policy', async () => {
    const f = await fixture('team'), d = await draft(f), reviewer = await f.actor(['reviewer'], ['read','review'])
    const policies = createReviewPolicyRepository(pool), head = (await policies.getHead(f.installationId))!
    await policies.publishVersion({ installationId: f.installationId, document: { ...DEFAULT_TEAM_REVIEW_POLICY, minimum_approvals: 2 }, createdByMembershipId: null, expectedRevision: head.revision })
    await expect(service().execute(reviewer, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'policy_changed' })
    const edited = await service().execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 1, document: document() })
    expect(await service().execute(reviewer, { action: 'approve', skillId: d.skillId, expectedRevision: edited.revision })).toMatchObject({ state: 'draft' })
  })
  test('request changes requires a new version and rejection is terminal', async () => {
    const f = await fixture('team'), d = await draft(f), r1 = await f.actor(['reviewer'], ['read','review']), r2 = await f.actor(['reviewer'], ['read','review'])
    await service().execute(r1, { action: 'request_changes', skillId: d.skillId, expectedRevision: 1 })
    expect(await service().execute(r2, { action: 'approve', skillId: d.skillId, expectedRevision: 2 })).toMatchObject({ state: 'draft' })
    const edit = await service().execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 3, document: document() })
    const rejected = await service().execute(r1, { action: 'reject', skillId: d.skillId, expectedRevision: edit.revision })
    expect(rejected.state).toBe('rejected')
    await expect(service().execute(r2, { action: 'approve', skillId: d.skillId, expectedRevision: rejected.revision })).rejects.toMatchObject({ code: 'state_conflict' })
  })
  test('source deletion cascades governed content and cannot be reviewed or reconstructed', async () => {
    const f = await fixture(), d = await draft(f)
    await pool.query(`DELETE FROM work_episodes WHERE episode_id=$1`, [f.episodeId])
    expect((await pool.query(`SELECT 1 FROM memory_skill_versions`)).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM memory_skill_heads`)).rowCount).toBe(0)
    await expect(service().execute(f.author, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service().execute(f.author, { action: 'draft', candidateId: f.candidateId, expectedRevision: 0 })).rejects.toMatchObject({ code: 'not_found' })
  })
  test('personal high-risk self review, stale grants, foreign tenant and off mode are rejected', async () => {
    const f = await fixture('personal', true), d = await draft(f), other = await fixture()
    await expect(service().execute(f.author, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'self_review_denied' })
    await expect(service().execute(other.author, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service().execute({ ...f.author, grant: { ...f.author.grant, configVersion: '2' } }, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'forbidden' })
    const off = createSkillReviewService({ pool, context: { ...context, config: loadSkillConfig({}) } })
    await expect(off.execute(f.author, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'feature_disabled' })
  })
  test('bad edits cannot change source tokens, insert secrets or exceed configured content bound', async () => {
    const f = await fixture(), d = await draft(f)
    for (const [patch, code] of [[{ source_tokens: ['invented'] }, 'source_tokens_invalid'], [{ trigger: 'api_key=fixture-secret-value' }, 'secret_detected']] as const) {
      await expect(service().execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 1, document: { ...document(), ...patch } })).rejects.toMatchObject({ code })
    }
    const bounded = createSkillReviewService({ pool, context: { ...context, config: { ...context.config, maxCandidateChars: 100 } } })
    await expect(bounded.execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 1, document: document() })).rejects.toMatchObject({ code: 'size_exceeded' })
    expect((await pool.query(`SELECT 1 FROM memory_skill_versions`)).rowCount).toBe(1)
  })
  test('publisher role never expands contribute permission and policy can exclude its review from quorum', async () => {
    const f = await fixture('team'), policies = createReviewPolicyRepository(pool)
    const head = (await policies.getHead(f.installationId))!
    await policies.publishVersion({ installationId: f.installationId, expectedRevision: head.revision, createdByMembershipId: null,
      document: { ...DEFAULT_TEAM_REVIEW_POLICY, publisher_may_count_as_reviewer: false } })
    const d = await draft(f), publisher = await f.actor(['publisher'], ['read','review','publish'])
    await expect(service().execute(publisher, { action: 'edit', skillId: d.skillId, expectedRevision: 1, document: document() })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await service().execute(publisher, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })).toMatchObject({ state: 'draft', revision: 2 })
    const reviewer = await f.actor(['reviewer'], ['read','review'])
    expect(await service().execute(reviewer, { action: 'approve', skillId: d.skillId, expectedRevision: 2 })).toMatchObject({ state: 'reviewed', revision: 3 })
  })
  test('audit insertion failure rolls back the version and head mutation', async () => {
    const f = await fixture(), d = await draft(f)
    await pool.query(`CREATE FUNCTION phase5_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_audit_failure'; END$$;
      CREATE TRIGGER phase5_reject_audit BEFORE INSERT ON memory_skill_audit_events FOR EACH ROW EXECUTE FUNCTION phase5_reject_audit()`)
    try {
      await expect(service().execute(f.author, { action: 'edit', skillId: d.skillId, expectedRevision: 1, document: { ...document(), title: 'Must roll back' } })).rejects.toThrow(/fixture_audit_failure/)
      expect((await pool.query(`SELECT 1 FROM memory_skill_versions`)).rowCount).toBe(1)
      expect((await pool.query(`SELECT revision FROM memory_skill_heads`)).rows).toEqual([{ revision: '1' }])
    } finally { await pool.query(`DROP TRIGGER phase5_reject_audit ON memory_skill_audit_events; DROP FUNCTION phase5_reject_audit()`) }
  })
  test('decision and audit ledgers reject updates; mismatched review hashes cannot be inserted', async () => {
    const f = await fixture(), d = await draft(f)
    await service().execute(f.author, { action: 'approve', skillId: d.skillId, expectedRevision: 1 })
    await expect(pool.query(`UPDATE memory_skill_review_decisions SET decision='reject'`)).rejects.toThrow(/immutable/)
    await expect(pool.query(`UPDATE memory_skill_audit_events SET code='forbidden'`)).rejects.toThrow(/immutable/)
    await expect(pool.query(`INSERT INTO memory_skill_review_decisions(decision_id,installation_id,skill_id,version_id,document_hash,source_digest,policy_hash,actor_kind,actor_id,authorization_epoch,decision)
      SELECT $1,installation_id,skill_id,version_id,repeat('f',64),source_digest,policy_hash,'personal',$2,1,'approve'
      FROM memory_skill_versions WHERE version_id=$3`, [randomUUID(), randomUUID(), d.versionId])).rejects.toThrow(/foreign key/)
  })
  test('database rejects cross-task candidate lineage and forged source or archive hashes', async () => {
    const f = await fixture(), d = await draft(f), otherTask = randomUUID(), otherSkill = randomUUID()
    await pool.query(`INSERT INTO memory_skill_tasks(task_id,installation_id,repository_id,candidate_key)
      SELECT $1,installation_id,repository_id,'other-method' FROM memory_skill_tasks WHERE installation_id=$2`, [otherTask,f.installationId])
    await pool.query(`INSERT INTO memory_skills(skill_id,installation_id,task_id)VALUES($1,$2,$3)`, [otherSkill,f.installationId,otherTask])
    for (const mismatch of ['task','source','archive']) {
      await expect(pool.query(`INSERT INTO memory_skill_versions(version_id,installation_id,skill_id,version_number,candidate_id,archive_id,
        document,document_hash,source_digest,archive_content_hash,policy_snapshot,policy_hash,risk,author_kind,author_id,authorization_epoch)
        SELECT $1,installation_id,$2,2,candidate_id,archive_id,document,document_hash,
          CASE WHEN $3='source' THEN repeat('f',64) ELSE source_digest END,
          CASE WHEN $3='archive' THEN repeat('f',64) ELSE archive_content_hash END,
          policy_snapshot,policy_hash,risk,author_kind,author_id,authorization_epoch
        FROM memory_skill_versions WHERE version_id=$4`, [randomUUID(),mismatch === 'task' ? otherSkill : d.skillId,mismatch,d.versionId]))
        .rejects.toThrow(/skill_version_source_invalid/)
    }
  })
})
