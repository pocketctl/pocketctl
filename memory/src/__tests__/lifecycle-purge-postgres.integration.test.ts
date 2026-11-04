import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPurgeRepository} from '../purge/repository.js'
import {capturePrivacyWatermarks,replayPrivacyWatermarks} from '../migrations/governance-v2/reconcile.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle purge',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 test('AC-39 deletion retains logical identity fence and blocks alternate canonical replay',async()=>{
  const f=await governanceFixture(pool),space=randomUUID(),entity=randomUUID(),key='e'.repeat(64)
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'work','project',ARRAY['work'])",[f.personal,space])
  await pool.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'service','service')",[f.personal,space,entity])
  const mapping=`INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,cardinality,claim_id) VALUES($1,$2,$3,$4,'config.timeout','single',$5)`
  await pool.query(mapping,[f.personal,space,entity,key,f.claim])
  await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1',[f.claim])
  expect((await pool.query('SELECT logical_key FROM memory_logical_tombstones WHERE installation_id=$1',[f.personal])).rows).toEqual([{logical_key:key}])
  const alternate=randomUUID()
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','','alternate-alias','active')`,[alternate,f.personal])
  await expect(pool.query(mapping,[f.personal,space,entity,key,alternate])).rejects.toThrow('logical_identity_deleted')
  await pool.query(mapping,[f.personal,space,entity,'f'.repeat(64),alternate])
  // Complete owner-row deletion cascades must not reinsert a child fence after
  // its installation FK target is gone (normal purge retains the owner row).
  await expect(pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[f.personal])).resolves.toMatchObject({rowCount:1})
 })
 test('AC-39 ordinary session purge removes task prose but retains unrelated independent knowledge',async()=>{
  const f=await governanceFixture(pool),bundle=randomUUID(),digest=createHash('sha256').update('source').digest()
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark) VALUES($1,$2,'delete-task','task',$3,1)`,[f.personal,bundle,digest])
  await pool.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete) VALUES($1,'delete-task','turn',$2,'v1','skipped_policy',0,1,true)`,[f.personal,digest])
  const space=randomUUID(),entity=randomUUID()
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','PRIVATE_SCENE_NAME',ARRAY['personal'])",[f.personal,space])
  await pool.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'person','PRIVATE_ENTITY_NAME')",[f.personal,space,entity])
  await pool.query("INSERT INTO memory_entity_aliases(installation_id,space_id,entity_id,alias) VALUES($1,$2,$3,'PRIVATE_ALIAS')",[f.personal,space,entity])
  await pool.query("INSERT INTO memory_session_scene_frames(installation_id,session_id,binding) VALUES($1,'delete-task',$2)",[f.personal,'c'.repeat(64)])
  const purge=createPurgeRepository(pool,{hmacKey:'retention-test-key'})
  await purge.purgeSession({installationId:f.personal,sessionId:'delete-task',reason:'user_deleted',sourceFeedId:null})
  expect((await pool.query('SELECT count(*)::int n FROM memory_task_bundles')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_source_processing_receipts')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM memory_session_scene_frames')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT claim_id FROM knowledge_claims WHERE installation_id=$1',[f.personal])).rows).toEqual([{claim_id:f.claim}])
  await purge.purgeInstallation({installationId:f.personal,requestId:randomUUID(),reason:'user_deleted'})
  expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.personal])).rows[0].local_status).toBe('purged')
  for(const table of ['memory_spaces','memory_entities','memory_entity_aliases','memory_session_scene_frames'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE installation_id=$1`,[f.personal])).rows[0].n).toBe(0)
 })
 test('AC-39 backup watermark records logical deletes and removes restored aliases before release',async()=>{
  const f=await governanceFixture(pool),space=randomUUID(),entity=randomUUID(),key='f'.repeat(64)
  await pool.query("INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'work','project',ARRAY['work'])",[f.personal,space])
  await pool.query("INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,'service','service')",[f.personal,space,entity])
  const mapping=`INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,cardinality,claim_id) VALUES($1,$2,$3,$4,'config.timeout','single',$5)`
  await pool.query(mapping,[f.personal,space,entity,key,f.claim]);await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1',[f.claim])
  const watermark=JSON.parse(JSON.stringify(await capturePrivacyWatermarks(pool)))
  expect(watermark.logicalTombstones).toEqual([expect.objectContaining({installation_id:f.personal,logical_key:key})])
  // Recreate the rows from an older backup, including its absent newer fence.
  await pool.query('DELETE FROM memory_logical_tombstones')
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','','old-backup','active')`,[f.claim,f.personal])
  await pool.query(mapping,[f.personal,space,entity,key,f.claim])
  await replayPrivacyWatermarks(pool,watermark,{purgeHmacKey:'restore-test'})
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.personal])).rows[0].local_status).toBe('integrity_error')
 })
 test('AC-39 installation purge removes repository Context dependencies before repositories and preserves other owners',async()=>{
  const f=await governanceFixture(pool),repository=randomUUID(),pack=randomUUID(),item=randomUUID(),injection=randomUUID(),loadout=randomUUID(),otherPack=randomUUID()
  await pool.query("INSERT INTO repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'purge-context-fixture',clock_timestamp(),clock_timestamp())",[repository,f.personal])
  for(const [owner,id,repo] of [[f.personal,pack,repository],[f.team,otherPack,null]])await pool.query(`INSERT INTO memory_context_packs(pack_id,installation_id,repository_id,session_id,client_request_id,agent,mode,effective_policy_hash,input_digest,state,stable_text)
   VALUES($1::uuid,$2,$3,'purge-context-session',$1::text,'codex','enabled',sha256('policy'),sha256('input'),'ready','PRIVATE_PACK_BODY')`,[id,owner,repo])
  await pool.query(`INSERT INTO memory_context_pack_items(pack_id,item_id,installation_id,claim_id,version_id,claim_type,layer,section,representation,rendered_text,reason_codes,ordinal)
   VALUES($1,$2,$3,$4,$5,'test_invariant','L2','stable','summary','PRIVATE_RENDERED_BODY','{}',0)`,[pack,item,f.personal,f.claim,f.version])
  await pool.query('INSERT INTO memory_context_pack_evidence(pack_id,item_id,installation_id,evidence_id) VALUES($1,$2,$3,$4)',[pack,item,f.personal,f.evidence])
  await pool.query(`INSERT INTO memory_context_injections(injection_id,installation_id,pack_id,session_id,client_request_id,agent,adapter,admission_nonce_hmac,state)
   VALUES($1,$2,$3,'purge-context-session','purge-context-request','codex','codex-app-server',sha256('nonce'),'prepared')`,[injection,f.personal,pack])
  await pool.query("INSERT INTO memory_context_feedback(feedback_id,installation_id,pack_id,injection_id,actor,action) VALUES(gen_random_uuid(),$1,$2,$3,'user','used')",[f.personal,pack,injection])
  await pool.query(`INSERT INTO memory_context_evidence_reads(receipt_id,installation_id,pack_id,source_installation_id,evidence_id,version_id,excerpt_hash,page,max_chars,consumption_generation)
   VALUES(gen_random_uuid(),$1,$2,$1,$3,$4,sha256('excerpt'),0,100,1)`,[f.personal,pack,f.evidence,f.version])
  await pool.query('INSERT INTO memory_context_loadouts(loadout_id,installation_id,repository_id) VALUES($1,$2,$3)',[loadout,f.personal,repository])
  await pool.query("INSERT INTO memory_context_loadout_items(loadout_id,item_id,asset_kind,installation_id,claim_id,representation,priority) VALUES($1,gen_random_uuid(),'claim',$2,$3,'summary',50)",[loadout,f.personal,f.claim])
  const purge=createPurgeRepository(pool,{hmacKey:'context-purge-test'}),input={installationId:f.personal,requestId:randomUUID(),reason:'user_deleted'}
  const receipt=await purge.purgeInstallation(input)
  expect(await purge.purgeInstallation(input)).toBe(receipt)
  for(const table of ['memory_context_feedback','memory_context_injections','memory_context_pack_evidence','memory_context_pack_items','memory_context_evidence_reads','memory_context_packs','memory_context_loadout_items','memory_context_loadouts','repositories'])
   expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE installation_id=$1`,[f.personal])).rows[0].n,table).toBe(0)
  expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.personal])).rows[0].local_status).toBe('purged')
  expect((await pool.query('SELECT pack_id FROM memory_context_packs WHERE installation_id=$1',[f.team])).rows).toEqual([{pack_id:otherPack}])
 })

})
