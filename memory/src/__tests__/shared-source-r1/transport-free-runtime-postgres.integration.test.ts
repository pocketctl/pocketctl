import {DELIVERY_FACT_REQUIRED,SNAPSHOT_FACT_REQUIRED} from '../../sources/transport-metadata-migration.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {provisionSharedDatabase,assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createInboxGaugeUpdater} from '../../worker-gauges.js'
import {createExtractionRepository} from '../../extraction/repository.js'
import {deliverySourceStatus} from '../../claims/delivery-source-status.js'
import {previewSourceRetention} from '../../retention/source.js'
import {createSnapshotReconciler} from '../../snapshot/reconcile-worker.js'
import {retainInboxInstallation,createInboxRetentionWorker} from '../../inbox/retention.js'
import {applyStagedSessionPage} from '../../purge/staged-session.js'
import {loadBusinessHealth} from '../../reporting/business-health.js'
import {createPurgeRepository} from '../../purge/repository.js'
import {readLegacySourceInputGeneration} from '../../sources/input-mode.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('shared runtime without physical legacy transport tables',()=>{
 let f:DirectLaunchFixture,installation:string,source:Awaited<ReturnType<DirectLaunchFixture['source']>>
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);
  const controls=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href);await controls.applyRelayControlCapture(f.pool)
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  source=await f.source();installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[installation])
  await applySharedSourceContract(f.pool,{targetProfile:'personal-relay-only',preservedInstallations:[installation]})
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active',generation=3 WHERE installation_id=$1",[installation])
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  // Synthetic fixture materializes content-free delivery identity. Production
  // requires independent body retirement and writer fencing before this step.
  await f.pool.query(`CREATE TABLE memory.memory_source_delivery_receipts AS
   SELECT installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,payload_hash,
    projection_state,error_code,received_at,projected_at,body_reclaimed_at FROM memory.memory_feed_inbox`)
  await f.pool.query(`CREATE OR REPLACE VIEW memory.memory_source_delivery_facts AS SELECT * FROM memory.memory_source_delivery_receipts`)
  await f.pool.query(`CREATE OR REPLACE VIEW memory.memory_source_snapshot_facts AS
   SELECT run_id,installation_id,generation,state,inventory_cursor,sessions_seen,events_seen,error_code,started_at,completed_at,relay_acked_at,source_mode_generation
   FROM memory.memory_snapshot_runs WHERE FALSE`)
  await f.pool.query('ALTER TABLE memory.memory_source_delivery_receipts '+DELIVERY_FACT_REQUIRED.map(c=>'ALTER COLUMN '+c+' SET NOT NULL').join(','))
  // Retarget snapshot metadata before dropping the physical source relation.
  await f.pool.query('CREATE TABLE memory.memory_source_snapshot_receipts AS SELECT * FROM memory.memory_source_snapshot_facts')
  await f.pool.query('ALTER TABLE memory.memory_source_snapshot_receipts '+SNAPSHOT_FACT_REQUIRED.map(c=>'ALTER COLUMN '+c+' SET NOT NULL').join(','))
  await f.pool.query('CREATE OR REPLACE VIEW memory.memory_source_snapshot_facts AS SELECT * FROM memory.memory_source_snapshot_receipts;ALTER TABLE memory.memory_source_delivery_receipts ADD PRIMARY KEY(installation_id,feed_id);ALTER TABLE memory.memory_source_delivery_receipts OWNER TO direct_launch_definer;ALTER TABLE memory.memory_source_snapshot_receipts ADD PRIMARY KEY(run_id);ALTER TABLE memory.memory_source_snapshot_receipts OWNER TO direct_launch_definer')
  await f.pool.query(`ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS legacy_transport_retired BOOLEAN NOT NULL DEFAULT FALSE;
   UPDATE shared.memory_source_contract SET legacy_transport_retired=TRUE;
   DROP TABLE memory.memory_feed_inbox,memory.memory_snapshot_events,memory.memory_snapshot_runs,memory.memory_inbox_checkpoints;
   GRANT SELECT,UPDATE,DELETE ON memory.memory_source_delivery_receipts,memory.memory_source_delivery_facts,memory.memory_source_snapshot_facts TO direct_launch_memory`)
 },60000)
 afterAll(async()=>{await f?.close()})
 test('the test really removed all four raw transport relations',async()=>{
  const rows=(await f.pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND relname=ANY($1::text[])",[['memory_feed_inbox','memory_snapshot_events','memory_snapshot_runs','memory_inbox_checkpoints']])).rows
  expect(rows).toEqual([])
 })
 test('shared source health has no regclass dependency on retired tables',async()=>{
  const health=(await f.runtime.query('SELECT shared.memory_source_health() AS health')).rows[0].health
  expect(health.copies.filter((x:any)=>['memory_feed_inbox','memory_snapshot_events'].includes(x.table)).every((x:any)=>x.bytes==='0')).toBe(true)
 })
 test('a missing necessary source table is still an error after transport retirement',async()=>{
  await f.pool.query('ALTER TABLE memory.source_events RENAME TO transport_test_sources')
  try{await expect(f.runtime.query('SELECT shared.memory_source_health()')).rejects.toThrow('source_health_relation_missing')}
  finally{await f.pool.query('ALTER TABLE memory.transport_test_sources RENAME TO source_events')}
 })
 test('worker metadata gauges work without an Inbox',async()=>{
  const values=new Map<string,number>();await createInboxGaugeUpdater({set:({state}:any,value:number)=>{values.set(state,value)}} as any)(f.runtime)
  expect(Object.fromEntries(values)).toEqual({pending:0,quarantined:0,projected:0,purged:0})
 })
 test('extraction eligibility can be queried without an Inbox',async()=>{
  expect(await createExtractionRepository(f.runtime).loadEpisodeForExtraction(installation,'missing-turn')).toBeNull()
 })
 test('delivery status still enforces owned provenance without an Inbox',async()=>{
  expect(await deliverySourceStatus(f.runtime,{installationId:installation,submissionId:'missing-submission',decisionId:'missing-decision'})).toEqual({source:null})
 })
 test('source retention preview no longer requires Snapshot or Inbox tables',async()=>{
  expect((await previewSourceRetention(f.runtime,14,1,{installationId:installation})).eligible).toEqual([])
 })
 test('legacy Inbox maintenance yields to the explicit retirement contract',async()=>{
  const result=await retainInboxInstallation(f.runtime,installation,{mode:'enabled',bodyDays:14,metadataDays:30,batchSize:32,intervalMs:60000})
  expect(result).toMatchObject({reclaimed:0,deleted:0,skipped:'retired'})
 })
 test('the exported Inbox maintenance loop stops before querying retired checkpoints',async()=>{
  const worker=createInboxRetentionWorker({pool:f.runtime,signal:new AbortController().signal,settings:{mode:'enabled',bodyDays:14,metadataDays:30,batchSize:32,intervalMs:60000}})
  try{await worker.runOnce()}finally{await worker.stop()}
 })
 test('a stale Snapshot job is rejected before querying old runs or contacting Relay',async()=>{
  let calls=0;const unavailable=async()=>{calls++;throw Error('unexpected_snapshot_http')}
  const worker=createSnapshotReconciler({pool:f.runtime,relay:{listSessions:unavailable,getSnapshot:unavailable,acknowledgeReconcile:unavailable}})
  await expect(worker.reconcile(installation)).rejects.toThrow('legacy_transport_retired');expect(calls).toBe(0)
 })
 test('oversized gaps remain visible to shared health after raw body retirement',async()=>{
  await f.pool.query(`INSERT INTO memory.memory_source_delivery_receipts(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,payload_hash,projection_state,error_code,received_at,projected_at,body_reclaimed_at)
   VALUES($1,9000,1,'session.event.v1','canonical_event','event:1','retained-gap',NULL,'agent_text',NOW(),decode(repeat('ab',32),'hex'),'quarantined','oversized_content',NOW(),NULL,NOW())`,[installation])
  expect((await loadBusinessHealth(f.runtime)).find(r=>r.installation_id===installation)?.evidence_gaps).toBe('1')
 })
 test('paged privacy cleanup deletes metadata through its exact reviewed physical table',async()=>{
  const row=(await f.runtime.query(`SELECT installation_id::text,feed_id::text,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS fingerprint FROM memory_source_delivery_receipts r WHERE installation_id=$1 AND feed_id=9000`,[installation])).rows[0]
  const record={table:'memory_source_delivery_receipts',key:{installation_id:row.installation_id,feed_id:row.feed_id},references:{},fingerprint:row.fingerprint,bytes:'1',disposition:'delete' as const}
  const client=await f.runtime.connect()
  try{await client.query('BEGIN');await applyStagedSessionPage(client as any,{ordinal:'0',phase:'raw',root:{installationId:installation,sessionId:'retained-gap'},componentHash:'0'.repeat(64),records:[record]} as any,[]);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  expect((await f.runtime.query('SELECT 1 FROM memory_source_delivery_facts WHERE installation_id=$1 AND feed_id=9000',[installation])).rows).toEqual([])
 })
 test('session privacy purge does not resurrect or require old transport',async()=>{
  expect(await createPurgeRepository(f.runtime,{hmacKey:'synthetic-only'}).purgeSession({installationId:installation,sessionId:'missing-session',reason:'user_deleted',sourceFeedId:null})).toBe(0)
 })
 test('new canonical business is projected and read after all legacy tables are gone',async()=>{
  const signal=new AbortController().signal,discovery=createNativeInstallationDiscovery({pool:f.runtime,signal})
  await discovery.discoverOnce()
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'transport-free',signal,pageSize:128,refreshInstallations:()=>discovery.discoverOnce()})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'transport-free',signal,claimLimit:8})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{pageSize:64,stabilizationMs:0}),{branch:'canonical'})
  try{
   const ids=[await f.event(source),await f.event(source,true)]
   for(let n=0;n<512;n++){
    await scheduler.runOnce();await queue.tick()
    const refs=(await f.runtime.query("SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND canonical_key=ANY($2::text[]) AND origin='canonical'",[installation,ids])).rows
    if(refs.length===2){
     const read=await prepareSourceReferences(f.runtime,installation,refs.map(r=>r.source_event_id)),client=await f.runtime.connect()
     try{await client.query('BEGIN');await read.assertCurrent(client,{forCommit:true});await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
     expect(read.events.some(e=>e.payload.text==='bounded direct launch synthetic body')).toBe(true);return
    }
   }
   throw Error('transport_free_native_projection_not_ready')
  }finally{await scheduler.stop();await queue.stop();await discovery.stop()}
 },30000)
 test('runtime startup accepts the real metadata shape and rejects a missing fact view',async()=>{
  await assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[installation]})
  await f.pool.query('ALTER VIEW memory.memory_source_delivery_facts RENAME TO transport_test_facts')
  try{await expect(assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[installation]})).rejects.toThrow('legacy_transport_metadata_contract_invalid')}
  finally{await f.pool.query('ALTER VIEW memory.transport_test_facts RENAME TO memory_source_delivery_facts')}
 })
 test('startup rejects a filtered view that would conceal a retained gap',async()=>{
  const definition=(await f.pool.query("SELECT pg_get_viewdef('memory.memory_source_delivery_facts'::regclass,TRUE) AS definition")).rows[0].definition
  await f.pool.query('CREATE OR REPLACE VIEW memory.memory_source_delivery_facts AS SELECT * FROM memory.memory_source_delivery_receipts WHERE FALSE')
  try{await expect(assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[installation]})).rejects.toThrow('legacy_transport_metadata_contract_invalid')}
  finally{await f.pool.query('CREATE OR REPLACE VIEW memory.memory_source_delivery_facts AS '+definition)}
 })
 test('startup refuses inherited receipt children that can add bodies or duplicate identity',async()=>{
  await f.pool.query('CREATE TABLE memory.transport_test_child(data JSONB) INHERITS(memory.memory_source_delivery_receipts)')
  try{await expect(assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[installation]})).rejects.toThrow('legacy_transport_metadata_contract_invalid')}
  finally{await f.pool.query('DROP TABLE memory.transport_test_child')}
 })
 test('startup refuses UUID columns replaced with text despite identical column names and PK',async()=>{
  const definition=(await f.pool.query("SELECT pg_get_viewdef('memory.memory_source_delivery_facts'::regclass,TRUE) AS definition")).rows[0].definition
  await f.pool.query('DROP VIEW memory.memory_source_delivery_facts;ALTER TABLE memory.memory_source_delivery_receipts ALTER COLUMN installation_id TYPE TEXT USING installation_id::text')
  await f.pool.query('CREATE VIEW memory.memory_source_delivery_facts AS '+definition)
  await f.pool.query('ALTER VIEW memory.memory_source_delivery_facts OWNER TO direct_launch_definer;GRANT SELECT,UPDATE,DELETE ON memory.memory_source_delivery_facts TO direct_launch_memory')
  try{await expect(assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[installation]})).rejects.toThrow('legacy_transport_metadata_contract_invalid')}
  finally{
   await f.pool.query('DROP VIEW memory.memory_source_delivery_facts;ALTER TABLE memory.memory_source_delivery_receipts ALTER COLUMN installation_id TYPE UUID USING installation_id::uuid')
   await f.pool.query('CREATE VIEW memory.memory_source_delivery_facts AS '+definition)
   await f.pool.query('ALTER VIEW memory.memory_source_delivery_facts OWNER TO direct_launch_definer;GRANT SELECT,UPDATE,DELETE ON memory.memory_source_delivery_facts TO direct_launch_memory')
  }
 })
 test('startup refuses forced row filtering on delivery metadata',async()=>{
  await f.pool.query('ALTER TABLE memory.memory_source_delivery_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE memory.memory_source_delivery_receipts FORCE ROW LEVEL SECURITY')
  try{await expect(assertSharedRuntimeContract(f.runtime,{sharedSourceProfile:'personal-relay-only',installationAllowlist:[installation]})).rejects.toThrow('legacy_transport_metadata_contract_invalid')}
  finally{await f.pool.query('ALTER TABLE memory.memory_source_delivery_receipts DISABLE ROW LEVEL SECURITY;ALTER TABLE memory.memory_source_delivery_receipts NO FORCE ROW LEVEL SECURITY')}
 })
 test('the database also fences an old worker that does not know the new flag',async()=>{
  await expect(f.runtime.query('SELECT shared.lock_memory_legacy_input($1,NULL)',[installation])).rejects.toThrow('legacy_transport_retired')
  await expect(f.pool.query("SELECT shared.transition_memory_source_mode($1,3,'legacy-feed')",[installation])).rejects.toThrow('legacy_transport_retired')
 })
 test('retirement forbids legacy input even for an installation without an explicit active mode',async()=>{
  await f.pool.query("UPDATE shared.memory_source_modes SET mode='legacy-feed' WHERE installation_id=$1",[installation])
  try{expect(await readLegacySourceInputGeneration(f.runtime,installation)).toBeNull()}
  finally{await f.pool.query("UPDATE shared.memory_source_modes SET mode='shared-active' WHERE installation_id=$1",[installation])}
 })
})
