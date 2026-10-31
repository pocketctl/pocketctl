import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema, MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createClaimRepository } from '../claims/repository.js'
import { createReviewService } from '../claims/review-service.js'
import { expirePendingCandidates } from '../claims/candidate-expiry.js'
import { createIdempotencyStore } from '../api/idempotency.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const installationId = '71717171-7171-4171-8171-717171717171'
const handle = 'h0-aaaaaaaa'

;(enabled ? describe : describe.skip)('personal candidate review TTL (PostgreSQL)', () => {
  let pool: pg.Pool
  let candidateId: string
  let episodeId: string
  let runId: string
  const input = () => ({ installationId, candidateId, expectedRevision: 1 })
  const claims = () => createClaimRepository(pool)
  const review = () => createReviewService(pool, claims())

  async function seed() {
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`, [installationId])
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)
      VALUES($1,'ttl-session',NOW(),NOW())`, [installationId])
    await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at)
      VALUES($1,'ttl-turn','ttl-session','completed',NOW())`, [installationId])
    episodeId = (await pool.query(`INSERT INTO work_episodes
      (installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest,compiled_at,source_digest)
      VALUES($1,gen_random_uuid(),'ttl-session','ttl-turn','ready','v1',$2,$3,NOW(),'x'::bytea) RETURNING episode_id`,
    [installationId, JSON.stringify({ final_outcome: { text: 'Test files live next to sources', evidence_handle: handle } }),
      JSON.stringify({ [handle]: { kind: 'episode' } })])).rows[0].episode_id
    runId = (await pool.query(`INSERT INTO memory_extraction_runs
      (run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model)
      VALUES(gen_random_uuid(),$1,$2,'x'::bytea,'e1','p1','x'::bytea,'x'::bytea,'enabled','succeeded','openai-compatible','m') RETURNING run_id`,
    [installationId, episodeId])).rows[0].run_id
    candidateId = await addCandidate('validated', 0)
  }
  async function addCandidate(status: string, ordinal: number, days = 0) {
    return (await pool.query(`INSERT INTO memory_candidates
      (candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,
        confidence,freshness_at,evidence_handles,status,validation,created_at)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,'repository_convention','Test files live next to sources','ttl-key','installation','global',
        0.9,NOW(),$5,$6,'{"codes":["existing_validation"]}',clock_timestamp()-($7::int*INTERVAL '24 hours')) RETURNING candidate_id`,
    [installationId, runId, episodeId, ordinal, JSON.stringify([handle]), status, days])).rows[0].candidate_id as string
  }
  async function ageCandidate() {
    await pool.query(`UPDATE memory_candidates SET created_at=clock_timestamp()-INTERVAL '336 hours' WHERE candidate_id=$1`, [candidateId])
  }
  async function row() {
    return (await pool.query('SELECT * FROM memory_candidates WHERE candidate_id=$1', [candidateId])).rows[0]
  }
  async function assertNoLedgerWrites() {
    for (const table of ['knowledge_claims', 'knowledge_versions', 'knowledge_evidence', 'memory_feedback', 'memory_jobs']) {
      expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, table).toBe(0)
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE memory_installations CASCADE')
    await seed()
  })

  test('new candidates get exactly 14 days from creation, independent of knowledge validity', async () => {
    const c = await row()
    expect(c.review_expires_at.getTime() - c.created_at.getTime()).toBe(14 * 86400_000)
    expect(c.valid_until).toBeNull()
    expect((await review().reviewQueue({ installationId }))[0].review_expires_at).toEqual(c.review_expires_at)
    await pool.query("UPDATE memory_candidates SET validation=validation||'{\"edited_metadata\":true}',revision=revision+1 WHERE candidate_id=$1", [candidateId])
    expect((await row()).review_expires_at).toEqual(c.review_expires_at)
  })

  test.each(['validated', 'conflict'])('TTL boundary hides %s before the sweeper and rejects a stale browser acceptance', async status => {
    await pool.query('UPDATE memory_candidates SET status=$2 WHERE candidate_id=$1', [candidateId, status])
    await ageCandidate()
    expect((await row()).status).toBe(status)
    expect(await review().reviewQueue({ installationId })).toEqual([])
    expect(await claims().acceptCandidate(input())).toEqual({ ok: false, error: { code: 'candidate_expired' } })
    expect(await row()).toMatchObject({ status: 'expired', revision: '2', reviewed_at: null,
      validation: { codes: ['existing_validation'], expiry_reason: 'review_ttl_elapsed' } })
    expect(await claims().acceptCandidate(input())).toEqual({ ok: false, error: { code: 'candidate_expired' } })
    await assertNoLedgerWrites()
  })

  test('expired rejection is not counted as human feedback', async () => {
    await ageCandidate()
    expect(await claims().rejectCandidate(input())).toEqual({ ok: false, error: { code: 'candidate_expired' } })
    expect((await row()).status).toBe('expired')
    await assertNoLedgerWrites()
  })

  test('sweep only expires pending states; keeps terminal/shadow candidates, evidence and original validation', async () => {
    await ageCandidate()
    const conflict = await addCandidate('conflict', 1, 15)
    const statuses = ['accepted', 'rejected', 'duplicate', 'shadow', 'rejected_by_validator']
    const untouched = await Promise.all(statuses.map((status, i) => addCandidate(status, i + 2, 15)))
    expect(await expirePendingCandidates(pool)).toBe(2)
    expect(await expirePendingCandidates(pool)).toBe(0)
    expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1', [conflict])).rows[0].status).toBe('expired')
    for (const [i, id] of untouched.entries()) {
      expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1', [id])).rows[0].status).toBe(statuses[i])
    }
    expect((await row()).evidence_handles).toEqual([handle])
    expect((await pool.query('SELECT count(*)::int n FROM work_episodes')).rows[0].n).toBe(1)
    await assertNoLedgerWrites()
  })

  test('a fresh candidate still accepts; its active knowledge survives later candidate expiration sweeps', async () => {
    const accepted = await claims().acceptCandidate(input())
    expect(accepted.ok).toBe(true)
    await ageCandidate()
    expect(await expirePendingCandidates(pool)).toBe(0)
    expect((await row()).status).toBe('accepted')
    expect((await pool.query('SELECT state FROM knowledge_claims')).rows[0].state).toBe('active')
  })

  test('bounded passes skip locked candidates and can resume without incrementing revisions twice', async () => {
    await ageCandidate()
    await addCandidate('validated', 1, 15)
    await addCandidate('conflict', 2, 15)
    const locker = await pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT 1 FROM memory_candidates WHERE candidate_id=$1 FOR UPDATE', [candidateId])
      expect(await expirePendingCandidates(pool, 1)).toBe(1)
      expect(await expirePendingCandidates(pool, 1)).toBe(1)
      expect(await expirePendingCandidates(pool, 1)).toBe(0)
      expect((await row()).status).toBe('validated')
    } finally { await locker.query('ROLLBACK'); locker.release() }
    expect(await expirePendingCandidates(pool, 1)).toBe(1)
    expect(await expirePendingCandidates(pool, 1)).toBe(0)
    expect((await row()).revision).toBe('2')
  })

  test('expiry still blocks acceptance inside the API idempotency transaction', async () => {
    await ageCandidate()
    const outcome = await createIdempotencyStore(pool).execute({ installationId, operation: 'candidate_accept', key: 'ttl-key', requestCanonical: '{}',
      run: async c => {
        const result = await createClaimRepository(createTransactionBoundPool(c)).acceptCandidate(input())
        return result.ok ? { ok: true, metadata: {} } : result
      } })
    expect(outcome).toEqual({ kind: 'failed', error: { code: 'candidate_expired' } })
    // The failed outer request rolls back lazy expiry too. The worker persists it.
    expect(await expirePendingCandidates(pool)).toBe(1)
    await assertNoLedgerWrites()
  })

  test('database guard checks wall time after waiting, not the transaction start timestamp', async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE memory_candidates SET created_at=clock_timestamp()-INTERVAL '336 hours'+INTERVAL '100 milliseconds' WHERE candidate_id=$1`, [candidateId])
      await c.query('SELECT pg_sleep(0.15)')
      await expect(c.query("UPDATE memory_candidates SET status='accepted' WHERE candidate_id=$1", [candidateId]))
        .rejects.toMatchObject({ code: 'PCE01', message: 'candidate_expired' })
    } finally { await c.query('ROLLBACK'); c.release() }
    expect((await row()).status).toBe('validated')
  })

  test('TTL elapsing during evidence creation rolls back the entire acceptance and returns candidate_expired', async () => {
    // Advance the candidate's age inside evidence insertion, after the first
    // TTL check. This deterministically exercises the late-write guard.
    await pool.query(`CREATE FUNCTION test_candidate_ttl_during_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE memory_candidates SET created_at=clock_timestamp()-INTERVAL '336 hours'
        WHERE candidate_id=(SELECT source_candidate_id FROM knowledge_versions WHERE version_id=NEW.version_id);
        RETURN NEW;
      END $$`)
    await pool.query(`CREATE TRIGGER test_candidate_ttl_during_evidence BEFORE INSERT ON knowledge_evidence
      FOR EACH ROW EXECUTE FUNCTION test_candidate_ttl_during_evidence()`)
    try {
      expect(await claims().acceptCandidate(input())).toEqual({ ok: false, error: { code: 'candidate_expired' } })
      await assertNoLedgerWrites()
      expect((await row()).status).toBe('validated')
    } finally {
      await pool.query('DROP TRIGGER test_candidate_ttl_during_evidence ON knowledge_evidence')
      await pool.query('DROP FUNCTION test_candidate_ttl_during_evidence()')
    }
  })

  test('v70 upgrade uses historical creation time and is idempotent', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    for (const migration of MEMORY_MIGRATIONS.filter(m => m.version <= 70)) {
      for (const statement of migration.statements) await pool.query(statement)
      await pool.query('INSERT INTO memory_schema_migrations(version) VALUES($1)', [migration.version])
    }
    await seed()
    await ageCandidate()
    const alreadyAccepted = await addCandidate('accepted', 1, 30)
    await applyMemorySchema(pool)
    await applyMemorySchema(pool)
    expect((await row()).review_expires_at.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await review().reviewQueue({ installationId })).toEqual([])
    expect(await expirePendingCandidates(pool)).toBe(1)
    expect((await row()).status).toBe('expired')
    expect((await pool.query('SELECT status FROM memory_candidates WHERE candidate_id=$1', [alreadyAccepted])).rows[0].status).toBe('accepted')
  }, 60_000)
})
