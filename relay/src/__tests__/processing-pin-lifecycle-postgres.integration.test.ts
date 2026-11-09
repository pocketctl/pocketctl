import pg from 'pg'
import {mkdtemp,rm} from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {initDB,deleteSessionInTransaction} from '../db.js'
import {SessionLifecycleExecutor} from '../session-lifecycle/executor.js'
import {sessionLifecycleConfig} from '../session-lifecycle/config.js'
import {enableSessionColdBodies} from '../session-lifecycle/cold-schema.js'
import {FilesystemArchiveStorage} from '../session-archive/filesystem-storage.js'
import {applyRelaySourceCapture} from '../shared-source/capture.js'
import {assertNoSourceProcessingPins} from '../shared-source/processing-pins.js'
const url=process.env.SHARED_PROCESSING_PIN_LIFECYCLE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native lifecycle executor processing pin/privacy override with actual filesystem archive',()=>{
 let pool:pg.Pool,memory:pg.Pool,relay:pg.Pool,executor:SessionLifecycleExecutor,dir:string,userId:number,source:any,observedReader:any,makeObserved:any,disk:FilesystemArchiveStorage
 const installation='10000000-0000-0000-0000-000000000084'
 const config=sessionLifecycleConfig({SESSION_LIFECYCLE_EFFECTIVE_AT:'2026-01-01T00:00:00Z',SESSION_LIFECYCLE_TRANSITION_DEADLINE:'2026-01-01T00:00:00Z'})
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:8});await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await initDB(pool);await enableSessionColdBodies(pool)
  // Variable URL imports keep the independent production tsconfig roots intact.
  const schema=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href)
  const contract=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  const namespace=await import(new URL('../../../memory/src/migrations/shared-db/namespace.ts',import.meta.url).href)
  const db=await import(new URL('../../../memory/src/db.ts',import.meta.url).href)
  source=await import(new URL('../../../memory/src/sources/source-execution.ts',import.meta.url).href)
  const observed=await import(new URL('../../../memory/src/sources/observed-reader.ts',import.meta.url).href)
  await schema.applyMemorySchema(pool,{namespace:'memory'});await contract.applySharedSourceContract(pool);await applyRelaySourceCapture(pool)
  userId=(await pool.query("INSERT INTO users(email,password_hash) VALUES('processing-pins@test.invalid','x') RETURNING id")).rows[0].id
  await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('native-host',$1)",[userId])
  await pool.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled')")
  await pool.query("INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'active',ARRAY['session:events:read','session:deletion:read'],ARRAY[]::text[],ARRAY['memory.manage'],'retained_history')",[installation,userId])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[installation])
  await pool.query(`DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pin_lifecycle_memory') THEN CREATE ROLE pin_lifecycle_memory LOGIN PASSWORD 'only-test';END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pin_lifecycle_relay') THEN CREATE ROLE pin_lifecycle_relay LOGIN PASSWORD 'only-test';END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pin_lifecycle_migrator') THEN CREATE ROLE pin_lifecycle_migrator NOLOGIN;END IF;END $$`)
  await namespace.provisionSharedDatabase(pool,{memoryRole:'pin_lifecycle_memory',relayRole:'pin_lifecycle_relay',migratorRole:'pin_lifecycle_migrator'})
  const u=new URL(url);u.username='pin_lifecycle_memory';u.password='only-test';memory=db.createMemoryPool({databaseUrl:u.href,databaseNamespace:'memory',dbPoolMax:6})
  u.username='pin_lifecycle_relay';relay=new pg.Pool({connectionString:u.href,max:6})
  dir=realpathSync(await mkdtemp(join(tmpdir(),'pocketctl-processing-pins-')))
  const storage=new FilesystemArchiveStorage(dir,config.maxCompressedBytes,0);disk=storage;makeObserved=observed.createObservedSourceReader
  executor=new SessionLifecycleExecutor(relay,config,storage,'native-processing-pin-fixture')
  observedReader=observed.createObservedSourceReader(memory,{storage,limits:{maxRawBytes:config.maxChunkBytes,maxCompressedBytes:config.maxCompressedBytes,maxRecords:1000}})
 },60000)
 afterAll(async()=>{await memory?.end();await relay?.end();await pool?.end();if(dir)await rm(dir,{recursive:true,force:true})})
 async function fixture(session:string,days:number){
  await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,title,last_activity_at,last_business_activity_at,activity_verified,agent_type)
   VALUES($1,$2,'native-host','idle','processing pin fixture',NOW()-$3::int*interval '1 day',NOW()-$3::int*interval '1 day',true,'codex')`,[session,userId,days])
  await pool.query("INSERT INTO events(session_id,user_id,event_type,payload,effect_status) VALUES($1,$2,'agent_text','{\"text\":\"private exact body\"}','completed')",[session,userId])
  await pool.query("UPDATE events SET created_at=NOW()-$2::int*interval '1 day' WHERE session_id=$1",[session,days])
  await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
  const job=(await pool.query("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES(gen_random_uuid(),$1,'extract_candidates',$2,85,'running','native-worker',1,clock_timestamp()+interval '5 minutes') RETURNING job_id",[installation,session])).rows[0].job_id
  const scope={installationId:installation,principalUserId:String(userId),ownerScopeKind:'personal',ownerScopeId:installation,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
  const root={kind:'relay_event',key:userId+':'+session}
  return {job,scope,root,session}
 }
 async function lease(session:string,action:'purge'|'archive'){
  const epoch=(await pool.query('SELECT activity_epoch::text FROM sessions WHERE session_id=$1',[session])).rows[0].activity_epoch
  await executor.jobs.enqueue({userId,sessionId:session,action,activityEpoch:epoch,policyVersion:config.policyVersion})
  return (await executor.jobs.claim('native-lifecycle-worker',300000))!
 }
 test('ordinary actual component purge retries its original job after bounded pin expiry',async()=>{
  const f=await fixture('native-purge',100),child=await fixture('native-purge-child',100)
  await pool.query('UPDATE sessions SET parent_session_id=$1 WHERE session_id=$2',[f.session,child.session])
  const page=await observedReader.listHeads(child.scope,child.root)
  const execution=(await memory.query("SELECT shared.capture_memory_job_source($1,'native-worker',1,'canonical-active') AS e",[child.job])).rows[0].e.executionId
  expect((await memory.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,FALSE) AS ok',[execution,child.scope,child.root.key,page.version])).rows[0].ok).toBe(true)
  const first=await lease(f.session,'purge');expect(await executor.execute(first,{extensionMode:'enabled'})).toBe('partial')
  const blocked=(await pool.query('SELECT state,activity_epoch::text,next_attempt_at-NOW() AS retry FROM session_lifecycle_jobs WHERE operation_id=$1',[first.operationId])).rows[0]
  expect(blocked.state).toBe('partial');expect(blocked.activity_epoch).toBe(first.activityEpoch);expect(blocked.retry.minutes??0).toBeLessThanOrEqual(1)
  expect(await executor.jobs.claim('too-early',300000,{policyVersion:config.policyVersion,action:'purge'})).toBeNull()
  expect((await pool.query('SELECT result FROM session_lifecycle_jobs WHERE operation_id=$1',[first.operationId])).rows[0].result.reason).toBe('source_processing_pin_active')
  expect((await pool.query('SELECT count(*)::int AS n FROM events WHERE session_id=ANY($1::varchar[])',[[f.session,child.session]])).rows[0].n).toBe(2)
  const clock=await pool.connect();try{await clock.query("BEGIN;SET LOCAL session_replication_role=replica");await clock.query("UPDATE shared.memory_source_processing_pins SET lease_until=clock_timestamp()-interval '1 second' WHERE execution_id=$1",[execution]);await clock.query('COMMIT')}finally{clock.release()}
  // Move only the fixture retry clock: retain the original audit job and epoch.
  await pool.query('UPDATE session_lifecycle_jobs SET next_attempt_at=NOW() WHERE operation_id=$1',[first.operationId])
  const retry=await lease(f.session,'purge')
  expect(retry.operationId).toBe(first.operationId);expect(retry.activityEpoch).toBe(first.activityEpoch);expect(retry.attempt).toBe(first.attempt+1)
  expect(await executor.execute(retry,{extensionMode:'enabled'})).toBe('partial')
  expect((await pool.query('SELECT 1 FROM sessions WHERE session_id=ANY($1::varchar[])',[[f.session,child.session]])).rowCount).toBe(0)
 })
 test('active durable pin permits real archive/cooling and exact cold-body reads',async()=>{
  const f=await fixture('native-cooling',40),page=await observedReader.listHeads(f.scope,f.root)
  const execution=(await memory.query("SELECT shared.capture_memory_job_source($1,'native-worker',1,'canonical-active') AS e",[f.job])).rows[0].e.executionId
  expect((await memory.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,FALSE) AS ok',[execution,f.scope,f.root.key,page.version])).rows[0].ok).toBe(true)
  expect(await executor.execute(await lease(f.session,'archive'))).toBe('succeeded')
  expect((await pool.query('SELECT content_state FROM sessions WHERE session_id=$1',[f.session])).rows[0].content_state).toBe('cold')
  const cold=await observedReader.listHeads(f.scope,f.root)
  const bodies=await observedReader.resolveBodies(f.scope,f.root,cold.heads,cold.version)
  expect(bodies[0].payload).toEqual({text:'private exact body'})
  expect((await memory.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,TRUE) AS ok',[execution,f.scope,f.root.key,page.version])).rows[0].ok).toBe(false)
 })
 test('native explicit privacy deletion ignores active pin; in-flight old body/result cannot return',async()=>{
  const f=await fixture('native-privacy',40)
  await source.withSourceJobExecution(memory,{jobId:f.job,claimedBy:'native-worker',claimEpoch:1},async()=>{
   const page=await observedReader.listHeads(f.scope,f.root)
   const bodies=await observedReader.resolveBodies(f.scope,f.root,page.heads,page.version);expect(bodies[0].payload.text).toBe('private exact body')
   expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins WHERE session_id=$1',[f.session])).rows[0].n).toBe(1)
   const c=await relay.connect();try{await c.query('BEGIN');await deleteSessionInTransaction(c,f.session,{extensionMode:'enabled'});await c.query('COMMIT')}finally{c.release()}
   expect((await pool.query('SELECT 1 FROM sessions WHERE session_id=$1',[f.session])).rowCount).toBe(0)
   expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins WHERE session_id=$1',[f.session])).rows[0].n).toBe(1)
   await expect(observedReader.resolveBodies(f.scope,f.root,page.heads,page.version)).rejects.toThrow()
   await expect(source.assertSourceProviderExecution()).rejects.toThrow()
   const output=await memory.connect();try{await output.query('BEGIN');await expect(source.guardSourceExecutionCommit(output,installation)).rejects.toThrow()}finally{await output.query('ROLLBACK');output.release()}
  })
 })
 test('missing independent contract is inert, installed unknown contract fails closed',async()=>{
  const f=await fixture('native-contract',100)
  const independent=await pool.connect();try{await independent.query('BEGIN;ALTER TABLE shared.memory_source_contract RENAME TO temporary_processing_pin_contract');await assertNoSourceProcessingPins(independent,userId,[f.session])}finally{await independent.query('ROLLBACK');independent.release()}
  const c=await relay.connect();try{
   await c.query('BEGIN');await assertNoSourceProcessingPins(c,userId,[f.session]);await c.query('ROLLBACK')
   await pool.query('UPDATE shared.memory_source_contract SET processing_pin_version=99')
   await expect(assertNoSourceProcessingPins(c,userId,[f.session])).rejects.toThrow('source_processing_pin_contract_unavailable')
  }finally{await c.query('ROLLBACK');c.release();await pool.query('UPDATE shared.memory_source_contract SET processing_pin_version=1')}
  await pool.query('REVOKE EXECUTE ON FUNCTION shared.memory_source_processing_blocks_purge(INT,TEXT[]) FROM pin_lifecycle_relay')
  try{await expect(assertNoSourceProcessingPins(relay as any,userId,[f.session])).rejects.toMatchObject({code:'42501'})}finally{await pool.query('GRANT EXECUTE ON FUNCTION shared.memory_source_processing_blocks_purge(INT,TEXT[]) TO pin_lifecycle_relay')}
 })
 test('privacy deletion during actual cold archive IO rejects old response and preserves observer reporting',async()=>{
  const f=await fixture('native-inflight-privacy',40)
  expect(await executor.execute(await lease(f.session,'archive'))).toBe('succeeded')
  const page=await observedReader.listHeads(f.scope,f.root)
  let started!:()=>void,release!:()=>void
  const began=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve}),observations:any[]=[]
  const context=await import(new URL('../../../memory/src/sources/pool-context.ts',import.meta.url).href)
  context.bindSourcePool(memory,{namespace:'memory',readerObserver:(...args:any[])=>observations.push(args)})
  const reader=makeObserved(memory,{storage:{namespace:disk.namespace,read:async(key:string)=>{started();await gate;return disk.read(key)}},limits:{maxRawBytes:config.maxChunkBytes,maxCompressedBytes:config.maxCompressedBytes,maxRecords:1000}})
  await source.withSourceJobExecution(memory,{jobId:f.job,claimedBy:'native-worker',claimEpoch:1},async()=>{
   const outcome=reader.resolveBodies(f.scope,f.root,page.heads,page.version).then((value:unknown)=>({value}),(error:Error)=>({error}))
   try{
    await began
    expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins WHERE session_id=$1',[f.session])).rows[0].n).toBe(1)
    const c=await relay.connect();try{await c.query('BEGIN');await deleteSessionInTransaction(c,f.session,{extensionMode:'enabled'});await c.query('COMMIT')}finally{c.release()}
   }finally{release()}
   const result=await outcome;expect(result.error).toBeDefined();expect(result.value).toBeUndefined()
   expect(observations.some(row=>row[0]==='resolveBodies'&&row[1]==='relay_event')).toBe(true)
   expect((await reader.checkCurrent(f.scope,f.root,page.version)).state).not.toBe('current')
   expect(observations.some(row=>row[0]==='checkCurrent'&&row[1]==='relay_event')).toBe(true)
   await expect(source.assertSourceProviderExecution()).rejects.toThrow()
  })
 })

 test('a genuinely superseded ordinary purge remains cancelled and cannot be reclaimed',async()=>{
  const f=await fixture('native-true-supersession',100),original=await lease(f.session,'purge')
  await pool.query("UPDATE sessions SET status='busy' WHERE session_id=$1",[f.session])
  expect(await executor.execute(original,{extensionMode:'enabled'})).toBe('cancelled')
  const repeated=await executor.jobs.enqueue({userId,sessionId:f.session,action:'purge',activityEpoch:original.activityEpoch,policyVersion:config.policyVersion})
  expect(repeated.operationId).toBe(original.operationId);expect(repeated.state).toBe('cancelled')
  expect(await executor.jobs.claim('must-not-revive',300000,{policyVersion:config.policyVersion,action:'purge'})).toBeNull()
  expect((await pool.query('SELECT 1 FROM sessions WHERE session_id=$1',[f.session])).rowCount).toBe(1)
 })

})
