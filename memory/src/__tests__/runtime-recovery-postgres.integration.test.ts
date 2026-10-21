import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {queryHealth} from '../reporting/health-query.js'
import {recoverRuntime} from '../maintenance/recover-runtime.js'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {createExtractionRepository} from '../extraction/repository.js'
import {loadBudgetUncertainty,loadBusinessHealth,evaluateBusinessHealth,summarizeBusinessHealth} from '../reporting/business-health.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const id='c1111111-1111-4111-8111-111111111111'
const ep='c2222222-2222-4222-8222-222222222222'
const run='c3333333-3333-4333-8333-333333333333'
const gap={envelope_version:1,feed_id:'1',topic:'session.event.v1',source:{kind:'canonical_event',id:'event-1',recorded_at:'2026-10-21T00:00:00Z'},subject:{session_id:'session-1',event_type:'command_list'},classification:{},data:{},quarantine:{reason:'oversized_content',original_bytes:800000,original_sha256:'a'.repeat(64)}}
suite('runtime recovery and sustained failure health',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:2});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},30000)
 afterAll(async()=>{if(pool){await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[id]);await pool.end()}})
 beforeEach(async()=>{
  await pool.query(`DELETE FROM memory_installations WHERE installation_id=$1`,[id])
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version,last_ack_at) VALUES($1,'pocketctl-memory','active','ready',1,NOW())`,[id])
  await pool.query(`INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')`,[id])
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session-1',NOW(),NOW())`,[id])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'turn-1','session-1','completed',NOW())`,[id])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,compiled_at) VALUES($1,$2,'session-1','turn-1','ready','v1','x'::bytea,NOW())`,[id,ep])
 })
 async function seedGap(value=gap){await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,event_type,recorded_at,data,payload_hash,projection_state,error_code,session_id) VALUES($1,1,1,'quarantined','relay','quarantine-1','quarantined',NOW(),$2,$3,'quarantined','oversized_content','session-1')`,[id,value.quarantine,canonicalPayloadHash(value)])}
 async function seedFailure(){await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,error_code,started_at,completed_at) VALUES($1,$2,$3,'x'::bytea,'v1','v1','x'::bytea,'x'::bytea,'enabled','failed','test','test','provider_result_unknown',NOW()-interval '11 minutes',NOW()-interval '10 minutes')`,[run,id,ep])}
 async function health(){return (await loadBusinessHealth(pool)).find(row=>row.installation_id===id)!}
 test('preview rolls back; verified discovery repair restores extraction and queues current digest once',async()=>{
  await seedGap()
  expect(await createExtractionRepository(pool).loadEpisodeForExtraction(id,'turn-1')).toBeNull()
  const input={installationId:id,discoveryEnvelopes:[gap]}
  expect(await recoverRuntime(pool,input)).toMatchObject({applied:false,reclassified:['1'],scheduledEpisodes:[ep]})
  expect((await pool.query(`SELECT error_code FROM memory_feed_inbox WHERE installation_id=$1`,[id])).rows[0].error_code).toBe('oversized_content')
  expect((await pool.query(`SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1`,[id])).rows[0].n).toBe(0)
  expect(await recoverRuntime(pool,{...input,apply:true})).toMatchObject({applied:true,reclassified:['1'],scheduledEpisodes:[ep]})
  expect(await createExtractionRepository(pool).loadEpisodeForExtraction(id,'turn-1')).not.toBeNull()
  expect(evaluateBusinessHealth(await health()).reasons).not.toContain('evidence_gap')
  const stored=(await pool.query(`SELECT payload_hash,data,error_code,event_type FROM memory_feed_inbox WHERE installation_id=$1`,[id])).rows[0]
  expect(stored.payload_hash.equals(canonicalPayloadHash(gap))).toBe(true)
  expect(stored.data).toMatchObject({...gap.quarantine,previous_error_code:'oversized_content'})
  expect(stored.data.impact_reclassified_at).toBeTruthy()
  expect(stored.event_type).toBe('command_list')
  expect((await pool.query(`SELECT payload FROM memory_jobs WHERE installation_id=$1`,[id])).rows[0].payload).toEqual({turn_id:'turn-1',expected_source_digest:'78'})
  expect(await recoverRuntime(pool,{...input,apply:true})).toMatchObject({alreadyClassified:['1'],reclassified:[],scheduledEpisodes:[]})
 })
 test('health query cancels slow server work and releases a usable connection',async()=>{
  await expect(queryHealth(pool,'SELECT pg_sleep(10)')).rejects.toMatchObject({code:'57014'})
  expect((await queryHealth(pool,'SELECT 1 AS alive')).rows[0].alive).toBe(1)
  expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0')
 },10000)
 test('turn-scoped discovery recovery queues only the originally blocked turn',async()=>{
  const scoped={...gap,subject:{...gap.subject,turn_id:'turn-1'}}
  await seedGap(scoped)
  await pool.query(`UPDATE memory_feed_inbox SET turn_id='turn-1' WHERE installation_id=$1`,[id])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state) VALUES($1,'other-turn','session-1','completed')`,[id])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,compiled_at) VALUES($1,gen_random_uuid(),'session-1','other-turn','ready','v1','y'::bytea,NOW())`,[id])
  expect(await recoverRuntime(pool,{installationId:id,discoveryEnvelopes:[scoped],apply:true})).toMatchObject({scheduledEpisodes:[ep]})
 })
 test('uncertain reservation is visible even when fallback run succeeded and clears on settlement',async()=>{
  await pool.query(`DELETE FROM memory_provider_budget_reservations WHERE budget_key='runtime-health-test'`)
  const initial=await loadBudgetUncertainty(pool)
  await seedFailure()
  await pool.query(`UPDATE memory_extraction_runs SET state='succeeded',error_code=NULL WHERE run_id=$1`,[run])
  const inserted=await pool.query(`INSERT INTO memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens,state,created_at) VALUES(gen_random_uuid(),'runtime-health-test','text',101,202,'reserved',NOW()-interval '6 minutes') RETURNING created_at >= date_trunc('day',NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS current_window`)
  const eligible=inserted.rows[0].current_window?1:0
  expect(evaluateBusinessHealth(await health()).reasons).not.toContain('extraction_failed')
  expect(await loadBudgetUncertainty(pool)).toMatchObject({scope:'provider_pool',aged_reserved_requests:initial.aged_reserved_requests+eligible,reserved_input_tokens:initial.reserved_input_tokens+eligible*101,reserved_output_tokens:initial.reserved_output_tokens+eligible*202})
  await pool.query(`UPDATE memory_provider_budget_reservations SET state='settled' WHERE budget_key='runtime-health-test'`)
  expect(await loadBudgetUncertainty(pool)).toEqual(initial)
  await pool.query(`DELETE FROM memory_provider_budget_reservations WHERE budget_key='runtime-health-test'`)
 })
 test('tampered provenance, real content and deleted source cannot be reclassified',async()=>{
  await seedGap()
  await expect(recoverRuntime(pool,{installationId:id,discoveryEnvelopes:[{...gap,source:{...gap.source,id:'other'}}],apply:true})).rejects.toThrow('mismatch')
  await expect(recoverRuntime(pool,{installationId:id,discoveryEnvelopes:[{...gap,subject:{...gap.subject,event_type:'agent_text'}}],apply:true})).rejects.toThrow('verified_discovery')
  await pool.query(`UPDATE source_sessions SET deleted_at=NOW() WHERE installation_id=$1`,[id])
  await expect(recoverRuntime(pool,{installationId:id,discoveryEnvelopes:[gap],apply:true})).rejects.toThrow('deleted')
 })
 test('remaining content gap continues blocking the session and no repair job is queued',async()=>{
  await seedGap()
  await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,classification,data,payload_hash,received_at,projection_state,projected_at,error_code) SELECT installation_id,2,envelope_version,topic,source_kind,'quarantine-2',session_id,turn_id,event_type,recorded_at,classification,data,payload_hash,received_at,projection_state,projected_at,error_code FROM memory_feed_inbox WHERE installation_id=$1`,[id])
  expect(await recoverRuntime(pool,{installationId:id,discoveryEnvelopes:[gap],apply:true})).toMatchObject({reclassified:['1'],scheduledEpisodes:[]})
  expect(await createExtractionRepository(pool).loadEpisodeForExtraction(id,'turn-1')).toBeNull()
 })
 test('current uncertain failed run may be scheduled once; stale packet and running/succeeded versions refuse',async()=>{
  await seedFailure()
  expect(await recoverRuntime(pool,{installationId:id,failedRunIds:[run]})).toMatchObject({applied:false,scheduledEpisodes:[ep]})
  expect(await recoverRuntime(pool,{installationId:id,failedRunIds:[run],apply:true})).toMatchObject({applied:true,scheduledEpisodes:[ep]})
  expect(await recoverRuntime(pool,{installationId:id,failedRunIds:[run],apply:true})).toMatchObject({scheduledEpisodes:[]})
  await pool.query(`UPDATE work_episodes SET source_digest='y'::bytea WHERE installation_id=$1`,[id])
  await expect(recoverRuntime(pool,{installationId:id,failedRunIds:[run],apply:true})).rejects.toThrow('not_current')
 })
 test('sustained current failure alerts independently of queue state and healthy work; recovery clears alert',async()=>{
  await seedFailure()
  let row=await health()
  expect(row.failed_jobs_24h).toBe('0')
  expect(evaluateBusinessHealth({...row,last_extract_seconds:1}).reasons).toContain('extraction_failed')
  expect(summarizeBusinessHealth([row])).toMatchObject({operational:{failed_extractions_24h:1,uncertain_extractions_24h:1,unresolved_extractions:1}})
  await pool.query(`UPDATE memory_extraction_runs SET completed_at=NOW() WHERE run_id=$1`,[run])
  expect(evaluateBusinessHealth(await health()).reasons).not.toContain('extraction_failed')
  await pool.query(`UPDATE memory_extraction_runs SET state='quarantined',error_code='invalid_output',completed_at=NOW()-interval '10 minutes' WHERE run_id=$1`,[run])
  expect(evaluateBusinessHealth(await health()).reasons).toContain('extraction_failed')
  await pool.query(`UPDATE work_episodes SET source_digest='y'::bytea WHERE installation_id=$1`,[id])
  expect(evaluateBusinessHealth(await health()).reasons).not.toContain('extraction_failed')
  await pool.query(`UPDATE work_episodes SET source_digest='x'::bytea WHERE installation_id=$1`,[id])
  await pool.query(`UPDATE memory_extraction_runs SET state='succeeded',error_code=NULL,completed_at=NOW() WHERE run_id=$1`,[run])
  expect(evaluateBusinessHealth(await health()).reasons).not.toContain('extraction_failed')
 })
})
