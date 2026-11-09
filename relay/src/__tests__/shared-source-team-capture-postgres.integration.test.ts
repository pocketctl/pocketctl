import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect,vi} from 'vitest'
import {applyRelayTeamSourceCapture,bootstrapTeamSourceRoots} from '../shared-source/team-capture.js'
const url=process.env.RELAY_TEAM_CAPTURE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('body-free Team collaboration and accepted-delivery capture',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:4})
  await pool.query(`DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;
   CREATE TABLE collaboration_calls(call_id text PRIMARY KEY,event_id text,team_session_id text,state text,outcome text);
   CREATE TABLE collaboration_events(event_id text PRIMARY KEY,call_id text,content text);
   CREATE TABLE team_task_submissions(submission_id uuid PRIMARY KEY,source_call_id text,task_id text,spec_revision bigint,summary text);
   CREATE TABLE team_delivery_memory_sources(source_session_id text PRIMARY KEY,submission_id uuid,decision_id uuid,revoked_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE team_acceptance_decisions(decision_id uuid PRIMARY KEY,decision text);
   CREATE TABLE team_task_specs(task_id text,revision bigint,goal text,acceptance text,PRIMARY KEY(task_id,revision));
   CREATE TABLE team_delivery_memory_withdrawals(team_id text,team_session_id text,submission_id uuid,decision_id uuid);
   CREATE TABLE team_artifact_revocations(submission_id uuid,artifact_id text,reason text,PRIMARY KEY(submission_id,artifact_id));`)
  const {beginFreshInputFixture,declareFreshInputFoundation}=await import(new URL('../../../memory/src/__tests__/shared-source-r1/input-start-fixture.ts',import.meta.url).href)
  const inputFoundation=await beginFreshInputFixture(pool)
  const {applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href)
  await applyMemorySchema(pool,{namespace:'memory'})
  await applySharedSourceContract(pool);await declareFreshInputFoundation(pool,inputFoundation);await applyRelayTeamSourceCapture(pool);await applyRelayTeamSourceCapture(pool)
 },30000)
 beforeEach(async()=>{
  await pool.query(`TRUNCATE collaboration_calls,collaboration_events,team_task_submissions,team_delivery_memory_sources,team_acceptance_decisions,team_task_specs,team_artifact_revocations;
   TRUNCATE shared.memory_source_work CASCADE;
   INSERT INTO collaboration_calls VALUES('call-z','goal','team-session','pending',NULL);
   INSERT INTO collaboration_events VALUES('goal',NULL,'private goal');`)
 })
 afterAll(async()=>{await pool?.end()})
 const work=async(kind='team_collaboration',root='call-z')=>(await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE source_kind=$1 AND root_key=$2',[kind,root])).rows[0]
 test('pending/uncertain content is not admitted; terminal-only completion and direct body updates are captured atomically',async()=>{
  expect(await work()).toBeUndefined()
  await pool.query("INSERT INTO collaboration_events VALUES('reply','call-z',repeat('private',100000))")
  expect(await work()).toBeUndefined()
  await pool.query("UPDATE collaboration_calls SET state='uncertain'");expect(await work()).toBeUndefined()
  const c=await pool.connect()
  try{await c.query('BEGIN');await c.query("UPDATE collaboration_calls SET state='completed'");expect(await work()).toBeUndefined();await c.query('ROLLBACK')}finally{c.release()}
  await pool.query("UPDATE collaboration_calls SET state='completed'");expect(await work()).toEqual({revision:'1'})
  await pool.query("UPDATE collaboration_events SET content=content WHERE event_id IN('goal','reply')");expect(await work()).toEqual({revision:'2'})
  await pool.query("UPDATE collaboration_calls SET state='cancelled'");expect(await work()).toEqual({revision:'3'})
  await pool.query("DELETE FROM collaboration_events WHERE event_id='reply'");expect(await work()).toEqual({revision:'4'})
  expect(JSON.stringify((await pool.query('SELECT * FROM shared.memory_source_work')).rows)).not.toContain('private')
 })
 test('one batch moving content between terminal calls invalidates both exact roots, then call deletion leaves a durable stub',async()=>{
  await pool.query("UPDATE collaboration_calls SET state='completed';INSERT INTO collaboration_calls VALUES('other','other-goal','other-team','failed',NULL);INSERT INTO collaboration_events VALUES('reply','call-z','private reply')")
  const before=await work()
  await pool.query("UPDATE collaboration_events SET call_id='other' WHERE event_id='reply'")
  expect(await work()).toEqual({revision:String(BigInt(before.revision)+1n)})
  expect(await work('team_collaboration','other')).toEqual({revision:'2'})
  await pool.query("DELETE FROM collaboration_calls WHERE call_id='other'")
  expect(await work('team_collaboration','other')).toEqual({revision:'3'})
 })
 const submission='10000000-0000-0000-0000-000000000111',decision='20000000-0000-0000-0000-000000000111'
 async function delivery(){
  await pool.query("INSERT INTO team_task_submissions VALUES($1,'call-z','task',1,'private submission')",[submission])
  await pool.query("INSERT INTO team_acceptance_decisions VALUES($1,'accepted')",[decision])
  await pool.query("INSERT INTO team_task_specs VALUES('task',1,'private goal','private acceptance')")
  await pool.query("INSERT INTO team_delivery_memory_sources VALUES('delivery-reader-1',$1,$2,NULL,NULL),('delivery-reader-2',$1,$2,NULL,NULL)",[submission,decision])
 }
 test('delivery uses independent roots; acceptance, spec, artifact revocation and withdrawal all survive body-free capture',async()=>{
  await delivery()
  expect(await work('team_delivery','delivery-reader-1')).toEqual({revision:'1'});expect(await work()).toBeUndefined()
  await pool.query("UPDATE team_task_submissions SET summary=summary WHERE submission_id=$1",[submission])
  await pool.query("UPDATE team_task_specs SET goal='changed'")
  await pool.query("UPDATE team_acceptance_decisions SET decision='rejected'")
  await pool.query("INSERT INTO team_artifact_revocations VALUES($1,'artifact','private reason')",[submission])
  await pool.query('UPDATE team_delivery_memory_sources SET revoked_at=now(),withdrawn_at=now()')
  expect(await work('team_delivery','delivery-reader-1')).toEqual({revision:'6'});expect(await work('team_delivery','delivery-reader-2')).toEqual({revision:'6'})
  await pool.query('DELETE FROM team_delivery_memory_sources')
  expect(await work('team_delivery','delivery-reader-1')).toEqual({revision:'7'})
  expect(JSON.stringify((await pool.query('SELECT * FROM shared.memory_source_work')).rows)).not.toContain('private')
 })
 test('capture-before-bootstrap covers late smaller call IDs and verifies enabled trigger identities',async()=>{
  await pool.query("UPDATE collaboration_calls SET state='completed'")
  const c=await pool.connect()
  try{
   await c.query('BEGIN');await c.query("INSERT INTO collaboration_calls VALUES('call-a','goal','team-session','failed',NULL)")
   const page=await bootstrapTeamSourceRoots(pool,{kind:'team_collaboration',after:'',limit:1})
   expect(page.roots.map(r=>r.rootKey)).toEqual(['call-z']);expect(page.nextAfter).toBe('call-z')
   await c.query('COMMIT');expect(await work('team_collaboration','call-a')).toEqual({revision:'1'})
  }finally{await c.query('ROLLBACK');c.release()}
  await delivery()
  expect((await bootstrapTeamSourceRoots(pool,{kind:'team_delivery',after:'',limit:1})).roots.map(r=>r.rootKey)).toEqual(['delivery-reader-1'])
  await pool.query('ALTER TABLE collaboration_events DISABLE TRIGGER memory_team_capture_events_update')
  try{await expect(bootstrapTeamSourceRoots(pool,{kind:'team_delivery',after:'',limit:1})).rejects.toThrow('team_source_capture_required_before_bootstrap')}
  finally{await pool.query('ALTER TABLE collaboration_events ENABLE TRIGGER memory_team_capture_events_update')}
 })
 test('the non-owner Relay writer can publish through capture without receiving shared state or function write capability',async()=>{
  await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_team_capture_runtime') THEN CREATE ROLE shared_team_capture_runtime LOGIN PASSWORD 'only-test';ELSE ALTER ROLE shared_team_capture_runtime LOGIN;END IF;END $$;
   GRANT USAGE ON SCHEMA public,shared TO shared_team_capture_runtime;
   GRANT SELECT,INSERT,UPDATE,DELETE ON public.collaboration_calls,public.collaboration_events TO shared_team_capture_runtime;
   REVOKE ALL ON ALL TABLES IN SCHEMA shared FROM shared_team_capture_runtime;
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA shared FROM shared_team_capture_runtime`)
  const raw=new URL(url!);raw.username='shared_team_capture_runtime';raw.password='only-test'
  const writer=new pg.Pool({connectionString:raw.href,max:1,options:'-c search_path=pg_catalog,public,shared'})
  try{
   await expect(writer.query('SELECT * FROM shared.memory_source_work')).rejects.toMatchObject({code:'42501'})
   await expect(writer.query("SELECT shared.mark_memory_source_dirty('team_collaboration','forged')")).rejects.toMatchObject({code:'42501'})
   await writer.query("UPDATE public.collaboration_calls SET state='completed' WHERE call_id='call-z'")
   expect(await work()).toEqual({revision:'1'})
   await writer.query("INSERT INTO public.collaboration_events VALUES('reply','call-z','private reply')")
   expect(await work()).toEqual({revision:'2'})
  }finally{await writer.end();await pool.query('ALTER ROLE shared_team_capture_runtime NOLOGIN')}
 })
 test('future subcontracts and missing capture tables are refused before replacing capture',async()=>{
  await pool.query('UPDATE shared.memory_source_contract SET team_capture_version=2')
  try{await expect(applyRelayTeamSourceCapture(pool)).rejects.toThrow('unsupported_shared_team_capture_contract')}
  finally{await pool.query('UPDATE shared.memory_source_contract SET team_capture_version=1')}
  const definition=(await pool.query("SELECT md5(pg_get_functiondef('shared.capture_memory_team_events()'::regprocedure)) AS hash")).rows[0].hash
  await pool.query('ALTER TABLE team_task_specs RENAME TO interrupted_specs')
  try{await expect(applyRelayTeamSourceCapture(pool)).rejects.toThrow('team_capture_schema_required')}
  finally{await pool.query('ALTER TABLE interrupted_specs RENAME TO team_task_specs')}
  expect((await pool.query("SELECT md5(pg_get_functiondef('shared.capture_memory_team_events()'::regprocedure)) AS hash")).rows[0].hash).toBe(definition)
  const {migrateRelay}=await import('../migrate-main.js'),prior=process.env.RELAY_MIGRATION_DATABASE_URL
  const before=(await pool.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].n
  process.env.RELAY_MIGRATION_DATABASE_URL=url;await pool.query('UPDATE shared.memory_source_contract SET team_capture_version=2')
  const stderr=vi.spyOn(console,'error').mockImplementation(()=>{}),ddl=vi.spyOn(await import('../db.js'),'initDB').mockResolvedValue(undefined)
  try{
   expect(await migrateRelay(['apply',new URL(url!).pathname.slice(1)])).toBe(2)
   expect(ddl).not.toHaveBeenCalled()
   expect((await pool.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].n).toBe(before)
  }finally{ddl.mockRestore();stderr.mockRestore();await pool.query('UPDATE shared.memory_source_contract SET team_capture_version=1');if(prior===undefined)delete process.env.RELAY_MIGRATION_DATABASE_URL;else process.env.RELAY_MIGRATION_DATABASE_URL=prior}

  const rows=(await pool.query("SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='shared' AND p.proname LIKE 'capture_memory_team_%'")).rows
  expect(rows.length).toBe(7)
  for(const r of rows)expect(r.definition).not.toMatch(/to_jsonb\s*\(|\.content\b|\.summary\b|\.goal\b|\.acceptance\b|\.reason\b|\.outcome\b/i)
 })
 test('future delivery privacy subcontract cannot be downgraded',async()=>{
  const before=(await pool.query("SELECT md5(pg_get_functiondef('shared.capture_memory_team_revocations()'::regprocedure)) hash")).rows[0].hash
  await pool.query('UPDATE shared.memory_source_contract SET delivery_privacy_capture_version=2')
  try{
   await expect(applyRelayTeamSourceCapture(pool)).rejects.toThrow('unsupported_delivery_privacy_capture_contract')
   expect((await pool.query("SELECT md5(pg_get_functiondef('shared.capture_memory_team_revocations()'::regprocedure)) hash")).rows[0].hash).toBe(before)
  }finally{await pool.query('UPDATE shared.memory_source_contract SET delivery_privacy_capture_version=1')}
 })

 test('a submission set fence excludes receipt INSERT/UPDATE/DELETE without global locks',async()=>{
  await delivery()
  const consumer=await pool.connect(),publisher=await pool.connect(),key='memory:delivery-submission-privacy:v1:'+submission
  try{
   await consumer.query('BEGIN')
   expect((await consumer.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[key])).rows[0].locked).toBe(true)
   for(const sql of [
    "INSERT INTO public.team_delivery_memory_sources VALUES('late-reader',$1,$2,NULL,NULL)",
    "UPDATE public.team_delivery_memory_sources SET revoked_at=clock_timestamp() WHERE source_session_id='delivery-reader-1' AND submission_id=$1 AND decision_id=$2",
    "DELETE FROM public.team_delivery_memory_sources WHERE source_session_id='delivery-reader-1' AND submission_id=$1 AND decision_id=$2",
   ]){
    await publisher.query('BEGIN');await publisher.query("SET LOCAL statement_timeout='200ms'")
    await expect(publisher.query(sql,[submission,decision])).rejects.toMatchObject({code:'55P03'})
    await publisher.query('ROLLBACK')
   }
   expect(await work('team_delivery','delivery-reader-1')).toEqual({revision:'1'})
   expect(await work('team_delivery','late-reader')).toBeUndefined()
   await consumer.query('COMMIT')
   await publisher.query('BEGIN')
   await publisher.query("INSERT INTO public.team_delivery_memory_sources VALUES('late-reader',$1,$2,NULL,NULL)",[submission,decision])
   await consumer.query('BEGIN')
   expect((await consumer.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[key])).rows[0].locked).toBe(false)
   const unrelated='memory:delivery-submission-privacy:v1:90000000-0000-0000-0000-000000000111'
   expect((await consumer.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[unrelated])).rows[0].locked).toBe(true)
   await publisher.query('COMMIT');await consumer.query('ROLLBACK')
   expect(await work('team_delivery','late-reader')).toEqual({revision:'1'})
   // A receipt creates its own root, without changing the original root. The
   // shared submission fence is the missing set boundary, not that old clock.
   expect(await work('team_delivery','delivery-reader-1')).toEqual({revision:'1'})
  }finally{await publisher.query('ROLLBACK');await consumer.query('ROLLBACK');publisher.release();consumer.release()}
 })

 test('receipt-set capability refuses missing/disabled/future contracts before bootstrap or DDL',async()=>{
  const {assertRelayDeliveryPrivacyCapture}=await import('../shared-source/delivery-privacy-capture.js')
  const {applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  try{
   await pool.query('ALTER TABLE public.team_delivery_memory_sources DISABLE TRIGGER memory_delivery_source_set_fence')
   await expect(assertRelayDeliveryPrivacyCapture(pool)).rejects.toThrow('relay_delivery_privacy_capture_required')
   await expect(bootstrapTeamSourceRoots(pool,{kind:'team_delivery',after:'',limit:1})).rejects.toThrow('team_source_capture_required_before_bootstrap')
   await pool.query('ALTER TABLE public.team_delivery_memory_sources ENABLE TRIGGER memory_delivery_source_set_fence;UPDATE shared.memory_source_contract SET delivery_source_set_capture_version=999')
   await expect(assertRelayDeliveryPrivacyCapture(pool)).rejects.toThrow('relay_delivery_source_set_capture_required')
   await expect(applyRelayTeamSourceCapture(pool)).rejects.toThrow('unsupported_delivery_source_set_capture_contract')
   await expect(applySharedSourceContract(pool)).rejects.toThrow('unsupported_delivery_source_set_capture_contract')
   expect((await pool.query('SELECT delivery_source_set_capture_version FROM shared.memory_source_contract')).rows[0].delivery_source_set_capture_version).toBe(999)
   await pool.query('UPDATE shared.memory_source_contract SET delivery_source_set_capture_version=0')
   await expect(assertRelayDeliveryPrivacyCapture(pool)).rejects.toThrow('relay_delivery_source_set_capture_required')
   await applyRelayTeamSourceCapture(pool);await assertRelayDeliveryPrivacyCapture(pool)
  }finally{await pool.query('ALTER TABLE public.team_delivery_memory_sources ENABLE TRIGGER memory_delivery_source_set_fence;UPDATE shared.memory_source_contract SET delivery_source_set_capture_version=1')}
 })

})
