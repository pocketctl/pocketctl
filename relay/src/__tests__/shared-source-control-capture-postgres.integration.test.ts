import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
const url=process.env.RELAY_CONTROL_CAPTURE_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('transactional body-free current control capture',()=>{
 let pool:pg.Pool
 const inst='10000000-0000-0000-0000-000000000093',scope='20000000-0000-0000-0000-000000000093'
 const installer=async()=> (await import('../shared-source/control-capture.js')).applyRelayControlCapture(pool)
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:4})
  await pool.query(`DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;
   CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text,private_secret text);
   CREATE TABLE public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,
    status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],subscriptions text[],event_filter jsonb,
    start_policy text,start_feed_id bigint,updated_at timestamptz,ack_at timestamptz,private_secret text);
   CREATE TABLE public.users(id int PRIMARY KEY,team_enabled boolean,updated_at timestamptz);
   CREATE TABLE public.daemons(daemon_id text PRIMARY KEY,user_id int,updated_at timestamptz);
   CREATE TABLE public.team_agent_offers(offer_id text PRIMARY KEY,daemon_id text,updated_at timestamptz);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint,updated_at timestamptz);
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint,updated_at timestamptz);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,state text,roles text[],membership_revision bigint,updated_at timestamptz);
   CREATE TABLE public.collaboration_teams(team_id text PRIMARY KEY,state text,updated_at timestamptz);
   CREATE TABLE public.collaboration_sessions(team_session_id text PRIMARY KEY,team_id text,state text,updated_at timestamptz);
   CREATE TABLE public.team_memory_bindings(binding_id text PRIMARY KEY,team_id text,installation_id uuid,owner_scope_kind text,owner_scope_id uuid,state text,revision bigint,updated_at timestamptz);
   CREATE TABLE public.collaboration_session_participants(team_session_id text,user_id int,state text,revision bigint,updated_at timestamptz,PRIMARY KEY(team_session_id,user_id));
   CREATE TABLE public.collaboration_team_memberships(team_id text,user_id int,state text,updated_at timestamptz,PRIMARY KEY(team_id,user_id));`)
  const {beginFreshInputFixture,declareFreshInputFoundation}=await import(new URL('../../../memory/src/__tests__/shared-source-r1/input-start-fixture.ts',import.meta.url).href)
  const inputFoundation=await beginFreshInputFixture(pool)
  const {applySharedSourceContract}=await import(new URL('../../../memory/src/migrations/shared-db/contract.ts',import.meta.url).href)
  const {applyMemorySchema}=await import(new URL('../../../memory/src/schema.ts',import.meta.url).href)
  await applyMemorySchema(pool,{namespace:'memory'})
  await applySharedSourceContract(pool);await declareFreshInputFoundation(pool,inputFoundation);await installer();await installer()
 },30000)
 beforeEach(async()=>{
  await pool.query(`TRUNCATE public.extension_providers,public.extension_installations,public.users,public.extension_teams,public.extension_organizations,
   public.extension_scope_memberships,public.collaboration_teams,public.collaboration_sessions,public.team_memory_bindings,
   public.collaboration_session_participants,public.collaboration_team_memberships,public.daemons,public.team_agent_offers;
   TRUNCATE shared.memory_source_modes;`)
  await pool.query("INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled','private-credential'),('external','enabled','private-other')")
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],ARRAY['session.event.v1'],'{}','retained_history',0,now(),now(),'private-credential')",[inst])
  await pool.query("INSERT INTO public.users VALUES(1,true,now());INSERT INTO public.collaboration_teams VALUES('team','active',now());INSERT INTO public.collaboration_sessions VALUES('session','team','active',now())")
  await pool.query("INSERT INTO public.daemons VALUES('daemon',1,now());INSERT INTO public.team_agent_offers VALUES('offer','daemon',now())")
  await pool.query("INSERT INTO public.extension_organizations VALUES($1,'active',1,now())",[scope])
  await pool.query("INSERT INTO public.extension_teams VALUES($1,$1,'active',1,now())",[scope])
  await pool.query("INSERT INTO public.extension_scope_memberships VALUES($1,'team',$1,1,'active',ARRAY['reader'],1,now())",[scope])
  await pool.query("INSERT INTO public.team_memory_bindings VALUES('binding','team',$1,'personal',$1,'active',1,now())",[inst])
  await pool.query("INSERT INTO public.collaboration_session_participants VALUES('session',1,'active',1,now());INSERT INTO public.collaboration_team_memberships VALUES('team',1,'active',now())")
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id) VALUES($1)",[inst])
  await pool.query('TRUNCATE shared.memory_source_control_progress,shared.memory_source_control_work;UPDATE shared.memory_source_control_clock SET revision=1')
 })
 afterAll(async()=>{await pool?.end()})
 const rows=async()=>(await pool.query('SELECT control_kind,control_key FROM shared.memory_source_control_work ORDER BY control_kind,control_key')).rows
 test('ACK/discovery timestamps, unchanged fields and other Providers create no invalidation',async()=>{
  await pool.query("UPDATE public.extension_installations SET updated_at=now(),ack_at=now(),private_secret='changed-private';UPDATE public.extension_providers SET status='disabled' WHERE provider_id='external';UPDATE public.users SET updated_at=now();UPDATE shared.memory_source_modes SET updated_at=now();UPDATE public.daemons SET updated_at=now();UPDATE public.team_agent_offers SET updated_at=now()")
  expect(await rows()).toEqual([])
  expect((await pool.query('SELECT shared.memory_source_control_snapshot() AS revision')).rows[0].revision).toBe('1')
 })
 test('semantic installation change and rollback are atomic, coalesced and free of credentials',async()=>{
  const c=await pool.connect()
  try{
   await c.query('BEGIN');await c.query("UPDATE public.extension_installations SET status='paused'")
   expect(await rows()).toEqual([]);await c.query('ROLLBACK')
   await pool.query("UPDATE public.extension_installations SET status='paused';UPDATE public.extension_installations SET config_version=config_version+1")
   expect(await rows()).toEqual([{control_kind:'installation',control_key:inst}])
   expect(JSON.stringify((await pool.query('SELECT * FROM shared.memory_source_control_work')).rows)).not.toMatch(/private|credential|granted_scopes|event_filter/)
   expect((await pool.query('SELECT 1 FROM shared.memory_source_work')).rowCount).toBe(0)
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('roles, participants, bindings, provider state and modes emit exact current control identities',async()=>{
  await pool.query("UPDATE public.extension_scope_memberships SET roles=ARRAY['reviewer'];UPDATE public.collaboration_session_participants SET state='removed';UPDATE public.team_memory_bindings SET state='revoked';UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory';UPDATE public.users SET team_enabled=false;UPDATE shared.memory_source_modes SET generation=generation+1")
  expect(await rows()).toEqual([
   {control_kind:'collaboration_session',control_key:'session'},
   {control_kind:'collaboration_team',control_key:'team'},
   {control_kind:'mode',control_key:inst},
   {control_kind:'provider',control_key:'pocketctl-memory'},
   {control_kind:'scope',control_key:'team:'+scope},
   {control_kind:'user',control_key:'1'},
  ])
 })
 test('default mode capture fixes its control version after native INSERT and revocation fences subsequent work',async()=>{
  // A never-admitted installation has no mode record; existing histories are
  // durable and cannot be deleted to recreate this initial state.
  const oldInst='10000000-0000-0000-0000-000000000093',inst='10000000-0000-0000-0000-000000000094'
  await pool.query('UPDATE public.extension_installations SET installation_id=$1,owner_scope_id=$1 WHERE installation_id=$2',[inst,oldInst])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  const job=(await pool.query("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES(gen_random_uuid(),$1,'extract_candidates','native-control',85,'running','worker',1,clock_timestamp()+interval '5 minutes') RETURNING job_id::text",[inst])).rows[0].job_id
  const execution=(await pool.query("SELECT shared.capture_memory_job_source($1,'worker',1,'legacy-active') AS execution",[job])).rows[0].execution
  expect(execution.controlRevision).toBe((await pool.query('SELECT shared.memory_source_control_snapshot() AS revision')).rows[0].revision)
  const reservation=(await pool.query("INSERT INTO memory.memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,reserved_input_tokens,reserved_output_tokens) VALUES(gen_random_uuid(),'native-control','text',100,100) RETURNING reservation_id::text")).rows[0].reservation_id
  expect((await pool.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS valid',[execution.executionId,reservation,'a'.repeat(64)])).rows[0].valid).toBe(true)
  await pool.query("UPDATE public.extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'")
  expect((await pool.query("SELECT shared.assert_memory_job_source($1,'provider') AS valid",[execution.executionId])).rows[0].valid).toBe(false)
  expect((await pool.query("SELECT shared.finish_memory_source_provider($1,$2,'accounted') AS valid",[execution.executionId,reservation])).rows[0].valid).toBe(true)
 })
 test('daemon owner and offer daemon changes remain visible across an ABA reversal',async()=>{
  await pool.query("UPDATE public.daemons SET user_id=2;UPDATE public.daemons SET user_id=1;UPDATE public.team_agent_offers SET daemon_id='other';UPDATE public.team_agent_offers SET daemon_id='daemon'")
  expect(await rows()).toEqual([{control_kind:'daemon',control_key:'daemon'},{control_kind:'offer',control_key:'offer'}])
  expect((await pool.query('SELECT shared.memory_source_control_snapshot() AS revision')).rows[0].revision).toBe('5')
 })
 test('disabled capture and unsupported future versions refuse readiness and migration',async()=>{
  const {assertRelayControlCapture}=await import('../shared-source/control-capture.js')
  await pool.query('ALTER TABLE public.extension_installations DISABLE TRIGGER memory_control_installations_update')
  await expect(assertRelayControlCapture(pool)).rejects.toThrow('relay_control_capture_required')
  await pool.query('ALTER TABLE public.extension_installations ENABLE TRIGGER memory_control_installations_update')
  await pool.query('UPDATE shared.memory_source_contract SET control_capture_version=999')
  try{await expect(installer()).rejects.toThrow('unsupported_shared_control_capture_contract')}
  finally{await pool.query('UPDATE shared.memory_source_contract SET control_capture_version=1')}
 })
})
