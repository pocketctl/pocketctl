import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle schema',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 test('AC-02 additive_idempotent',async()=>{
  const f=await governanceFixture(pool)
  await applyMemorySchema(pool)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[f.personal])).rows[0].n).toBe(1)
  const names=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'memory_%'")).rows.map(r=>r.tablename)
  for(const name of ['memory_task_bundles','memory_task_bundle_sources','memory_curation_runs','memory_curation_decisions','memory_claim_lifecycle','memory_source_processing_receipts'])expect(names).toContain(name)
 })
 test('AC-02 lifecycle_owner_fk',async()=>{
  const f=await governanceFixture(pool)
  await expect(pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'fact','verified')",[f.team,f.claim])).rejects.toThrow()
  await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'fact','verified')",[f.personal,f.claim])
  expect((await pool.query('SELECT storage_tier,body_state FROM memory_claim_lifecycle')).rows[0]).toEqual({storage_tier:'hot',body_state:'present'})
 })
 test('AC-02 candidate_source_union',async()=>{
  const constraints=(await pool.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='memory_candidates'::regclass")).rows.map(r=>r.def).join('\n')
  expect(constraints).toContain('source_kind')
  // Existing legacy rows remain governed by their episode/run FKs. New source
  // branches must have all required refs rather than exploiting nullable FKs.
  const f=await governanceFixture(pool)
  const insert=`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind)
    VALUES(gen_random_uuid(),$1,NULL,NULL,0,'work_method','synthetic','synthetic','installation',$1::text,1,NOW(),'validated',$2)`
  for(const kind of ['legacy_episode','task_bundle','manual_entry'])await expect(pool.query(insert,[f.personal,kind])).rejects.toThrow()
 })
 test('AC-08 policy_defaults_off',async()=>{
  const f=await governanceFixture(pool)
  await pool.query('INSERT INTO memory_curation_policies(installation_id) VALUES($1)',[f.personal])
  expect((await pool.query('SELECT mode,consume_mode,cold_mode,reclaim_mode FROM memory_curation_policies')).rows[0]).toEqual({mode:'off',consume_mode:'off',cold_mode:'off',reclaim_mode:'off'})
 })
})
