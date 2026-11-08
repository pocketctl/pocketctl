import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
const url=process.env.SHARED_R1_BOOTSTRAP_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('bounded bootstrap after control changes without new source events',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:4})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  const {initDB}=await import(new URL('../../../../relay/src/db.ts',import.meta.url).href)
  const {applyRelaySourceCapture}=await import(new URL('../../../../relay/src/shared-source/capture.ts',import.meta.url).href)
  const {applyRelayTeamSourceCapture}=await import(new URL('../../../../relay/src/shared-source/team-capture.ts',import.meta.url).href)
  const {applyRelayControlCapture}=await import(new URL('../../../../relay/src/shared-source/control-capture.ts',import.meta.url).href)
  await initDB(pool);await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await applyRelaySourceCapture(pool);await applyRelayTeamSourceCapture(pool);await applyRelayControlCapture(pool)
  await pool.query("INSERT INTO public.users(id,email,password_hash) VALUES(1,'bootstrap@example.invalid','synthetic-only')")
  await pool.query("INSERT INTO public.sessions(session_id,user_id,source) VALUES('old-session-a',1,'codex'),('old-session-b',1,'codex')")
  await pool.query(`DO $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bootstrap_memory') THEN CREATE ROLE bootstrap_memory LOGIN PASSWORD 'only-test';END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bootstrap_relay') THEN CREATE ROLE bootstrap_relay NOLOGIN;END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bootstrap_migrator') THEN CREATE ROLE bootstrap_migrator NOLOGIN;END IF;
   END $$`)
  await provisionSharedDatabase(pool,{memoryRole:'bootstrap_memory',relayRole:'bootstrap_relay',migratorRole:'bootstrap_migrator'})
  const target=new URL(url);target.username='bootstrap_memory';target.password='only-test'
  runtime=createMemoryPool({databaseUrl:target.href,databaseNamespace:'memory',dbPoolMax:2})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 test('pages and response loss retain existing sessions and old unavailable roots, with no body or model work',async()=>{
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:deleted-session')")
  await pool.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
  const claim=(await pool.query("SELECT control_kind,control_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_control_work('bootstrap',30,128)")).rows.find(r=>r.control_kind==='provider')!
  const step=async()=>(await runtime.query('SELECT shared.step_memory_control_bootstrap($1,$2,$3,$4,$5,1) AS page',[claim.control_kind,claim.control_key,claim.lease_token,'bootstrap',claim.claimed_revision])).rows[0].page
  await step() // COMMIT response intentionally discarded.
  let result:any
  for(let n=0;n<30;n++){result=await step();if(result.complete)break}
  expect(result.complete).toBe(true)
  expect((await pool.query("SELECT root_key FROM shared.memory_source_work WHERE source_kind='relay_event' ORDER BY root_key")).rows.map(r=>r.root_key)).toEqual(['1:deleted-session','1:old-session-a','1:old-session-b'])
  expect((await pool.query('SELECT 1 FROM memory.source_events')).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM memory.memory_provider_budget_reservations')).rowCount).toBe(0)
  await expect(runtime.query('SELECT * FROM public.sessions')).rejects.toMatchObject({code:'42501'})
  await expect(runtime.query('SELECT * FROM shared.memory_source_control_progress')).rejects.toMatchObject({code:'42501'})
  await expect(step()).rejects.toThrow('source_control_lease_lost')
 })
 test('a missing-root storage insertion makes bootstrap retry without waiting behind the publisher',async()=>{
  await pool.query("INSERT INTO public.sessions(session_id,user_id,source) VALUES('cold-root',1,'codex')")
  await pool.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
  const claim=(await pool.query("SELECT control_kind,control_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_control_work('storage-race',30,128)")).rows.find(r=>r.control_kind==='provider')!
  const publisher=await pool.connect(),consumer=await runtime.connect()
  try{
   await publisher.query('BEGIN')
   await publisher.query("SELECT shared.mark_memory_source_storage_changed('relay_event','1:cold-root')")
   await consumer.query('BEGIN');await consumer.query("SET LOCAL statement_timeout='150ms'")
   await expect(consumer.query('SELECT shared.step_memory_control_bootstrap($1,$2,$3,$4,$5,128)',[claim.control_kind,claim.control_key,claim.lease_token,'storage-race',claim.claimed_revision])).rejects.toMatchObject({code:'55P03'})
   await consumer.query('ROLLBACK')
   await publisher.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
   await publisher.query('COMMIT')
   expect((await pool.query("SELECT revision::text,processed_revision::text FROM shared.memory_source_control_work WHERE control_kind='provider'")).rows[0].processed_revision).toBe('3')
  }finally{await consumer.query('ROLLBACK');await publisher.query('ROLLBACK');consumer.release();publisher.release()}
 })
 test('control changes restart the scan and an expired physical commit rolls back root updates',async()=>{
  await pool.query("UPDATE shared.memory_source_control_work SET lease_until=clock_timestamp()-interval '1 second' WHERE lease_token IS NOT NULL")
  const claim=(await pool.query("SELECT control_kind,control_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_control_work('restart-bootstrap',30,128)")).rows.find(r=>r.control_kind==='provider')!
  const args=[claim.control_kind,claim.control_key,claim.lease_token,'restart-bootstrap',claim.claimed_revision]
  const step=async()=>(await runtime.query('SELECT shared.step_memory_control_bootstrap($1,$2,$3,$4,$5,1) AS page',args)).rows[0].page
  const first=await step()
  await pool.query("SELECT shared.mark_memory_control_dirty('local','10000000-0000-0000-0000-000000000095')")
  const reset=await step()
  expect(reset.cursor).toBe(first.cursor)
  expect(BigInt(reset.controlRevision)).toBeGreaterThan(BigInt(first.controlRevision))
  const before=(await pool.query('SELECT source_kind,root_key,revision::text FROM shared.memory_source_work ORDER BY source_kind,root_key')).rows
  const c=await runtime.connect()
  try{
   await pool.query("UPDATE shared.memory_source_control_work SET lease_until=clock_timestamp()+interval '0.25 seconds' WHERE control_kind=$1 AND control_key=$2",args.slice(0,2))
   await c.query('BEGIN')
   await c.query('SELECT shared.step_memory_control_bootstrap($1,$2,$3,$4,$5,1)',args)
   await c.query('SELECT pg_sleep(0.3)')
   await expect(c.query('COMMIT')).rejects.toThrow('source_control_bootstrap_commit_fence')
   expect((await pool.query('SELECT source_kind,root_key,revision::text FROM shared.memory_source_work ORDER BY source_kind,root_key')).rows).toEqual(before)
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('the real scheduler stays closed until activation and drains metadata with renewed leases',async()=>{
  const {createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js')
  const errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:runtime,workerId:'real-bootstrap-scheduler',signal:new AbortController().signal,pageSize:1,onError:error=>errors.push(error)})
  const pending=async()=>Number((await pool.query(`SELECT(SELECT count(*) FROM shared.memory_source_control_work WHERE processed_revision<revision)
   +(SELECT count(*) FROM shared.memory_source_work WHERE processed_revision<revision) AS pending`)).rows[0].pending)
  try{
   const before=await pending()
   await scheduler.runOnce();expect(await pending()).toBe(before)
   await pool.query("UPDATE shared.memory_source_control_work SET lease_until=clock_timestamp()-interval '1 second' WHERE lease_token IS NOT NULL")
   await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
   for(let n=0;n<150&&await pending()>0;n++)await Promise.all([scheduler.runOnce(),scheduler.runOnce()])
   expect(errors).toEqual([]);expect(await pending()).toBe(0)
   expect((await pool.query('SELECT 1 FROM memory.source_events')).rowCount).toBe(0)
   expect((await pool.query('SELECT 1 FROM memory.memory_provider_budget_reservations')).rowCount).toBe(0)
  }finally{await scheduler.stop();await pool.query('UPDATE shared.memory_source_contract SET activation_ready=FALSE')}
 })
 test('historical archive invalidation drains without entering native distribution or positive processing',async()=>{
  const {createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js')
  const {canonicalPayloadHash}=await import('@pocketctl/session-source')
  const inst='10000000-0000-0000-0000-000000000096',id='20000000-0000-0000-0000-000000000096',root='1:old-session-a'
  const payload={text:'sole historical fixture body',turn_id:'historic-turn'}
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,
   source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version,legacy_owner_user_id,legacy_manifest_hash)
   VALUES($1::uuid,$2,'snapshot',$1::text,'old-session-a','historic-turn','agent_text',now(),$3,$4,
    'legacy_archive',$1::text,'old-session-a','{"content":"1","authorization":"1","storage":"0"}',$4,'canonical-json-sha256-v1','verified','legacy-archive-v1',1,$5)`,[id,inst,payload,canonicalPayloadHash(payload),'a'.repeat(64)])
  const errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:runtime,workerId:'legacy-invalidation-scheduler',signal:new AbortController().signal,pageSize:1,onError:error=>errors.push(error)})
  const work=async()=>(await pool.query("SELECT revision::text,processed_revision::text,attempt,last_error_code FROM shared.memory_source_work WHERE source_kind='legacy_archive' AND root_key=$1",[root])).rows[0]
  const positive=async()=>(await pool.query(`SELECT (SELECT count(*) FROM memory.source_turns) AS turns,(SELECT count(*) FROM memory.memory_jobs) AS jobs,
   (SELECT count(*) FROM memory.memory_provider_budget_reservations) AS budgets,(SELECT count(*) FROM shared.memory_source_progress) AS progress`)).rows[0]
  const before=await positive()
  try{
   await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
   for(const operation of ['insert','update','delete']){
    if(operation==='update')await pool.query('UPDATE memory.source_events SET legacy_manifest_hash=$1 WHERE source_event_id=$2',['b'.repeat(64),id])
    if(operation==='delete')await pool.query('DELETE FROM memory.source_events WHERE source_event_id=$1',[id])
    const pending=await work();expect(BigInt(pending.revision)).toBeGreaterThan(BigInt(pending.processed_revision))
    for(let n=0;n<100;n++){await scheduler.runOnce();const current=await work();if(current.revision===current.processed_revision)break}
    expect(errors).toEqual([])
    const current=await work();expect(current.processed_revision).toBe(current.revision);expect(current.attempt).toBe(0);expect(current.last_error_code).toBeNull()
    expect(await positive()).toEqual(before)
    expect((await pool.query("SELECT 1 FROM shared.memory_source_distributions WHERE source_kind='legacy_archive' AND root_key=$1",[root])).rowCount).toBe(0)
    if(operation!=='delete')expect((await pool.query('SELECT payload FROM memory.source_events WHERE source_event_id=$1',[id])).rows[0].payload).toEqual(payload)
   }
  }finally{await scheduler.stop();await pool.query('UPDATE shared.memory_source_contract SET activation_ready=FALSE')}
 })

})
