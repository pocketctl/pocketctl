import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createMemoryMetrics,updateBusinessHealthGauges} from '../metrics.js'
import {loadLifecycleHealth,summarizeLifecycleHealth} from '../reporting/lifecycle-health.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('bounded lifecycle health PostgreSQL',()=>{
 let pool:pg.Pool
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)})
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_installations CASCADE')
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id])
  await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,state,authorization_epoch) VALUES($1,'personal',$1,'active',1)`,[id])
  await pool.query(`INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled')`,[id])
  await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'session',NOW(),NOW())`,[id])
 })
 afterAll(async()=>{await pool?.end()})
 async function turns(n:number){await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,terminal_at) SELECT $1,'turn-'||lpad(n::text,6,'0'),'session','completed',NOW() FROM generate_series(1,$2::int)n`,[id,n])}
 async function receipt(digest:number,disposition:string,complete:boolean,ago:string){await pool.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete,created_at) VALUES($1,'session','turn-000001',decode(repeat($2,32),'hex'),'v1',$3,0,1,$4,NOW()-$5::interval)`,[id,digest.toString().padStart(2,'0'),disposition,complete,ago])}
 test('latest receipt wins over historical revisions and missing turns remain visible',async()=>{
  await turns(2);await receipt(1,'provenance_unknown',false,'2 hours');await receipt(2,'no_durable_conclusion',true,'1 hour')
  const result=summarizeLifecycleHealth(await loadLifecycleHealth(pool,'enabled'),'enabled')
  expect(result.coverage).toMatchObject({turns:2,receipt_turns:1,complete_turns:1,provenance_unknown_turns:0,missing_receipt_turns:1,counts_capped:false,status:'limited'})
 })
 test('pre-policy historical and running turns do not create coverage alarms',async()=>{
  await turns(3)
  await pool.query("UPDATE source_turns SET updated_at=NOW()-interval '1 day' WHERE turn_id='turn-000001'")
  await pool.query("UPDATE source_turns SET state='running',terminal_at=NULL WHERE turn_id='turn-000002'")
  await pool.query("UPDATE source_turns SET state='interrupt_requested',terminal_at=NULL WHERE turn_id='turn-000003'")
  const result=summarizeLifecycleHealth(await loadLifecycleHealth(pool,'enabled'),'enabled')
  expect(result.coverage).toMatchObject({turns:0,missing_receipt_turns:0,status:'idle',observation_window_basis:'per_installation_policy_updated_at'})
  expect(result.coverage.observation_window_start).toEqual(expect.any(String))
  expect(result.execution.status).toBe('idle')
 })
 test('current bundle revision failures alert, superseded failed runs do not',async()=>{
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,revision,state,updated_at,next_evaluate_at) VALUES($1,$1,'session','source:turn-000001',decode(repeat('aa',32),'hex'),1,2,'blocked',NOW()-interval '2 hours',NOW()-interval '1 hour')`,[id])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$1,1,decode(repeat('aa',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','failed')`,[id])
  let rows=await loadLifecycleHealth(pool,'enabled')
  expect(rows[0]).toMatchObject({consolidation_failed:0,consolidation_stalled:1})
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state) VALUES($1,$1,2,decode(repeat('aa',32),'hex'),1,repeat('a',64),repeat('b',64),'enabled','failed')`,[id])
  rows=await loadLifecycleHealth(pool,'enabled')
  expect(summarizeLifecycleHealth(rows,'enabled').execution.status).toBe('degraded')
  expect(rows[0].consolidation_failed).toBe(1)
  expect(summarizeLifecycleHealth(rows,'off').execution.status).toBe('disabled')
 })
 test('metrics distinguish shadow coverage from execution and clear disabled alerts',async()=>{
  await turns(1);await receipt(1,'provenance_unknown',false,'1 hour')
  const metrics=createMemoryMetrics()
  await updateBusinessHealthGauges(pool,metrics,true,'shadow')
  let text=await metrics.registry.metrics()
  expect(text).toContain('pocketctl_memory_lifecycle_alerts{reason="source_provenance_unknown"} 1')
  expect(text).toContain('pocketctl_memory_lifecycle_execution{state="healthy"} 1')
  expect(text).toContain('pocketctl_memory_lifecycle_coverage{kind="provenance_unknown_turns"} 1')
  expect(text).toContain('pocketctl_memory_lifecycle_modes{stage="curation",mode="shadow"} 1')
  await updateBusinessHealthGauges(pool,metrics,true,'off')
  text=await metrics.registry.metrics()
  expect(text).toContain('pocketctl_memory_lifecycle_alerts{reason="source_provenance_unknown"} 0')
  expect(text).toContain('pocketctl_memory_lifecycle_execution{state="disabled"} 1')
  expect(text).not.toContain(id)
 })
 test('indexed metadata access avoids sorting terminal-turn and latest receipt histories',async()=>{
  await turns(1);await receipt(1,'provenance_unknown',false,'1 hour')
  const client=await pool.connect()
  try{
   await client.query('BEGIN READ ONLY')
   await client.query('SET LOCAL enable_seqscan=off')
   await client.query('SET LOCAL enable_bitmapscan=off')
   const turnsPlan=(await client.query(`EXPLAIN(FORMAT JSON) SELECT turn_id,session_id FROM source_turns
    WHERE installation_id=$1 AND state IN('completed','interrupted','failed','abandoned')
     AND updated_at>NOW()-interval '1 hour' ORDER BY updated_at DESC,turn_id LIMIT 1001`,[id])).rows[0]['QUERY PLAN']
   const receiptPlan=(await client.query(`EXPLAIN(FORMAT JSON) SELECT disposition,complete FROM memory_source_processing_receipts
    WHERE installation_id=$1 AND turn_id='turn-000001' AND session_id='session'
    ORDER BY created_at DESC,source_digest,policy_version LIMIT 1`,[id])).rows[0]['QUERY PLAN']
   expect(JSON.stringify(turnsPlan)).toContain('memory_source_turns_lifecycle_health')
   expect(JSON.stringify(receiptPlan)).toContain('memory_processing_receipt_latest')
   expect(JSON.stringify(turnsPlan)).not.toContain('"Node Type":"Sort"')
   expect(JSON.stringify(receiptPlan)).not.toContain('"Node Type":"Sort"')
  }finally{await client.query('ROLLBACK');client.release()}
 })
 test('metadata sample caps without reading source bodies or claiming full coverage',async()=>{
  await turns(1002)
  const result=summarizeLifecycleHealth(await loadLifecycleHealth(pool,'enabled'),'enabled')
  expect(result.coverage).toMatchObject({turns:1000,missing_receipt_turns:1000,counts_capped:true,status:'limited'})
 })
})
