import {DELIVERY_FACT_REQUIRED,SNAPSHOT_FACT_REQUIRED} from '../../sources/transport-metadata-migration.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {canonicalPayloadHash,canonicalSourceClassification,createPostgresSharedSourceReader} from '@pocketctl/session-source'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {JOB_DEAD_LETTER_ATTEMPTS} from '../../jobs/types.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {provisionSharedDatabase,assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {beforeAll,afterAll,describe,test,expect,vi} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createInboxGaugeUpdater} from '../../worker-gauges.js'
import {createExtractionRepository} from '../../extraction/repository.js'
import {deliverySourceStatus} from '../../claims/delivery-source-status.js'
import {previewSourceRetention} from '../../retention/source.js'
import {createSnapshotReconciler} from '../../snapshot/reconcile-worker.js'
import {retainInboxInstallation,createInboxRetentionWorker} from '../../inbox/retention.js'
import {applyStagedSessionPage} from '../../purge/staged-session.js'
import {bindCurrentOriginalReferences,type CurrentOriginalBindingBoundary,type CurrentOriginalReferenceBinding} from '../../migrations/shared-forward/current-original-reference-binding.js'
import {readIngressKeyIndex} from '../../migrations/shared-source/ingress-key.js'
import {loadBusinessHealth} from '../../reporting/business-health.js'
import {createPurgeRepository} from '../../purge/repository.js'
import {readLegacySourceInputGeneration} from '../../sources/input-mode.js'
import {createMemoryPool} from '../../db.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('shared runtime without physical legacy transport tables',()=>{
 let f:DirectLaunchFixture,installation:string,source:Awaited<ReturnType<DirectLaunchFixture['source']>>
 let runtimeStopped=false
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
 afterAll(async()=>{
  if(!f)return
  if(!runtimeStopped)await f.runtime.end()
  await f.publisher.end()
  await f.pool.end()
 })
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
 test.each([{count:2,firstPosition:801001},{count:257,firstPosition:803049},{count:1024,firstPosition:805097},
  {count:1025,firstPosition:808000,paged:true}])('binds $count exact Feed originals while preserving the dead job',async({count,firstPosition,paged})=>{
  const install=installation
  const runtimeUrl=new URL(url!);runtimeUrl.username='direct_launch_memory';runtimeUrl.password='synthetic-only'
  if(runtimeStopped){
   f.runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:5})
   runtimeStopped=false
  }
  const rootSource=await f.source()
  // The launch profile admits only the fixture's one installation. Give its
  // owner a second independent Relay root for this complete-roster test.
  await f.pool.query('UPDATE public.daemons SET user_id=$2 WHERE daemon_id=$1',[rootSource.daemon,source.owner])
  await f.pool.query('UPDATE public.sessions SET user_id=$2 WHERE session_id=$1',[rootSource.session,source.owner])
  rootSource.owner=source.owner
  const {persistOwnedClientEvent}=await import(pathToFileURL(resolve('../relay/dist/db.js')).href)
  const {createPostgresExtensionJournalSink}=await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)
  const sink=createPostgresExtensionJournalSink({sharedHeaders:true})
  const root={kind:'relay_event' as const,key:f.root(rootSource)},rows:CurrentOriginalReferenceBinding['originals']=[]
  let firstEnvelopeHash:Buffer|undefined
  for(let ordinal=0;ordinal<count;ordinal++){
   const position=String(firstPosition+ordinal)
   const payload={event_id:randomUUID(),turn_id:'original-turn-'+position,text:'synthetic original '+position}
   const canonicalKey=String((await persistOwnedClientEvent(f.publisher,rootSource.owner,rootSource.session,'agent_text',payload,sink)).eventId)
   const event=(await f.pool.query('SELECT id::text,xmin::text AS row_version,created_at FROM public.events WHERE id=$1',[canonicalKey])).rows[0]
   const classification=canonicalSourceClassification({source_kind:'canonical_event',session_id:rootSource.session,source_seq:'',payload})
   const old=(await f.pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification)
    VALUES(gen_random_uuid(),$1,'feed',$2,$3,$4,$5,'agent_text',$6,$7,$8,$9) RETURNING source_event_id::text,xmin::text AS row_version`,
   [install,position,'event_id:'+payload.event_id,rootSource.session,payload.turn_id,event.created_at,payload,canonicalPayloadHash(payload),classification])).rows[0]
   const envelopeHash=canonicalPayloadHash({envelope_version:1,feed_id:position,topic:'session.event.v1',
     source:{kind:'canonical_event',id:'event:'+canonicalKey,recorded_at:event.created_at.toISOString()},
     subject:{session_id:rootSource.session,turn_id:payload.turn_id,event_type:'agent_text'},classification,data:payload})
    await f.pool.query(`INSERT INTO memory.memory_source_delivery_receipts(installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,
     event_type,recorded_at,payload_hash,projection_state,received_at)
     VALUES($1,$2,1,'session.event.v1','canonical_event',$3,$4,$5,'agent_text',$6,$7,'projected',now())`,
    [install,position,'event:'+canonicalKey,rootSource.session,payload.turn_id,event.created_at,
     ordinal===0?Buffer.alloc(32,0xaa):envelopeHash])
   if(ordinal===0)firstEnvelopeHash=envelopeHash
   rows.push({sourceEventId:old.source_event_id,sourceRowVersion:old.row_version,canonicalKey,nativeRowVersion:event.row_version})
  }
  const readJobs=async()=>(await f.pool.query(`SELECT job_id::text,state,attempts,claim_epoch::text,last_error_code,payload
   FROM memory.memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source' AND payload->'root'->>'key'=$2
   ORDER BY created_at,job_id`,[install,root.key])).rows
  const readFrontier=async()=>(await f.pool.query(`SELECT p.dispatched_revision::text,p.processed_revision::text,
   w.revision::text,w.processed_revision::text AS native_processed_revision,d.scan_id::text,d.dispatch_complete
   FROM shared.memory_source_progress p JOIN shared.memory_source_work w USING(source_kind,root_key)
   JOIN shared.memory_source_distributions d USING(source_kind,root_key)
   WHERE p.installation_id=$1 AND p.source_kind='relay_event' AND p.root_key=$2`,[install,root.key])).rows[0]
  const readDeadLetter=async(jobId:string)=>(await f.pool.query(`SELECT attempts,error_code,encode(payload_hash,'hex') AS payload_hash
   FROM memory.memory_dead_letters WHERE job_id=$1`,[jobId])).rows
  const readNoCostEffects=async()=>(await f.pool.query(`SELECT
   (SELECT count(*)::int FROM public.events WHERE session_id=$1) AS events,
   (SELECT count(*)::int FROM memory.memory_jobs WHERE installation_id=$2 AND job_type<>'project_shared_source') AS other_jobs,
   (SELECT count(*)::int FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) WHERE e.installation_id=$2) AS provider_attempts`,
  [rootSource.session,install])).rows[0]
  const failingSignal=new AbortController().signal
  const beforeDiscovery=createNativeInstallationDiscovery({pool:f.runtime,signal:failingSignal})
  const beforeScheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'before-original-binding',signal:failingSignal,
   refreshInstallations:()=>beforeDiscovery.discoverOnce()})
  const mappingErrors:string[]=[]
  const beforeWorker=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'before-original-binding',signal:failingSignal,
   onError:(error,job)=>{
    const failedRoot=job?.payload.root as typeof root|undefined
    if(failedRoot?.kind===root.kind&&failedRoot.key===root.key)mappingErrors.push((error as Error).message)
   }})
  beforeWorker.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  beforeWorker.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{pageSize:1,stabilizationMs:0}),{branch:'canonical'})
  try{
   await beforeDiscovery.discoverOnce()
   for(let n=0;n<96;n++){
    await beforeScheduler.runOnce()
    await beforeWorker.tick()
    const jobs=await readJobs()
    const frontier=await readFrontier()
    if(jobs.length&&jobs.every(job=>job.state==='dead')&&frontier?.dispatch_complete&&frontier.native_processed_revision===frontier.revision)break
    for(const job of jobs.filter(job=>job.state==='pending'&&job.attempts>0)){
     // Advance only this disposable fixture's retry clock. The actual worker
     // still claims and fails every attempt through its normal ownership fence.
     await f.pool.query(`UPDATE memory.memory_jobs SET available_at=clock_timestamp() WHERE job_id=$1 AND state='pending'`,[job.job_id])
    }
    await new Promise(resolve=>setTimeout(resolve,25))
   }
  }finally{await beforeScheduler.stop();await beforeWorker.stop();await beforeDiscovery.stop()}
  const originalJobs=await readJobs()
  const terminalFrontier=await readFrontier()
  const originalJob=originalJobs.find(job=>job.payload.distribution_scan===terminalFrontier.scan_id)
  expect(originalJob).toMatchObject({state:'dead',attempts:JOB_DEAD_LETTER_ATTEMPTS,last_error_code:'canonical_reference_mapping_required'})
  expect(mappingErrors.length).toBeGreaterThanOrEqual(JOB_DEAD_LETTER_ATTEMPTS)
  expect([...new Set(mappingErrors)]).toEqual(['canonical_reference_mapping_required'])
  const originalDeadLetter=await readDeadLetter(originalJob.job_id)
  expect(originalDeadLetter).toHaveLength(1)
  expect(terminalFrontier).toMatchObject({dispatch_complete:true,processed_revision:'0',native_processed_revision:terminalFrontier.revision})
  expect(terminalFrontier.dispatched_revision).toBe(terminalFrontier.revision)
  const priorEffects=await readNoCostEffects()
  const state=(await f.runtime.query('SELECT state FROM shared.memory_current_grant_states(ARRAY[$1::uuid],ARRAY[]::uuid[])',[install])).rows[0].state
  const scope={installationId:install,principalUserId:state.owner_user_id,ownerScopeKind:'personal' as const,ownerScopeId:state.owner_scope_id,
   authorizationRevision:state.authorization_epoch,configVersion:state.config_version,modeGeneration:'3'}
  const reader=createPostgresSharedSourceReader(f.runtime)
  const sealedSource=await reader.checkCurrent(scope,root)
  if(sealedSource.state!=='current')throw Error('expected_current_source')
  await f.pool.query(`INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at)
   VALUES($1,$2,'session_deleted',clock_timestamp())`,[install,'unrelated-'+randomUUID()])
  const current=await reader.listHeads(scope,root,{limit:256})
  const keys=current.heads.map(head=>head.canonicalKey)
  let cursor=current.nextCursor
  while(cursor){
   const page=await reader.listHeads(scope,root,{cursor,limit:256})
   expect(page.version).toEqual(current.version)
   keys.push(...page.heads.map(head=>head.canonicalKey))
   cursor=page.nextCursor
  }
  expect(current.version).toEqual({...sealedSource.version,storage:expect.any(String)})
  expect(current.version.storage).not.toBe(sealedSource.version.storage)
  expect(await readFrontier()).toEqual(terminalFrontier)
  expect(keys).toEqual(rows.map(row=>row.canonicalKey))
  const index=await readIngressKeyIndex(f.pool)
  expect(index).toBeDefined()
  const plan:CurrentOriginalReferenceBinding={database:new URL(url!).pathname.slice(1),migratorRole:'direct_launch_definer',runtimeRole:'direct_launch_memory',scope,root,
   version:current.version,ingressIndexHash:index!.definitionHash,originals:rows,
   projectionRecovery:{scanId:terminalFrontier.scan_id,terminalJobId:originalJob.job_id}}
  const boundaries:CurrentOriginalBindingBoundary['state'][]=[]
  const acknowledge=async (record:CurrentOriginalBindingBoundary)=>{
   boundaries.push(record.state)
   return {durable:true,sha256:canonicalPayloadHash(record).toString('hex')}
  }
  const read=async()=>(await f.pool.query(`SELECT source_event_id::text,mapping_state,source_sequence::text,canonical_key,adapter_version,payload,payload_hash,source_provenance,classification
   FROM memory.source_events WHERE installation_id=$1 AND session_id=$2 AND origin='feed' ORDER BY origin_position`,[install,rootSource.session])).rows
  const before=await read()
  const firstPagePlan={...plan,projectionRecovery:undefined,originals:rows.slice(0,64),page:{after:null,hasMore:true}}
  const validAttempt=paged?firstPagePlan:plan
  const runtime=new pg.Client({connectionString:runtimeUrl.href});await runtime.connect()
  try{await expect(bindCurrentOriginalReferences(runtime,validAttempt,acknowledge)).rejects.toThrow('current_original_binding_database')}
  finally{await runtime.end()}
  const native=new pg.Client({connectionString:process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL});await native.connect()
  const bodyQueries:string[]=[]
  const query=native.query.bind(native)
  native.query=((...args:unknown[])=>{
   if(typeof args[0]==='string'&&(args[0].includes('shared.read_memory_relay_sources(')||args[0].includes('SELECT source_event_id::text,payload')))bodyQueries.push(args[0])
   return (Reflect.apply(query,native,args) as unknown)
  }) as typeof native.query
  try{
   await native.query('SET ROLE direct_launch_definer')
   await native.query('BEGIN')
   try{await expect(bindCurrentOriginalReferences(native,validAttempt,acknowledge)).rejects.toThrow('current_original_binding_connection_not_idle')}
   finally{expect((await native.query('ROLLBACK')).command).toBe('ROLLBACK')}
   await expect(bindCurrentOriginalReferences(native,validAttempt,acknowledge)).rejects.toThrow('current_original_binding_runtime_not_drained')
   await f.runtime.end();runtimeStopped=true
   await expect(bindCurrentOriginalReferences(native,{...plan,originals:rows.slice(0,-1)},acknowledge)).rejects.toThrow('current_original_binding_roster')
   expect(bodyQueries).toEqual([])
   await expect(bindCurrentOriginalReferences(native,validAttempt,acknowledge)).rejects.toThrow('current_original_binding_receipt')
   expect(await read()).toEqual(before)
   await f.pool.query('UPDATE memory.memory_source_delivery_receipts SET payload_hash=$2 WHERE installation_id=$1 AND feed_id=$3',[install,firstEnvelopeHash,firstPosition])
   if(paged){
    const {projectionRecovery:recovery,...base}=plan
    const split=64,first={...base,originals:rows.slice(0,split),page:{after:null,hasMore:true}}
    const lastOffset=Math.floor((rows.length-1)/split)*split
    const last={...base,projectionRecovery:recovery,originals:rows.slice(lastOffset),page:{after:rows[lastOffset-1].canonicalKey,hasMore:false}}
    await expect(bindCurrentOriginalReferences(native,{...first,projectionRecovery:recovery},acknowledge)).rejects.toThrow('current_original_binding_input')
    await expect(bindCurrentOriginalReferences(native,{...first,originals:rows.slice(1,split)},acknowledge)).rejects.toThrow('current_original_binding_roster')
    await expect(bindCurrentOriginalReferences(native,{...first,page:{after:null,hasMore:false}},acknowledge)).rejects.toThrow('current_original_binding_roster')
    await expect(bindCurrentOriginalReferences(native,last,acknowledge)).rejects.toThrow('current_original_binding_earlier_pages_required')
    expect(await read()).toEqual(before)
    const digestByBoundary:CurrentOriginalBindingBoundary[]=[]
    const recordPage=async(record:CurrentOriginalBindingBoundary)=>{
     digestByBoundary.push(record)
     return acknowledge(record)
    }
    const mapped=await bindCurrentOriginalReferences(native,first,recordPage)
    expect(mapped.changed).toBe(split)
    expect(digestByBoundary.map(entry=>entry.page)).toEqual([undefined,...Array.from({length:3},()=>({
     after:null,through:rows[split-1].canonicalKey,hasMore:true,proofDigest:mapped.digest,
    }))])
    expect(await readJobs()).toEqual(originalJobs)
    expect(await readFrontier()).toEqual(terminalFrontier)
    await expect(bindCurrentOriginalReferences(native,first,acknowledge)).rejects.toThrow('current_original_binding_row_missing')
    await f.pool.query(`INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at)
     VALUES($1,$2,'session_deleted',clock_timestamp())`,[install,'unrelated-mid-binding-'+randomUUID()])
    await expect(bindCurrentOriginalReferences(native,last,acknowledge)).rejects.toThrow('current_original_binding_authority')
    expect((await read()).slice(split)).toEqual(before.slice(split))
    const next=await createPostgresSharedSourceReader(f.pool).checkCurrent(scope,root)
    if(next.state!=='current')throw Error('expected_current_source')
    for(let offset=split;offset<lastOffset;offset+=split){
     const originals=rows.slice(offset,offset+split)
     const page={after:rows[offset-1].canonicalKey,hasMore:true}
     expect(await bindCurrentOriginalReferences(native,{...base,version:next.version,originals,page},acknowledge)).toMatchObject({changed:originals.length,immutableRowsPreserved:true})
    }
    expect(await bindCurrentOriginalReferences(native,{...last,version:next.version},acknowledge)).toMatchObject({changed:rows.length-lastOffset,immutableRowsPreserved:true})
    const after=await read()
    for(let n=0;n<rows.length;n++)expect(after[n]).toEqual({...before[n],mapping_state:'verified',canonical_key:rows[n].canonicalKey,adapter_version:'original-ref-v1'})
    expect(await readFrontier()).toEqual(terminalFrontier)
    expect(await readDeadLetter(originalJob.job_id)).toEqual(originalDeadLetter)
    expect(await readNoCostEffects()).toEqual(priorEffects)
   }else{
   await expect(bindCurrentOriginalReferences(native,plan,async record=>record.state==='prepared'?{durable:false,sha256:''}:acknowledge(record)))
    .rejects.toThrow('current_original_binding_boundary')
   expect(await read()).toEqual(before)
   const openAtCommit=new pg.Client({connectionString:runtimeUrl.href})
   try{
    await expect(bindCurrentOriginalReferences(native,plan,async record=>{
     if(record.state==='commit-outcome-unknown')await openAtCommit.connect()
     return acknowledge(record)
    })).rejects.toThrow('current_original_binding_runtime_not_drained')
   }finally{await openAtCommit.end()}
   expect(await read()).toEqual(before)
   boundaries.length=0
   const proofKinds={feed:count,ingress:0}
   await expect(bindCurrentOriginalReferences(native,{...plan,expectedEvidence:{count,...proofKinds,digest:'0'.repeat(64)}},acknowledge))
    .rejects.toThrow('current_original_binding_evidence')
   expect(await read()).toEqual(before)
   for(const projectionRecovery of [{scanId:randomUUID(),terminalJobId:originalJob.job_id},{scanId:terminalFrontier.scan_id,terminalJobId:randomUUID()}]){
    await expect(bindCurrentOriginalReferences(native,{...plan,projectionRecovery},acknowledge))
     .rejects.toThrow('current_original_binding_projection_recovery')
    expect(await read()).toEqual(before)
    expect(await readJobs()).toEqual(originalJobs)
   }
   boundaries.length=0
   expect(await bindCurrentOriginalReferences(native,plan,acknowledge)).toEqual({changed:count,proofKinds,digest:expect.stringMatching(/^[a-f0-9]{64}$/),immutableRowsPreserved:true})
   expect(boundaries).toEqual(['transaction-started','prepared','commit-outcome-unknown','committed'])
   }
  }finally{await native.end()}
  const after=await read()
  for(let n=0;n<rows.length;n++)expect(after[n]).toEqual({...before[n],mapping_state:'verified',canonical_key:rows[n].canonicalKey,adapter_version:'original-ref-v1'})
  expect(after).toHaveLength(rows.length)
  await f.pool.query(`INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at)
   VALUES($1,$2,'session_deleted',clock_timestamp())`,[install,'unrelated-after-binding-'+randomUUID()])
  const fresh=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:3})
  const signal=new AbortController().signal,errors:unknown[]=[]
  const discovery=createNativeInstallationDiscovery({pool:fresh,signal})
  await discovery.discoverOnce()
  const scheduler=createSharedSourceScheduler({pool:fresh,workerId:'post-binding-source',signal,refreshInstallations:()=>discovery.discoverOnce(),onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:fresh,jobs:createJobRepository(fresh),workerId:'post-binding-projection',signal,onError:(e,j)=>{if(!j||j.installation_id===install)errors.push(e)}})
  const handle=createCanonicalProjectionHandler(fresh,{pageSize:paged?64:1,stabilizationMs:0})
  queue.register('compile_episode',createEpisodeRepository(fresh,{stabilizationMs:0}).handleCompileEpisode)
  let rejectedDifferentOriginal=false
  let changedStorageAtCommit=false
  queue.register('project_shared_source',async(job,abort,context)=>{
   if(paged&&job.payload.reference_repair_paged){
    expect(job.payload.reference_repair_original_ids).toBeUndefined()
    expect(job.payload.reference_repair_canonical_ids).toBeUndefined()
    if(!rejectedDifferentOriginal){
     await expect(handle({...job,payload:{...job.payload,reference_repair_original_ids:[randomUUID()]}},abort,context)).rejects.toThrow('invalid_source_context_set')
     rejectedDifferentOriginal=true
    }
    await handle(job,abort,context);return
   }
   if(!rejectedDifferentOriginal&&job.payload.reference_repair_version){
    const wrong={...job,payload:{...job.payload,reference_repair_original_ids:rows.map((row,index)=>index===rows.length-1?randomUUID():row.sourceEventId)}}
    await expect(handle(wrong,abort,context)).rejects.toThrow('source_context_set_changed')
    const truncated={...job,payload:{...job.payload,reference_repair_original_ids:rows.slice(0,-1).map(row=>row.sourceEventId),reference_repair_canonical_ids:rows.slice(0,-1).map(row=>row.canonicalKey)}}
    await expect(handle(truncated,abort,context)).rejects.toThrow('source_context_set_changed')
    expect(await readFrontier()).toEqual(terminalFrontier)
    rejectedDifferentOriginal=true
   }
   if(changedStorageAtCommit||!job.payload.reference_repair_version){await handle(job,abort,context);return}
   const query=pg.Client.prototype.query
   const wire=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
    if(changedStorageAtCommit||typeof args[0]!=='string'||!args[0].startsWith('SELECT shared.lock_memory_personal_source_commit('))
     return Reflect.apply(query,this,args)
    changedStorageAtCommit=true
    return f.pool.query(`INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at)
     VALUES($1,$2,'session_deleted',clock_timestamp())`,[install,'unrelated-before-commit-'+randomUUID()])
     .then(()=>Reflect.apply(query,this,args))
   })
   try{await handle(job,abort,context)}finally{wire.mockRestore()}
  },{branch:'canonical'})
  try{
   const queued=await readJobs()
   expect(queued).toEqual([...originalJobs,expect.objectContaining({state:'pending',attempts:0,claim_epoch:'0',
    payload:expect.objectContaining({distribution_scan:terminalFrontier.scan_id})})])
   await queue.tick()
   expect(changedStorageAtCommit).toBe(!paged)
   expect(errors).toEqual([])
   expect(await readFrontier()).toEqual(terminalFrontier)
   expect((await readJobs()).at(-1)).toMatchObject({state:'pending',attempts:0})
   let ready=false
   const deadline=performance.now()+(paged?30000:3000)
   while(!ready&&performance.now()<deadline){
    await scheduler.runOnce();await queue.tick()
    if(errors.length)throw errors[0]
    const frontier=await readFrontier()
    ready=frontier.dispatch_complete&&frontier.native_processed_revision===frontier.revision
     &&frontier.processed_revision===frontier.dispatched_revision&&frontier.scan_id===terminalFrontier.scan_id
    if(!ready)await new Promise(resolve=>setTimeout(resolve,30))
   }
   expect(ready,JSON.stringify({watermark:await readFrontier(),jobs:(await readJobs()).map(j=>({state:j.state,attempts:j.attempts}))})).toBe(true)
   expect(rejectedDifferentOriginal).toBe(true)
   const watermark=await readFrontier()
   expect(watermark).toEqual({...terminalFrontier,processed_revision:terminalFrontier.dispatched_revision})
   expect(await readJobs()).toEqual([...originalJobs,expect.objectContaining({job_id:queued.at(-1)!.job_id,state:'completed'})])
   expect(await readDeadLetter(originalJob.job_id)).toEqual(originalDeadLetter)
   expect(await readNoCostEffects()).toEqual(priorEffects)
   expect(await read()).toEqual(after)
  }finally{await scheduler.stop();await queue.stop();await discovery.stop();await fresh.end()}
 },90000)
})
