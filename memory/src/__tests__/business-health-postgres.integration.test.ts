import pg from 'pg'
import {afterAll,beforeAll,expect,test,describe} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {loadBusinessHealth,evaluateBusinessHealth,summarizeBusinessHealth} from '../reporting/business-health.js'
import {createMemoryMetrics,updateBusinessHealthGauges} from '../metrics.js'
import {createStatusWorker} from '../reporting/status-worker.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const enabled=Boolean(url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1')
const suite=enabled?describe:describe.skip
suite('business health PostgreSQL',()=>{
 let pool:pg.Pool
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 async function healthRows(){return (await loadBusinessHealth(pool)).filter(row=>row.installation_id===id)}
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool);await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 test('faults, heartbeat, readiness and metrics recover from durable database state',async()=>{
  await pool.query(`DELETE FROM memory_installations WHERE installation_id=$1`,[id])
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version,created_at,last_pull_at,last_ack_at) VALUES($1,'pocketctl-memory','active','ready',1,NOW()-interval '2 hours',NOW(),NOW())`,[id])
  await pool.query(`INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')`,[id])
  let rows=await healthRows()
  expect(evaluateBusinessHealth(rows[0]).reasons).toEqual([])
  await pool.query(`UPDATE memory_installations SET last_ack_at=NOW()-interval '301 seconds' WHERE installation_id=$1`,[id])
  await pool.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,last_error_code,available_at,created_at) VALUES(gen_random_uuid(),$1,'extract_candidates','budget','budget_exceeded',NOW()+interval '1 day',NOW()-interval '2 hours'),(gen_random_uuid(),$1,'extract_candidates','old',NULL,NOW()-interval '2 hours',NOW()-interval '2 hours')`,[id])
  rows=await healthRows()
  expect(evaluateBusinessHealth(rows[0]).reasons).toEqual(['feed_stalled','budget_blocked','extraction_stalled'])
  expect(summarizeBusinessHealth(rows)).toMatchObject({status:'degraded',readiness:'ready',operational:{status:'degraded'}})
  const reports:Record<string,unknown>[]=[]
  await createStatusWorker({pool,providerVersion:'test',reportStatus:async row=>{if(row.installation_id===id)reports.push(row)}}).runOnce()
  expect(reports[0]).toMatchObject({state:'degraded',last_error_code:'feed_stalled'})
  const metrics=createMemoryMetrics()
  await updateBusinessHealthGauges(pool,metrics)
  expect(await metrics.registry.metrics()).toContain('pocketctl_memory_business_alerts{reason="budget_blocked"} 1')
  await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,data,payload_hash,projection_state,error_code) VALUES($1,1,1,'session-events','session','source','session','turn','message',NOW(),'{}','x'::bytea,'quarantined','oversized_content')`,[id])
  expect(evaluateBusinessHealth((await healthRows())[0]).reasons).toContain('evidence_gap')
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session',NOW(),NOW())`,[id])
  await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) VALUES($1,'turn','session','completed',NOW())`,[id])
  const episode=await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,gen_random_uuid(),'session','turn','ready','v1') RETURNING episode_id`,[id])
  await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,completed_at) VALUES(gen_random_uuid(),$1,$2,'x'::bytea,'v1','v1','x'::bytea,'x'::bytea,'enabled','succeeded','test','test',NOW())`,[id,episode.rows[0].episode_id])
  reports.length=0
  await createStatusWorker({pool,providerVersion:'test',reportStatus:async row=>{if(row.installation_id===id)reports.push(row)}}).runOnce()
  expect(reports[0].last_extract_at).toEqual(expect.any(String))
  expect(evaluateBusinessHealth((await healthRows())[0]).reasons).not.toContain('extraction_stalled')
  await pool.query(`DELETE FROM memory_feed_inbox WHERE installation_id=$1`,[id])
  // Paused installations must not produce false work alerts.
  await pool.query(`UPDATE memory_installations SET relay_status='paused' WHERE installation_id=$1`,[id])
  expect(evaluateBusinessHealth((await healthRows())[0]).reasons).toEqual([])
  await pool.query(`UPDATE memory_installations SET relay_status='active',last_ack_at=NOW() WHERE installation_id=$1`,[id])
  await pool.query(`UPDATE memory_jobs SET state='completed',last_error_code=NULL WHERE installation_id=$1`,[id])
  await updateBusinessHealthGauges(pool,metrics)
  for(const reason of ['feed_stalled','budget_blocked','extraction_stalled','evidence_gap'])expect(await metrics.registry.metrics()).toContain(`pocketctl_memory_business_alerts{reason="${reason}"} 0`)
  expect(summarizeBusinessHealth(await healthRows()).status).toBe('ready')
  await pool.query(`UPDATE memory_installations SET local_status='integrity_error',last_error_code='feed_integrity' WHERE installation_id=$1`,[id])
  reports.length=0
  await createStatusWorker({pool,providerVersion:'test',reportStatus:async row=>{if(row.installation_id===id)reports.push(row)}}).runOnce()
  expect(reports[0]).toMatchObject({state:'error',last_error_code:'feed_integrity'})
  await pool.query(`DELETE FROM memory_installations WHERE installation_id=$1`,[id])
 })
})
