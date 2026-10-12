import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { assertMemoryTestDatabase } from '../test-db.js'

export const V50_IDS = {
  personal: 'a0500000-0000-4000-8000-000000000001',
  team: 'a0500000-0000-4000-8000-000000000002',
  knownClaim: 'a0500000-0000-4000-8000-000000000011',
  unknownClaim: 'a0500000-0000-4000-8000-000000000012',
  firstVersion: 'a0500000-0000-4000-8000-000000000021',
  currentVersion: 'a0500000-0000-4000-8000-000000000022',
  unknownVersion: 'a0500000-0000-4000-8000-000000000023',
  repository: 'a0500000-0000-4000-8000-000000000031',
  proposal: 'a0500000-0000-4000-8000-000000000041',
  proposalRevision: 'a0500000-0000-4000-8000-000000000042',
  policy: 'a0500000-0000-4000-8000-000000000051',
  policyVersion: 'a0500000-0000-4000-8000-000000000052',
} as const

/** Frozen SQL, not the moving production schema. Refuses non-test DBs. */
export async function applyMemoryV50Fixture(pool: pg.Pool, databaseUrl: string): Promise<string> {
  await assertMemoryTestDatabase(pool, databaseUrl)
  const sql = await readFile(new URL('./memory-v50.sql', import.meta.url), 'utf8')
  const digest = createHash('sha256').update(sql).digest('hex')
  const client = await pool.connect()
  try { await client.query(sql) } finally { client.release() }
  return digest
}

/** Minimal historical anomalies; later scenario fixtures extend, not mutate, this baseline. */
export async function seedMemoryV50Anomalies(pool: pg.Pool): Promise<void> {
  for (const [id,kind] of [[V50_IDS.personal,'personal'],[V50_IDS.team,'team']]) {
    await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`,[id])
    await pool.query('INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,$2,$1)',[id,kind])
  }
  await pool.query(`INSERT INTO repositories(repository_id,installation_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
    VALUES($1,$2,'confirmed:example/repo','https://example.invalid/repo.git','2026-01-01','2026-01-01')`,[V50_IDS.repository,V50_IDS.personal])
  for (const [id,key] of [[V50_IDS.knownClaim,'known'],[V50_IDS.unknownClaim,'unknown']]) {
    await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
      VALUES($1,$2,'implementation_map','branch','main',$3,'active')`,[id,V50_IDS.personal,key])
  }
  for (const [id,claim,number,repository,created] of [
    [V50_IDS.firstVersion,V50_IDS.knownClaim,1,V50_IDS.repository,'2026-01-01'],
    [V50_IDS.currentVersion,V50_IDS.knownClaim,2,V50_IDS.repository,'2026-02-01'],
    [V50_IDS.unknownVersion,V50_IDS.unknownClaim,1,null,'2026-01-01'],
  ]) await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,branch,created_at)
    VALUES($1,$2,$3,$4,'Fixture symbol location','user_accepted',0.9,$5,'main',$6)`,[id,V50_IDS.personal,claim,number,repository,created])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[V50_IDS.knownClaim,V50_IDS.currentVersion])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[V50_IDS.unknownClaim,V50_IDS.unknownVersion])
  await pool.query(`INSERT INTO memory_review_policy_sets(policy_id,installation_id) VALUES($1,$2)`,[V50_IDS.policy,V50_IDS.team])
  const policy={schema_version:1,minimum_approvals:1,require_independent_reviewer:true,require_publisher:true,publisher_may_count_as_reviewer:false,allow_self_publish:false,candidate_ttl_days:30,max_shared_evidence:8,retention_days_after_revoke:90,allow_parallel_conflicts:false}
  await pool.query(`INSERT INTO memory_review_policy_versions(policy_version_id,policy_id,version_number,document,content_hash)
    VALUES($1,$2,1,$3,'fixture-policy-hash')`,[V50_IDS.policyVersion,V50_IDS.policy,policy])
  await pool.query('INSERT INTO memory_review_policy_heads(policy_id,active_version_id) VALUES($1,$2)',[V50_IDS.policy,V50_IDS.policyVersion])
  await pool.query(`INSERT INTO memory_promotion_candidates(candidate_id,target_installation_id,source_installation_id,source_scope_kind,source_claim_id,source_version_id,source_content_hash,target_claim_type,scope_kind,scope_key,normalized_key,state,expires_at)
    VALUES($1,$2,$3,'personal',$4,$5,'fixture-source-hash','implementation_map','branch','main','fixture-proposal','approved','2026-01-01')`,[V50_IDS.proposal,V50_IDS.team,V50_IDS.personal,V50_IDS.knownClaim,V50_IDS.currentVersion])
  await pool.query(`INSERT INTO memory_promotion_candidate_versions(candidate_revision_id,candidate_id,revision_number,statement,content_hash,review_policy_version_id)
    VALUES($1,$2,1,'Fixture missing evidence','fixture-content-hash',$3)`,[V50_IDS.proposalRevision,V50_IDS.proposal,V50_IDS.policyVersion])
}
