import {beginFreshInputFixture} from './input-start-fixture.js'
import {installNativeAliasFixture} from './native-alias-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase,assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {withSourceJobExecution,protectSourceExecutionBodies,assertSourceProviderExecution,guardSourceExecutionCommit,startSourceProviderAttempt,finishSourceProviderAttempt} from '../../sources/source-execution.js'
const url=process.env.SHARED_PROCESSING_PIN_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000083',job='20000000-0000-0000-0000-000000000083'
const scope={installationId:inst,principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
const root={kind:'relay_event' as const,key:'1:session'},version={content:'1',authorization:'1',storage:'1'}
suite('bounded durable native personal processing pins',()=>{
 let pool:pg.Pool,runtime:pg.Pool,relay:pg.Pool,execution:string
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:8})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  const inputFoundation=await beginFreshInputFixture(pool)
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY);INSERT INTO public.users VALUES(1),(2);
   CREATE TABLE public.daemons(daemon_id text,user_id int);INSERT INTO public.daemons VALUES('daemon',1);
   CREATE TABLE public.sessions(session_id text PRIMARY KEY,user_id int,daemon_id text,source text,content_state text,agent_type text,activity_epoch bigint NOT NULL DEFAULT 0,last_business_activity_at timestamptz DEFAULT '2026-11-06T00:00:00Z');
   INSERT INTO public.sessions(session_id,user_id,daemon_id,source,content_state,agent_type) VALUES('session',1,'daemon','codex','hot','codex');
   CREATE TABLE public.extension_providers(provider_id text,status text);INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb DEFAULT '{}',start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0);
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,roles text[],state text,membership_revision bigint DEFAULT 1);
   CREATE TABLE public.deleted_sessions(session_id text);
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='processing_pin_memory') THEN CREATE ROLE processing_pin_memory LOGIN PASSWORD 'only-test';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='processing_pin_relay') THEN CREATE ROLE processing_pin_relay LOGIN PASSWORD 'only-test';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='processing_pin_migrator') THEN CREATE ROLE processing_pin_migrator NOLOGIN;END IF;
   END $$`)
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[inst])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'extract_candidates','pins',85,'running','worker',1,clock_timestamp()+interval '5 minutes')",[job,inst])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[inst])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:session')")
  await installNativeAliasFixture(pool,{inputPolicy:'retained_history',inputFoundation})
  await provisionSharedDatabase(pool,{memoryRole:'processing_pin_memory',relayRole:'processing_pin_relay',migratorRole:'processing_pin_migrator'})
  const u=new URL(url);u.username='processing_pin_memory';u.password='only-test';runtime=createMemoryPool({databaseUrl:u.href,databaseNamespace:'memory',dbPoolMax:6})
  u.username='processing_pin_relay';relay=new pg.Pool({connectionString:u.href,max:4})
 },60000)
 afterAll(async()=>{await runtime?.end();await relay?.end();await pool?.end()})
 beforeEach(async()=>{
  await pool.query('DELETE FROM shared.memory_source_processing_pins;DELETE FROM shared.memory_source_processing_windows;DELETE FROM public.deleted_sessions')
  await pool.query("UPDATE public.sessions SET content_state='hot',activity_epoch=0,last_business_activity_at='2026-11-06T00:00:00Z'")
  await pool.query("UPDATE shared.memory_source_modes SET mode='shared-active',generation=2 WHERE installation_id=$1",[inst])
  await pool.query("UPDATE memory.memory_jobs SET state='running',claimed_by='worker',claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1",[job])
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  execution=(await runtime.query("SELECT shared.capture_memory_job_source($1,'worker',$2,'canonical-active') AS e",[job,epoch])).rows[0].e.executionId
 })
 const pin=async(id=execution,s=scope,v=version,renew=false)=>(await runtime.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,$5) AS ok',[id,s,root.key,v,renew])).rows[0].ok
 const blocks=async()=>(await relay.query("SELECT shared.memory_source_processing_blocks_purge(1,ARRAY['session']) AS blocked")).rows[0].blocked
 test('metadata lease is short and protects ordinary purge; cooling and expiry remain allowed',async()=>{
  expect(await pin()).toBe(true);expect(await blocks()).toBe(true)
  const first=(await pool.query('SELECT *,lease_until-clock_timestamp() AS remaining FROM shared.memory_source_processing_pins')).rows[0]
  expect(first.remaining.seconds).toBeLessThanOrEqual(30)
  await pool.query("UPDATE public.sessions SET content_state='cold'");expect(await blocks()).toBe(true)
  await pool.query("BEGIN;SET LOCAL session_replication_role=replica;UPDATE shared.memory_source_processing_pins SET lease_until=clock_timestamp()-interval '1 second';COMMIT")
  expect(await blocks()).toBe(false);expect(await pin(execution,scope,version,true)).toBe(false)
 })
 test('renewal is clamped; release/reclaim and status epochs cannot restart unchanged root window',async()=>{
  expect(await pin()).toBe(true)
  await pool.query("UPDATE shared.memory_source_processing_windows SET started_at=t.stamp-interval '110 seconds',hard_deadline=t.stamp+interval '10 seconds' FROM(SELECT clock_timestamp() AS stamp)t")
  // Existing rows retain their original window. A release/new claim binds to
  // the shortened synthetic window; lease cannot exceed its absolute end.
  await runtime.query('SELECT shared.release_memory_source_processing_pins($1)',[execution])
  expect(await pin()).toBe(true)
  expect((await pool.query('SELECT lease_until=hard_deadline AS clamped FROM shared.memory_source_processing_pins')).rows[0].clamped).toBe(true)
  await pool.query("UPDATE shared.memory_source_processing_windows SET started_at=t.stamp-interval '3 minutes',hard_deadline=t.stamp-interval '1 minute' FROM(SELECT clock_timestamp() AS stamp)t")
  await runtime.query('SELECT shared.release_memory_source_processing_pins($1)',[execution])
  await pool.query('UPDATE public.sessions SET activity_epoch=activity_epoch+1')
  expect(await pin()).toBe(false)
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  const next=(await runtime.query("SELECT shared.capture_memory_job_source($1,'worker',$2,'canonical-active') AS e",[job,epoch])).rows[0].e.executionId
  expect(await pin(next)).toBe(false)
  await pool.query("UPDATE public.sessions SET activity_epoch=activity_epoch+1,last_business_activity_at=last_business_activity_at+interval '1 second'")
  expect(await pin(next)).toBe(true)
 })
 test('original claim, control, mode, full version and cross-installation are rechecked',async()=>{
  expect(await pin(execution,{...scope,installationId:job})).toBe(false)
  expect(await pin(execution,scope,{...version,storage:'9'})).toBe(false)
  expect(await pin(execution,{...scope,principalUserId:'bad'})).toBe(false)
  expect(await pin(execution,{...scope,body:'must never be persisted'} as any)).toBe(false)
  expect(await pin(execution,scope,{...version,body:'must never be persisted'} as any)).toBe(false)
  expect(await pin(execution,{...scope,configVersion:{} as any})).toBe(false)
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job]);expect(await pin()).toBe(false)
 })
 test('role isolation and read-only rejection preserve authority',async()=>{
  await expect(runtime.query('SELECT * FROM shared.memory_source_processing_pins')).rejects.toMatchObject({code:'42501'})
  await expect(runtime.query('UPDATE public.sessions SET activity_epoch=1')).rejects.toMatchObject({code:'42501'})
  await expect(relay.query('SELECT shared.release_memory_source_processing_pins($1)',[execution])).rejects.toMatchObject({code:'42501'})
  await expect(runtime.query("SELECT shared.memory_source_processing_blocks_purge(1,ARRAY['session'])")).rejects.toMatchObject({code:'42501'})
  const c=await runtime.connect();try{await c.query('BEGIN READ ONLY');await expect(c.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,FALSE)',[execution,scope,root.key,version])).rejects.toMatchObject({code:'25006'})}finally{await c.query('ROLLBACK');c.release()}
  expect(await pin()).toBe(true)
 })
 test('Session/owner final fence versus acquisition fails finitely in either order',async()=>{
  const purge=await relay.connect(),reader=await runtime.connect()
  try{
   await purge.query('BEGIN');expect((await purge.query("SELECT shared.memory_source_processing_blocks_purge(1,ARRAY['session']) AS b")).rows[0].b).toBe(false)
   expect(await pin()).toBe(false);await purge.query('COMMIT')
   await reader.query('BEGIN');expect((await reader.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,FALSE) AS b',[execution,scope,root.key,version])).rows[0].b).toBe(true)
   await expect(purge.query("SELECT shared.memory_source_processing_blocks_purge(1,ARRAY['session'])")).rejects.toThrow('processing_pin_purge_busy')
   await reader.query('COMMIT');expect(await blocks()).toBe(true)
  }finally{await purge.query('ROLLBACK');await reader.query('ROLLBACK');purge.release();reader.release()}
 })
 test('private execution releases pins on normal and thrown work; public and legacy bodies are inert',async()=>{
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  for(const fail of [false,true]){
   const work=withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
    await protectSourceExecutionBodies(runtime,scope,root,version);expect(await blocks()).toBe(true)
    await assertSourceProviderExecution();if(fail)throw Error('synthetic work failure')
   })
   if(fail)await expect(work).rejects.toThrow('synthetic work failure');else await work
   expect(await blocks()).toBe(false)
  }
  await protectSourceExecutionBodies(runtime,scope,root,version);expect(await blocks()).toBe(false)
 })
 test('expiry during work rejects new provider admission and commit, without automatic model dispatch',async()=>{
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
   await protectSourceExecutionBodies(runtime,scope,root,version)
   await pool.query("BEGIN;SET LOCAL session_replication_role=replica;UPDATE shared.memory_source_processing_pins SET lease_until=clock_timestamp()-interval '1 second';COMMIT")
   await expect(assertSourceProviderExecution()).rejects.toThrow('processing_pin_expired_or_unavailable')
   const c=await runtime.connect();try{await c.query('BEGIN');await expect(guardSourceExecutionCommit(c,inst)).rejects.toThrow('processing_pin_expired_or_unavailable')}finally{await c.query('ROLLBACK');c.release()}
  })
 })
 test('privacy tombstone immediately rejects renewal and output, while lease remains durable',async()=>{
  expect(await pin()).toBe(true);await pool.query("INSERT INTO public.deleted_sessions VALUES('session')")
  expect(await pin(execution,scope,version,true)).toBe(false)
  expect((await runtime.query("SELECT shared.lock_memory_personal_source_commit($1,'relay_event',$2,$3,FALSE) AS ok",[scope,root.key,version])).rows[0].ok).toBe(false)
  expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins')).rows[0].n).toBe(1)
 })
 test('mode/control changes reject acquisition and renewal under the original execution',async()=>{
  expect(await pin()).toBe(true)
  await pool.query('UPDATE shared.memory_source_control_clock SET revision=revision+1')
  expect(await pin(execution,scope,version,true)).toBe(false)
  await pool.query("UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=$1",[inst])
  expect(await pin()).toBe(false)
 })
 test('per-root and per-installation quotas enforce real authority-bound acquisitions',async()=>{
  expect(await pin()).toBe(true)
  for(let i=0;i<8;i++){
   const id=(await pool.query("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES(gen_random_uuid(),$1,'extract_candidates',$2,85,'running','quota',1,clock_timestamp()+interval '5 minutes') RETURNING job_id",[inst,'quota-'+i])).rows[0].job_id
   const e=(await runtime.query("SELECT shared.capture_memory_job_source($1,'quota',1,'canonical-active') AS e",[id])).rows[0].e.executionId
   expect(await pin(e)).toBe(i<7)
  }
  await pool.query('DELETE FROM shared.memory_source_processing_pins')
  for(let i=0;i<65;i++){
   const session='quota-session-'+i,rootKey='1:'+session
   await pool.query("INSERT INTO public.sessions(session_id,user_id,daemon_id,source,content_state,agent_type) VALUES($1,1,'daemon','codex','hot','codex')",[session])
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[rootKey])
   expect((await runtime.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,FALSE) AS ok',[execution,scope,rootKey,version])).rows[0].ok).toBe(i<64)
  }
  expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins')).rows[0].n).toBe(64)
 })
 test('GC removes at most 128 expired lease rows while preserving absolute root metadata',async()=>{
  const c=await pool.connect()
  try{
   await c.query("BEGIN;SET LOCAL session_replication_role=replica")
   await c.query("INSERT INTO shared.memory_source_processing_windows SELECT 1,'gc-'||n,0,NULL,t.stamp-interval '3 minutes',t.stamp-interval '1 minute' FROM generate_series(1,130)n CROSS JOIN(SELECT clock_timestamp() AS stamp)t")
   await c.query("INSERT INTO shared.memory_source_processing_pins SELECT $1::uuid,$2::uuid,1,session_id,$3::jsonb,$4::jsonb,0,hard_deadline,hard_deadline FROM shared.memory_source_processing_windows WHERE session_id LIKE 'gc-%'",[execution,inst,scope,version])
   await c.query('COMMIT')
  }finally{c.release()}
  expect(await pin()).toBe(true)
  expect((await pool.query("SELECT count(*)::int AS n FROM shared.memory_source_processing_pins WHERE session_id LIKE 'gc-%'")).rows[0].n).toBe(2)
  expect((await pool.query("SELECT count(*)::int AS n FROM shared.memory_source_processing_windows WHERE session_id LIKE 'gc-%'")).rows[0].n).toBe(130)
 })
 test('claim expiry at physical COMMIT rolls back acquisition',async()=>{
  await pool.query("UPDATE memory.memory_jobs SET claim_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE job_id=$1",[job])
  const c=await runtime.connect()
  try{
   await c.query('BEGIN')
   expect((await c.query('SELECT shared.acquire_memory_source_processing_pin($1,$2,$3,$4,FALSE) AS ok',[execution,scope,root.key,version])).rows[0].ok).toBe(true)
   await c.query('SELECT pg_sleep(0.35)')
   await expect(c.query('COMMIT')).rejects.toThrow('source_processing_pin_unavailable')
  }finally{await c.query('ROLLBACK');c.release()}
  expect(await blocks()).toBe(false)
 })
 test('one real renewal chain runs outside body work and abort releases without a paid retry',async()=>{
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch,abort=new AbortController()
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
   await protectSourceExecutionBodies(runtime,scope,root,version)
   const first=(await pool.query('SELECT lease_until FROM shared.memory_source_processing_pins')).rows[0].lease_until.getTime()
   await new Promise(resolve=>setTimeout(resolve,10300))
   const current=(await pool.query('SELECT lease_until<=hard_deadline AS bounded,lease_until FROM shared.memory_source_processing_pins')).rows[0]
   expect(current.bounded).toBe(true);expect(current.lease_until.getTime()-first).toBeGreaterThan(9000)
   expect((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='processing_pin_memory' AND state='idle in transaction'")).rows[0].n).toBe(0)
   abort.abort()
   await expect(assertSourceProviderExecution()).rejects.toThrow('processing_pin_expired_or_unavailable')
  },{signal:abort.signal})
  expect(await blocks()).toBe(false)
 },15000)

 test('canonical shadow protects source IO but cannot charge; legacy and Team branches add no pins',async()=>{
  await pool.query("UPDATE shared.memory_source_modes SET mode='shared-shadow' WHERE installation_id=$1",[inst])
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  let epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
   await protectSourceExecutionBodies(runtime,scope,root,version);expect(await blocks()).toBe(true)
   await expect(assertSourceProviderExecution()).rejects.toThrow('source_shadow_provider_forbidden')
   expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_provider_attempts')).rows[0].n).toBe(0)
  },{branch:'canonical-shadow'})
  expect(await blocks()).toBe(false)
  await pool.query('UPDATE memory.memory_jobs SET claim_epoch=claim_epoch+1 WHERE job_id=$1',[job])
  epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
   await protectSourceExecutionBodies(runtime,scope,root,version)
   await protectSourceExecutionBodies(runtime,{...scope,ownerScopeKind:'team' as any},{kind:'team_collaboration',key:'team'},version)
   expect(await blocks()).toBe(false)
  },{branch:'legacy-active'})
 })
 test('failed best-effort release is bounded and leaves only a short durable lease',async()=>{
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch,locker=await pool.connect()
  try{
   const began=Date.now()
   await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
    await protectSourceExecutionBodies(runtime,scope,root,version)
    await locker.query('BEGIN');await locker.query('SELECT 1 FROM shared.memory_source_processing_pins FOR UPDATE')
   })
   expect(Date.now()-began).toBeLessThan(2500)
   await locker.query('ROLLBACK');expect(await blocks()).toBe(true)
   await runtime.query('SELECT shared.release_memory_source_processing_pins($1)',[execution])
  }finally{await locker.query('ROLLBACK');locker.release()}
 })
 test('output lease expires at the physical commit even after an earlier valid guard',async()=>{
  expect(await pin()).toBe(true)
  // Controlled fixture clock injection, not a runtime lease API.
  const clock=await pool.connect();try{await clock.query('BEGIN;SET LOCAL session_replication_role=replica');await clock.query("UPDATE shared.memory_source_processing_pins SET lease_until=clock_timestamp()+interval '400 milliseconds' WHERE execution_id=$1",[execution]);await clock.query('COMMIT')}finally{clock.release()}
  const c=await runtime.connect();try{
   await c.query('BEGIN')
   expect((await c.query('SELECT shared.guard_memory_source_processing_pins($1,1) AS ok',[execution])).rows[0].ok).toBe(true)
   expect((await c.query('SELECT shared.guard_memory_job_source_commit($1) AS ok',[execution])).rows[0].ok).toBe(true)
   await c.query('SELECT pg_sleep(0.45)');await expect(c.query('COMMIT')).rejects.toThrow('source_processing_pin_unavailable')
  }finally{await c.query('ROLLBACK');c.release()}
 })

 test('a new independently current vector and reordered scope reuse one unchanged root deadline',async()=>{
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
   await protectSourceExecutionBodies(runtime,scope,root,version)
   const deadline=(await pool.query('SELECT hard_deadline::text FROM shared.memory_source_processing_pins')).rows[0].hard_deadline
   await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:session')")
   const current={...version,content:'2'},reordered=Object.fromEntries(Object.entries(scope).reverse()) as typeof scope
   await protectSourceExecutionBodies(runtime,reordered,root,current)
   expect((await pool.query('SELECT hard_deadline::text,source_version FROM shared.memory_source_processing_pins')).rows).toEqual([{hard_deadline:deadline,source_version:current}])
   const c=await runtime.connect();try{await c.query('BEGIN');await guardSourceExecutionCommit(c,inst);expect((await c.query("SELECT shared.lock_memory_personal_source_commit($1,'relay_event',$2,$3,FALSE) AS ok",[scope,root.key,version])).rows[0].ok).toBe(false)}finally{await c.query('ROLLBACK');c.release()}
  })
  await pool.query("UPDATE shared.memory_source_work SET revision=1,processed_revision=0 WHERE source_kind='relay_event' AND root_key='1:session'")
 })

 test('known incurred provider effects remain recordable after pin failure without a second dispatch',async()=>{
  const epoch=(await pool.query('SELECT claim_epoch::text FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].claim_epoch,reservation='30000000-0000-0000-0000-000000000083'
  await runtime.query("INSERT INTO memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES($1,'processing-pin-incurred','text',100,100)",[reservation])
  await withSourceJobExecution(runtime,{jobId:job,claimedBy:'worker',claimEpoch:epoch},async()=>{
   await protectSourceExecutionBodies(runtime,scope,root,version)
   const token=await startSourceProviderAttempt(reservation,'one-synthetic-attempt')
   await pool.query("BEGIN;SET LOCAL session_replication_role=replica;UPDATE shared.memory_source_processing_pins SET lease_until=clock_timestamp()-interval '1 second';COMMIT")
   await expect(assertSourceProviderExecution()).rejects.toThrow('processing_pin_expired_or_unavailable')
   await finishSourceProviderAttempt(token,'accounted')
   await expect(startSourceProviderAttempt(reservation,'one-synthetic-attempt')).rejects.toThrow('processing_pin_expired_or_unavailable')
  })
  expect((await pool.query('SELECT state FROM shared.memory_source_provider_attempts WHERE reservation_id=$1',[reservation])).rows).toEqual([{state:'accounted'}])
 })

 test('personal pins reject Team-only metadata keys carrying body/config without creating a window',async()=>{
  for(const field of ['participantRevision','bindingRevision']){
   for(const value of ['private source body','{"api_key":"private-config"}','1']){
    expect(await pin(execution,{...scope,[field]:value} as any)).toBe(false)
    expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_pins')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM shared.memory_source_processing_windows')).rows[0].n).toBe(0)
   }
  }
  expect(await pin()).toBe(true);expect(await pin(execution,scope,version,true)).toBe(true)
 })
 test('runtime startup refuses disabled or dropped exact deferred output-expiry trigger',async()=>{
  await pool.query("UPDATE shared.memory_source_modes SET mode='paused' WHERE installation_id=$1",[inst])
  await assertSharedRuntimeContract(runtime)
  try{
   await pool.query('ALTER TABLE shared.memory_source_executions DISABLE TRIGGER memory_execution_processing_commit')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_processing_output_fence_missing')
   await pool.query('ALTER TABLE shared.memory_source_executions ENABLE TRIGGER memory_execution_processing_commit')
   await assertSharedRuntimeContract(runtime)
   await pool.query('DROP TRIGGER memory_execution_processing_commit ON shared.memory_source_executions')
   await expect(assertSharedRuntimeContract(runtime)).rejects.toThrow('shared_processing_output_fence_missing')
  }finally{
   await pool.query('DROP TRIGGER IF EXISTS memory_execution_processing_commit ON shared.memory_source_executions;CREATE CONSTRAINT TRIGGER memory_execution_processing_commit AFTER UPDATE ON shared.memory_source_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_execution_processing_commit()')
  }
  await assertSharedRuntimeContract(runtime)
 })

})
