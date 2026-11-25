import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {bindSourcePool} from '../sources/pool-context.js'
import {LIFECYCLE_SOURCE_POLICY} from '../episodes/source-admission.js'
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
 async function receipt(digest:number,disposition:string,complete:boolean,ago:string){await pool.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,policy_version,disposition,allowed_count,excluded_count,complete,created_at) VALUES($1,'session','turn-000001',decode(repeat($2,32),'hex'),$6,$3,0,1,$4,NOW()-$5::interval)`,[id,digest.toString().padStart(2,'0'),disposition,complete,ago,LIFECYCLE_SOURCE_POLICY])}
 async function completedProjection(digest:number,mode:'enabled'|'shadow'){
  await pool.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,source_digest,watermark,state)
   VALUES($1,$1,'session','source:turn-000001',decode(repeat($2,32),'hex'),1,'completed')`,[id,digest.toString().padStart(2,'0')])
  await pool.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state)
   SELECT installation_id,bundle_id,revision,source_digest,1,repeat('a',64),repeat('b',64),$2,'completed' FROM memory_task_bundles WHERE installation_id=$1`,[id,mode])
 }
 test('historical projected receipts remain visible without proving current input',async()=>{
  await turns(2);await receipt(1,'provenance_unknown',false,'2 hours');await receipt(2,'no_durable_conclusion',true,'1 hour')
  const result=summarizeLifecycleHealth(await loadLifecycleHealth(pool,'enabled'),'enabled')
  expect(result.coverage).toMatchObject({turns:2,receipt_turns:0,complete_turns:0,missing_receipt_turns:2})
  expect(result.latest_recorded_projection_receipts).toEqual({receipt_turns:1,complete_turns:1,provenance_unknown_turns:0})
  await completedProjection(3,'enabled')
  await receipt(3,'no_durable_conclusion',true,'0 seconds')
  expect((await loadLifecycleHealth(pool,'enabled'))[0]).toMatchObject({receipt_turns:1,complete_turns:1,missing_receipt_turns:1})
 })
 test('native health follows current input, blocked intake and retained completion independently',async()=>{
  const client=await pool.connect()
  const db={query:client.query.bind(client)}
  bindSourcePool(db,{namespace:'memory'})
  try{
   await client.query('BEGIN')
   // The native columns also exist after the projection relations have been retired.
   await client.query(`CREATE TEMP TABLE work_episodes (LIKE public.work_episodes INCLUDING ALL) ON COMMIT DROP;
    ALTER TABLE work_episodes ADD COLUMN dialogue_completion jsonb;
    CREATE TEMP TABLE memory_task_bundles (LIKE public.memory_task_bundles INCLUDING ALL) ON COMMIT DROP;
    ALTER TABLE memory_task_bundles ADD COLUMN dialogue_members jsonb;
    CREATE TEMP TABLE memory_curation_runs (LIKE public.memory_curation_runs INCLUDING ALL) ON COMMIT DROP`)
   const turn='turn-000001', source='bb'.repeat(32), old='aa'.repeat(32), episode='cc'.repeat(32)
   await client.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,terminal_at,event_count,
    compiler_version,compiled_at,source_digest,evidence_manifest,dialogue_completion)
    VALUES($1,gen_random_uuid(),'session',$2,'ready',now(),2,'relay-turn-v1',now(),decode($3,'hex'),'{}',$4)`,
    [id,turn,episode,{digest:old,policy:1}])
   await client.query(`INSERT INTO memory_task_bundles(installation_id,session_id,task_key,source_digest,watermark,state,
    reason_code,dialogue_members) VALUES($1,'session',$2,decode($3,'hex'),2,'blocked','task_binding_changed',$4)`,
    [id,'dialogue:'+turn,source,JSON.stringify([{id:'a'},{id:'b'}])])
   const writeReceipt=async(digest:string,policy:string,disposition:string,complete:boolean)=>{
    await client.query(`INSERT INTO memory_source_processing_receipts(installation_id,session_id,turn_id,source_digest,
     policy_version,disposition,allowed_count,excluded_count,complete)
     VALUES($1,'session',$2,decode($3,'hex'),$4,$5,2,0,$6)`,[id,turn,digest,policy,disposition,complete])
   }
   await writeReceipt(old,LIFECYCLE_SOURCE_POLICY,'provenance_unknown',false)
   await writeReceipt(source,'obsolete-admission-policy','no_durable_conclusion',true)
   const report=async()=>summarizeLifecycleHealth(await loadLifecycleHealth(db,'enabled'),'enabled')
   expect(await report()).toMatchObject({input_coverage:{trusted_turns:1,unknown_turns:0},
    coverage:{turns:1,receipt_turns:0,missing_receipt_turns:1,complete_turns:0,blocked_turns:1},decisions:{committed:0}})

   // A marker under an old curation policy cannot certify processing, even for the right digest.
   const marker=async(value:Record<string,unknown>)=>client.query('UPDATE work_episodes SET dialogue_completion=$1',[value])
   await marker({digest:source,policy:9})
   expect((await report()).coverage.complete_turns).toBe(0)
   await client.query("UPDATE memory_task_bundles SET state='completed'")
   await marker({digest:source,policy:1})
   expect((await report()).coverage).toMatchObject({complete_turns:1,blocked_turns:0})
   // A raw receipt has no curation revision column. Use the run on this revision
   // and digest. A conflicting current negative receipt wins over an inline claim.
   await client.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,
    policy_revision,policy_hash,model_config_hash,mode,state)
    SELECT installation_id,bundle_id,revision,source_digest,1,repeat('a',64),repeat('b',64),'enabled','completed' FROM memory_task_bundles`)
   await writeReceipt(source,LIFECYCLE_SOURCE_POLICY,'provenance_unknown',false)
   expect((await report()).coverage).toMatchObject({complete_turns:0,receipt_turns:1,provenance_unknown_turns:1})
   await client.query(`UPDATE memory_source_processing_receipts SET complete=true,disposition='no_durable_conclusion'
    WHERE source_digest=decode($1,'hex') AND policy_version=$2`,[source,LIFECYCLE_SOURCE_POLICY])
   await marker({})
   expect((await report()).coverage).toMatchObject({complete_turns:1,receipt_turns:1})
   await client.query('UPDATE memory_curation_runs SET policy_revision=9')
   expect((await report()).coverage).toMatchObject({complete_turns:0,receipt_turns:0})
   await marker({digest:source,policy:1})
   await client.query('DELETE FROM memory_task_bundles')
   expect(await report()).toMatchObject({input_coverage:{trusted_turns:1},coverage:{receipt_turns:1,complete_turns:1}})

   // New admission summaries are bound to both the episode and admission policy.
   const admission={episode_digest:episode,digest:source,source_policy:LIFECYCLE_SOURCE_POLICY,provenance:'trusted',allowed_count:2,excluded_count:0}
   const attest=async(value:Record<string,unknown>)=>client.query('UPDATE work_episodes SET evidence_manifest=$1',[{lifecycle_admission:value}])
   await attest(admission)
   await marker({digest:old,policy:1})
   expect(await report()).toMatchObject({input_coverage:{trusted_turns:1},coverage:{receipt_turns:0,complete_turns:0}})
   await marker({digest:source,policy:1})
   for(const invalid of [{episode_digest:old},{source_policy:'obsolete'},{provenance:'invalid'},{allowed_count:0},{allowed_count:1.5}]){
    await attest({...admission,...invalid})
    expect(await report()).toMatchObject({input_coverage:{trusted_turns:0,unverified_turns:1},coverage:{complete_turns:0}})
   }
   await attest({...admission,provenance:'unknown',allowed_count:1,excluded_count:1})
   await marker({digest:source,policy:1,disposition:'provenance_unknown'})
   expect(await report()).toMatchObject({input_coverage:{unknown_turns:1,with_trusted_input_turns:1,partially_trusted_turns:1,trusted_turns:0},coverage:{receipt_turns:1,complete_turns:0,provenance_unknown_turns:1}})
   await attest({...admission,provenance:'unknown',allowed_count:0,excluded_count:2})
   expect((await report()).input_coverage).toMatchObject({with_trusted_input_turns:0,partially_trusted_turns:0,unknown_turns:1})
   await marker({digest:source,policy:1})
   expect((await report()).coverage.complete_turns).toBe(0)
   await client.query("UPDATE work_episodes SET evidence_manifest='{}'")
   for(const malformed of [{},{digest:'bad',policy:1},{digest:source,policy:1,disposition:null},
    {digest:source,policy:'1'},{digest:source,policy:1,source_policy:'obsolete'},{digest:source,policy:1,disposition:'unsupported'}]){
    await marker(malformed)
    expect((await report()).coverage).toMatchObject({receipt_turns:0,complete_turns:0})
   }
   // Use the full native query for a capped sample, after the stale-receipt scenarios.
   await client.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,terminal_at,
    compiler_version,compiled_at,source_digest) SELECT $1,gen_random_uuid(),'session','other-'||n,'ready',now(),
    'relay-turn-v1',now(),decode(repeat('00',32),'hex') FROM generate_series(1,1001)n`,[id])
   expect((await report()).coverage).toMatchObject({turns:1000,counts_capped:true,complete_turns:0})
  }finally{await client.query('ROLLBACK');client.release()}
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
  await turns(1);await completedProjection(1,'shadow');await receipt(1,'provenance_unknown',false,'0 seconds')
  const metrics=createMemoryMetrics()
  await updateBusinessHealthGauges(pool,metrics,true,'shadow')
  let text=await metrics.registry.metrics()
  expect(text).toContain('pocketctl_memory_lifecycle_alerts{reason="source_provenance_unknown"} 1')
  expect(text).toContain('pocketctl_memory_lifecycle_execution{state="healthy"} 1')
  expect(text).toContain('pocketctl_memory_lifecycle_coverage{kind="provenance_unknown_turns"} 1')
  expect(text).toContain('pocketctl_memory_lifecycle_coverage{kind="input_unknown_turns"} 1')
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
