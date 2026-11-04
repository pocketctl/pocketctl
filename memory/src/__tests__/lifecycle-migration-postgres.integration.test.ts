import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {inventoryLifecycle,manifestDigest} from '../migrations/lifecycle-v3/inventory.js'
import {applyLifecycleManifest} from '../migrations/lifecycle-v3/backfill.js'
import {verifyLifecycleManifest} from '../migrations/lifecycle-v3/verification.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle migration',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_lifecycle_migration_runs CASCADE');await pool.query('TRUNCATE memory_installations CASCADE')})
 async function fixture(){const f=await governanceFixture(pool);await pool.query('INSERT INTO memory_curation_policies(installation_id) VALUES($1)',[f.personal]);return f}
 test('AC-49 plan_read_only_preserves_authority',async()=>{
  const f=await fixture(),before=(await pool.query('SELECT row_to_json(c) v FROM knowledge_claims c')).rows
  const m=await inventoryLifecycle(pool,[f.personal])
  expect(m.items).toHaveLength(1);expect(m.items[0].authority).toBe('user_accepted')
  expect((await pool.query('SELECT row_to_json(c) v FROM knowledge_claims c')).rows).toEqual(before)
  expect((await pool.query('SELECT count(*)::int n FROM memory_lifecycle_migration_runs')).rows[0].n).toBe(0)
 })
 test('AC-50 wrong_manifest_policy_digest_rejected',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal])
  await expect(applyLifecycleManifest(pool,m,{expectedDigest:'0'.repeat(64),policyVersion:m.policyVersion})).rejects.toThrow('manifest_digest_mismatch')
  await expect(applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:'wrong'})).rejects.toThrow('policy_version_mismatch')
  const changed=structuredClone(m);changed.items[0].revision='999'
  await expect(applyLifecycleManifest(pool,changed,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})).rejects.toThrow('manifest_digest_mismatch')
 })
 test('AC-50 checkpoint_resume_preserves_user_edit',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal])
  await pool.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[f.claim])
  const options={expectedDigest:manifestDigest(m),policyVersion:m.policyVersion}
  const a=await applyLifecycleManifest(pool,m,options),b=await applyLifecycleManifest(pool,m,options)
  expect(a.complete).toBe(true);expect(b.complete).toBe(true)
  expect((await pool.query('SELECT outcome FROM memory_lifecycle_migration_items')).rows).toEqual([{outcome:'preserved_concurrent_change'}])
  expect((await pool.query('SELECT count(*)::int n FROM memory_claim_lifecycle')).rows[0].n).toBe(0)
 })
 test('AC-51 deleted_claim_not_resurrected',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal]);await pool.query("UPDATE knowledge_claims SET state='revoked',revision=revision+1 WHERE claim_id=$1",[f.claim])
  await applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})
  expect((await pool.query('SELECT state FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].state).toBe('revoked')
  expect((await pool.query('SELECT count(*)::int n FROM memory_claim_lifecycle')).rows[0].n).toBe(0)
 })
 test('AC-49 corrected_protected_and_rejected_unchanged',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_versions SET authority='user_corrected' WHERE version_id=$1",[f.version])
  const entry=randomUUID();await pool.query('INSERT INTO memory_manual_entries(installation_id,entry_id,actor_scope_id) VALUES($1,$2,$1)',[f.personal,entry])
  for(const status of ['rejected','expired'])await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,manual_entry_id) VALUES(gen_random_uuid(),$1::uuid,0,'work_method','rejected synthetic','rejected synthetic','installation',$1::text,1,NOW(),$2,'manual_entry',$3)`,[f.personal,status,entry])
  const before=(await pool.query('SELECT candidate_id,status,revision,statement FROM memory_candidates ORDER BY candidate_id')).rows
  const m=await inventoryLifecycle(pool,[f.personal]);await applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})
  expect((await pool.query('SELECT protection FROM memory_claim_lifecycle')).rows[0].protection).toBe('user_corrected')
  expect((await verifyLifecycleManifest(pool,m)).status).toBe('pass')
  expect((await pool.query('SELECT candidate_id,status,revision,statement FROM memory_candidates ORDER BY candidate_id')).rows).toEqual(before)
 })
 test('AC-55 explicit_enabled_cutover',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal],{targetMode:'enabled'})
  expect(m.targetMode).toBe('enabled')
  await applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})
  expect((await pool.query('SELECT mode FROM memory_curation_policies WHERE installation_id=$1',[f.personal])).rows[0].mode).toBe('enabled')
 })
 test('AC-50 interrupted_batch_resumes_fixed_list',async()=>{
  const f=await fixture(),other=randomUUID();await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'work_method','installation','','other','expired')`,[other,f.personal])
  const m=await inventoryLifecycle(pool,[f.personal]),options={expectedDigest:manifestDigest(m),policyVersion:m.policyVersion,batchSize:1}
  expect((await applyLifecycleManifest(pool,m,options)).complete).toBe(false)
  expect((await pool.query('SELECT mode FROM memory_curation_policies WHERE installation_id=$1',[f.personal])).rows[0].mode).toBe('off')
  expect((await applyLifecycleManifest(pool,m,options)).complete).toBe(true)
  expect((await pool.query('SELECT count(*)::int n FROM memory_lifecycle_migration_items')).rows[0].n).toBe(2)
 })
 test('AC-51 deletion_watermark_change_refuses_stale_manifest',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal])
  await pool.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'deleted-session','user_delete',NOW())",[f.personal])
  await expect(applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})).rejects.toThrow('deletion_watermark_changed')
  expect((await pool.query('SELECT count(*)::int n FROM memory_claim_lifecycle')).rows[0].n).toBe(0)
 })
 test('AC-50 policy_change_refuses_stale_manifest',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal]);await pool.query('UPDATE memory_curation_policies SET revision=revision+1 WHERE installation_id=$1',[f.personal])
  await expect(applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})).rejects.toThrow('policy_or_authorization_changed')
 })
 test('AC-50 changed_tool_or_schema_refuses_apply',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal]),tool={...m,toolHash:'0'.repeat(64)}
  await expect(applyLifecycleManifest(pool,tool,{expectedDigest:manifestDigest(tool),policyVersion:m.policyVersion})).rejects.toThrow('tool_code_mismatch')
  const schema={...m,schema:m.schema-1};await expect(applyLifecycleManifest(pool,schema,{expectedDigest:manifestDigest(schema),policyVersion:m.policyVersion})).rejects.toThrow('schema_version_changed')
 })
 test('AC-55 unresolved_legacy_provider_result_blocks_cutover',async()=>{
  const f=await fixture(),m=await inventoryLifecycle(pool,[f.personal],{targetMode:'enabled'})
  await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code) SELECT gen_random_uuid(),$1,episode_id,decode(repeat('a',64),'hex'),'fixture','fixture',decode(repeat('b',64),'hex'),decode(repeat('c',64),'hex'),'enabled','failed','synthetic','synthetic','provider_result_unknown' FROM work_episodes WHERE installation_id=$1 LIMIT 1`,[f.personal])
  await expect(applyLifecycleManifest(pool,m,{expectedDigest:manifestDigest(m),policyVersion:m.policyVersion})).rejects.toThrow('legacy_work_in_flight')
 })
})
