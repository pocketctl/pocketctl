import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createLifecycleService} from '../claims/lifecycle-service.js'
import type {ClaimRepository} from '../claims/repository.js'
import {reclaimClaimHistory,reclaimColdClaimBody} from '../retention/claim-history.js'
import {createMemoryReadService} from '../retrieval/read-service.js'
import {randomUUID,createHash} from 'node:crypto'
import {reclaimSourceTurn,type SourceRetentionSettings} from '../retention/source.js'
import {lifecycleSourceDigest} from '../curation/task-repository.js'
import {LIFECYCLE_SOURCE_POLICY} from '../episodes/source-admission.js'
import {capturePrivacyWatermarks,replayPrivacyWatermarks} from '../migrations/governance-v2/reconcile.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('lifecycle retention',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 const service=(mode:'off'|'shadow'|'enabled'='off')=>createLifecycleService(pool,{correctClaim(){},supersedeClaim(){}} as unknown as ClaimRepository,{lifecycleMode:mode})
 async function eligible(){
  const f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_curation_policies(installation_id,mode,cold_mode,reclaim_mode) VALUES($1,'enabled','enabled','enabled')",[f.personal])
  const bundle=randomUUID(),run=randomUUID(),digest=createHash('sha256').update('retention-fixture').digest()
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2,'authority-fixture','authority-fixture',$3,1,'completed')`,[f.personal,bundle,digest])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,$4,1,$5,$5,'enabled','completed')`,[f.personal,run,bundle,digest,'a'.repeat(64)])
  await pool.query(`INSERT INTO memory_curation_decisions(installation_id,run_id,action,idempotency_key,claim_id,version_id,reason_code,state) VALUES($1,$2,'create','fixture',$3,$4,'fixture','committed')`,[f.personal,run,f.claim,f.version])
  await pool.query("UPDATE knowledge_versions SET authority='machine_concluded' WHERE version_id=$1",[f.version])
  await pool.query("UPDATE knowledge_claims SET created_at=clock_timestamp()-interval '91 days' WHERE claim_id=$1",[f.claim])
  await pool.query(`INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,observation_state,observation_started_at,value_assessment)
   VALUES($1,$2,'method','verified','observed',clock_timestamp()-interval '91 days','low')`,[f.personal,f.claim])
  await pool.query(`INSERT INTO memory_lifecycle_observation_windows(installation_id,state,started_at,last_heartbeat_at,capability_since_at,last_native_delivery_at,settings_hash) VALUES($1,'observed',clock_timestamp()-interval '91 days',clock_timestamp(),clock_timestamp()-interval '92 days',clock_timestamp(),'synthetic-test-coverage')`,[f.personal])
  return f
 }
 test('AC-34 scheduled evaluation exists and off policy leaves hot knowledge untouched',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'method','verified')",[f.personal,f.claim])
  const evaluator=(service() as unknown as {evaluateDueClaims?:()=>Promise<unknown>}).evaluateDueClaims
  expect(typeof evaluator).toBe('function')
  await evaluator!()
  expect((await pool.query('SELECT storage_tier FROM memory_claim_lifecycle')).rows[0].storage_tier).toBe('hot')
 })
 test('AC-33 explicit expiry ignores pin and does not reactivate an old answer',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,protection) VALUES($1,$2,'constraint','verified','pinned')",[f.personal,f.claim])
  await pool.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval '1 second' WHERE version_id=$1",[f.version])
  expect(await service().expireDueClaims()).toBe(1)
  expect((await pool.query('SELECT state,current_version_id FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0]).toEqual({state:'expired',current_version_id:f.version})
  expect(await service().expireDueClaims()).toBe(0)
 })
 test('AC-34 cold transition invalidates generation and shadow writes nothing',async()=>{
  const f=await eligible()
  const before=(await pool.query('SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=$1',[f.personal])).rows[0].generation
  expect(await service('shadow').evaluateDueClaims()).toMatchObject({evaluated:1,cooled:0})
  expect((await pool.query('SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=$1',[f.personal])).rows[0].generation).toBe(before)
  expect(await service('enabled').evaluateDueClaims()).toMatchObject({evaluated:1,cooled:1})
  expect((await pool.query('SELECT storage_tier,cold_since FROM memory_claim_lifecycle')).rows[0]).toMatchObject({storage_tier:'cold',cold_since:expect.any(Date)})
  expect(BigInt((await pool.query('SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=$1',[f.personal])).rows[0].generation)).toBeGreaterThan(BigInt(before))
  expect(await service('enabled').evaluateDueClaims()).toMatchObject({cooled:0})
 })
 test('AC-35 missing observation cannot cool even after many years',async()=>{
  await eligible();await pool.query("UPDATE memory_claim_lifecycle SET observation_state='unknown',observation_started_at=NULL")
  expect(await service('enabled').evaluateDueClaims()).toMatchObject({cooled:0})
 })
 test('AC-35 stale coverage heartbeat cannot cool even if claim observation is marked observed',async()=>{
  await eligible();await pool.query("UPDATE memory_lifecycle_observation_windows SET last_heartbeat_at=clock_timestamp()-interval '6 minutes'")
  expect(await service('enabled').evaluateDueClaims()).toMatchObject({cooled:0})
 })
 test('AC-36 reactivation checks grant, source and exact claim revision',async()=>{
  const f=await eligible();await service('enabled').evaluateDueClaims()
  const grant={primaryInstallationId:f.personal,configVersion:'1',scopeBindings:[{installation_id:f.personal,owner_scope_kind:'personal' as const,owner_scope_id:f.personal,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','contribute']}]}
  const input={installationId:f.personal,claimId:f.claim,expectedRevision:2,grant,frame:{repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null}}
  await expect(service('enabled').reactivateClaim({...input,expectedRevision:1})).rejects.toThrow('lifecycle_conflict')
  await expect(service('enabled').reactivateClaim({...input,grant:{...grant,scopeBindings:[]}})).rejects.toThrow('scope authority')
  expect(await service('enabled').reactivateClaim(input)).toBe(true)
  expect((await pool.query('SELECT storage_tier FROM memory_claim_lifecycle')).rows[0].storage_tier).toBe('hot')
 })
 test('AC-37 history keeps latest three union ninety days union rollback and returns unavailable bodies',async()=>{
  const f=await eligible(),ids=[f.version]
  await pool.query("UPDATE knowledge_versions SET created_at=clock_timestamp()-interval '180 days' WHERE version_id=$1",[f.version])
  for(let n=2;n<=8;n++){const id=randomUUID();ids.push(id);await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,created_at)
   VALUES($1,$2,$3,$4,$5,'user_accepted',0.9,clock_timestamp()-($6::int*interval '1 day'))`,[id,f.personal,f.claim,n,`version ${n} body`,n===4?10:180])}
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[f.claim,ids[7]])
  await pool.query("INSERT INTO memory_version_retention_protections(installation_id,version_id,reason) VALUES($1,$2,'rollback')",[f.personal,ids[2]])
  expect(await reclaimClaimHistory(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'shadow',readerCompatible:true})).toMatchObject({versions:0})
  const result=await reclaimClaimHistory(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})
  expect(result.versions).toBe(3);expect(result.bodyBytes).toBeGreaterThan(0)
  const rows=(await pool.query('SELECT version_number,body_state FROM knowledge_versions ORDER BY version_number')).rows
  expect(rows.filter(r=>r.body_state==='reclaimed').map(r=>r.version_number)).toEqual([1,2,5])
  const detail=await createMemoryReadService(pool,'fixture-key').getClaim(f.personal,f.claim)
  expect(detail!.versions[0]).toMatchObject({statement:null,structured_content:null,body_state:'reclaimed',availability:'body_reclaimed',body_hash:expect.stringMatching(/^[a-f0-9]{64}$/)})
  await expect(pool.query("UPDATE knowledge_versions SET statement='restored old body',body_state='present' WHERE version_id=$1",[f.version])).rejects.toThrow('version_body_reclaimed')
  expect((await reclaimClaimHistory(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})).versions).toBe(0)
 })
 test('AC-34 cold body needs full grace, is physically cleared and cannot reactivate',async()=>{
  const f=await eligible();await service('enabled').evaluateDueClaims()
  expect((await reclaimColdClaimBody(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})).versions).toBe(0)
  await pool.query("UPDATE memory_claim_lifecycle SET cold_since=clock_timestamp()-interval '90 days'")
  const result=await reclaimColdClaimBody(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})
  expect(result.versions).toBe(1)
  expect((await pool.query('SELECT statement,body_state FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0]).toEqual({statement:'[content reclaimed]',body_state:'reclaimed'})
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_evidence WHERE version_id=$1',[f.version])).rows[0].n).toBe(0)
  expect(await createMemoryReadService(pool,'key').selectClaimVersion(f.personal,f.claim)).toBeNull()
 })
 async function taskSource(){
  const f=await eligible(),eventId=randomUUID()
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'task-source',NOW()-interval '30 days',NOW()-interval '30 days')`,[f.personal])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at,updated_at) VALUES($1,'task-turn','task-source','completed',NOW()-interval '30 days',NOW()-interval '30 days')`,[f.personal])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,created_at)
   VALUES($1,$2,'feed','task-event','task-source','task-turn','message',NOW()-interval '30 days','{"text":"excluded source body"}',$3,NOW()-interval '30 days')`,[eventId,f.personal,createHash('sha256').update('body').digest()])
  const events=(await pool.query('SELECT * FROM source_events WHERE source_event_id=$1',[eventId])).rows
  const digest=lifecycleSourceDigest(f.personal,events)
  await pool.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete,created_at)
   VALUES($1,'task-source','task-turn',$2,$3,'skipped_policy',0,1,true,NOW()-interval '20 days')`,[f.personal,digest,LIFECYCLE_SOURCE_POLICY])
  return {...f,eventId,digest,key:{installationId:f.personal,sessionId:'task-source',turnId:'task-turn',episodeId:null}}
 }
 const sourceSettings:SourceRetentionSettings={mode:'enabled',lifecycleMode:'enabled',bodyDays:14,batchSize:20,intervalMs:86400000}
 test('AC-38 complete legal zero-result receipt reclaims a settled turn without an Episode',async()=>{
  const f=await taskSource()
  expect(await reclaimSourceTurn(pool,f.key,sourceSettings)).toMatchObject({events:1,finished:true})
  expect((await pool.query('SELECT payload,body_reclaimed_at FROM source_events WHERE source_event_id=$1',[f.eventId])).rows[0]).toMatchObject({payload:{},body_reclaimed_at:expect.any(Date)})
  expect(await reclaimSourceTurn(pool,f.key,sourceSettings)).toMatchObject({events:0,finished:true})
  await expect(pool.query(`INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) VALUES($1,$2,$3,$4,1)`,[f.personal,randomUUID(),f.eventId,f.digest])).rejects.toThrow('source_body_reclaimed')
 })
 test('fresh bundle membership reads the source by UUID even when a retained turn has many sources',async()=>{
  const f=await taskSource(),bundle=randomUUID(),freshEvent=randomUUID()
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   SELECT gen_random_uuid(),$1,'feed','retained-fixture-'||n,'task-source','task-turn','message',now(),'{"text":"retention fixture source"}'::jsonb,$2
   FROM generate_series(1,4096) AS n`,[f.personal,f.digest])
  await pool.query(`INSERT INTO memory_source_retention_receipts(installation_id,turn_id,session_id,source_digest,compiler_version,extraction_completed_at,state,finished_at)
   VALUES($1,'task-turn','task-source',$2,'fixture',now(),'reclaimed',now())`,[f.personal,f.digest])
  await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash)
   VALUES($1,$2,'feed','fresh-fixture','task-source','fresh-turn','message',now(),'{"text":"retention fixture source"}',$3)`,[freshEvent,f.personal,f.digest])
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark)
   VALUES($1,$2,'task-source','fresh-bundle',$3,1)`,[f.personal,bundle,f.digest])
  await pool.query('ANALYZE source_events')
  await pool.query('ANALYZE memory_source_retention_receipts')
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   await client.query('SET LOCAL plan_cache_mode=force_generic_plan; SET LOCAL max_parallel_workers_per_gather=0')
   await client.query(`INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence)
    VALUES($1,$2,$3,$4,1)`,[f.personal,bundle,freshEvent,f.digest])
   const {reads}=(await client.query<{reads:number}>(`SELECT (seq_tup_read+idx_tup_fetch)::int AS reads
    FROM pg_stat_xact_user_tables WHERE relid='source_events'::regclass`)).rows[0]
   expect(reads).toBeLessThan(64)
  }finally{
   await client.query('ROLLBACK')
   client.release()
  }
 })
 test('AC-38 digest changes and unknown/failed/incomplete coverage do not reclaim',async()=>{
  const f=await taskSource()
  await pool.query("UPDATE memory_source_processing_receipts SET complete=false")
  expect((await reclaimSourceTurn(pool,f.key,sourceSettings)).skipped).toBe('not_eligible')
  await pool.query("UPDATE memory_source_processing_receipts SET complete=true")
  await pool.query("UPDATE source_events SET payload_hash=$2 WHERE source_event_id=$1",[f.eventId,createHash('sha256').update('new source').digest()])
  expect((await reclaimSourceTurn(pool,f.key,sourceSettings)).skipped).toBe('not_eligible')
 })
 test('AC-38 active task and failed run protect sources; settled task prose is reclaimed with a replay fence',async()=>{
  const f=await taskSource(),bundle=randomUUID(),run=randomUUID()
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state) VALUES($1,$2,'task-source','active',$3,1,'pending')`,[f.personal,bundle,f.digest])
  await pool.query(`INSERT INTO memory_task_bundle_sources(installation_id,bundle_id,source_event_id,source_digest,source_sequence) SELECT $1,$2,source_event_id,payload_hash,1 FROM source_events WHERE source_event_id=$3`,[f.personal,bundle,f.eventId])
  expect((await reclaimSourceTurn(pool,f.key,sourceSettings)).skipped).toBe('not_eligible')
  await pool.query("UPDATE memory_task_bundles SET state='completed' WHERE bundle_id=$1",[bundle])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,result) VALUES($1,$2,$3,1,$4,1,$5,$5,'enabled','failed','{"text":"temporary conclusion"}')`,[f.personal,run,bundle,f.digest,'b'.repeat(64)])
  expect((await reclaimSourceTurn(pool,f.key,sourceSettings)).skipped).toBe('not_eligible')
  await pool.query("UPDATE memory_curation_runs SET state='completed' WHERE run_id=$1",[run])
  expect((await reclaimSourceTurn(pool,f.key,sourceSettings)).finished).toBe(true)
  expect((await pool.query('SELECT result FROM memory_curation_runs WHERE run_id=$1',[run])).rows[0].result).toBeNull()
  await expect(pool.query("UPDATE memory_task_bundles SET body_state='present' WHERE bundle_id=$1",[bundle])).rejects.toThrow('task_body_reclaimed')
  await expect(pool.query("UPDATE memory_curation_runs SET result='{}' WHERE run_id=$1",[run])).rejects.toThrow('task_body_reclaimed')
 })
 test('AC-40 concurrent version reference blocks reclamation atomically and retry completes',async()=>{
  const f=await eligible();await service('enabled').evaluateDueClaims()
  await pool.query("UPDATE memory_claim_lifecycle SET cold_since=clock_timestamp()-interval '90 days'")
  const reader=await pool.connect()
  try{
   await reader.query('BEGIN');await reader.query('SELECT version_id FROM knowledge_versions WHERE version_id=$1 FOR SHARE',[f.version])
   await expect(reclaimColdClaimBody(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})).rejects.toThrow(/lock timeout/)
   expect((await pool.query('SELECT body_state FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].body_state).toBe('present')
  }finally{await reader.query('ROLLBACK');reader.release()}
  expect((await reclaimColdClaimBody(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})).versions).toBe(1)
 })
 test('AC-39 restored version body is redacted from the latest watermark while writers stay held',async()=>{
  const f=await eligible();await service('enabled').evaluateDueClaims()
  const original=(await pool.query('SELECT statement,structured_content FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0]
  await pool.query("UPDATE memory_claim_lifecycle SET cold_since=clock_timestamp()-interval '90 days'")
  await reclaimColdClaimBody(pool,{installationId:f.personal,claimId:f.claim},{lifecycleMode:'enabled',readerCompatible:true})
  const watermark=JSON.parse(JSON.stringify(await capturePrivacyWatermarks(pool)))
  expect(watermark.reclaimedVersionBodies).toHaveLength(1)
  // Only the isolated DB owner can simulate old backup rows; production paths
  // cannot disable this trigger or return a reclaimed body to present.
  await pool.query('ALTER TABLE knowledge_versions DISABLE TRIGGER memory_version_body_guard')
  try{await pool.query("UPDATE knowledge_versions SET statement=$2,structured_content=$3,body_state='present',body_hash=NULL,body_reclaimed_at=NULL WHERE version_id=$1",[f.version,original.statement,original.structured_content])}
  finally{await pool.query('ALTER TABLE knowledge_versions ENABLE TRIGGER memory_version_body_guard')}
  await replayPrivacyWatermarks(pool,watermark,{purgeHmacKey:'restore-test'})
  expect((await pool.query('SELECT body_state,statement FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0]).toEqual({body_state:'reclaimed',statement:'[content reclaimed]'})
  expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.personal])).rows[0].local_status).toBe('integrity_error')
  await expect(replayPrivacyWatermarks(pool,{...watermark,reclaimedVersionBodies:undefined},{purgeHmacKey:'restore-test'})).rejects.toThrow('restore_lifecycle_watermarks_required')
 })
})
