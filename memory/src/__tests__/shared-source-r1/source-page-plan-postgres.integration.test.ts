import {beginFreshInputFixture} from './input-start-fixture.js'
import {installNativeAliasFixture} from './native-alias-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import type {SourceScope} from '@pocketctl/session-source'
const url=process.env.SHARED_R1_READER_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000003'
const scope:SourceScope={installationId:inst,principalUserId:'1',ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
suite('controlled source page selection plan',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url || !/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const inputFoundation=await beginFreshInputFixture(pool)
  await applyMemorySchema(pool,{namespace:'memory'})
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY); INSERT INTO public.users VALUES(1),(2);
   CREATE TABLE public.daemons(daemon_id text,user_id int); INSERT INTO public.daemons VALUES('daemon',1);
   CREATE TABLE public.sessions(session_id text,user_id int,daemon_id text,source text,content_state text,agent_type text,activity_epoch bigint NOT NULL DEFAULT 0,last_business_activity_at timestamptz DEFAULT '2026-11-06T00:00:00Z'); INSERT INTO public.sessions VALUES('session',1,'daemon','codex','cold','codex');
   CREATE TABLE public.extension_providers(provider_id text,status text); INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb DEFAULT '{}',start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0,subscriptions text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
   CREATE TABLE public.extension_organizations(organization_id uuid PRIMARY KEY,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_teams(team_id uuid PRIMARY KEY,organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_scope_memberships(membership_id uuid PRIMARY KEY,scope_kind text,scope_id uuid,user_id int,roles text[],state text,membership_revision bigint DEFAULT 1);
   CREATE TABLE public.events(id bigint PRIMARY KEY,session_id text,user_id int,event_type text,payload jsonb,effect_status text,body_storage text,body_manifest_id uuid,body_chunk_ordinal int,body_activity_epoch bigint,body_owner_user_id int,canonical_payload_hash text,source_sequence bigint);
   CREATE TABLE public.extension_checkpoints(installation_id uuid PRIMARY KEY,ack_feed_id bigint NOT NULL DEFAULT 0,snapshot_required_at timestamptz,lease_epoch bigint NOT NULL DEFAULT 0,lease_token_hash bytea,lease_expires_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
   CREATE TABLE public.extension_source_outbox(source_seq bigint,source_kind text,source_id text,owner_user_id int,session_id text,event_type text);
   CREATE TABLE public.deleted_sessions(session_id text);
   CREATE TABLE public.session_archive_manifests(manifest_id uuid,user_id int,session_id text,activity_epoch bigint,schema_version int,codec text,state text,storage_namespace text);
   CREATE TABLE public.session_archive_chunks(manifest_id uuid,ordinal int,object_key text,first_event_id bigint,last_event_id bigint,event_count int,raw_bytes bigint,compressed_bytes bigint,raw_sha256 text,compressed_sha256 text);
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_reader_memory') THEN CREATE ROLE shared_reader_memory LOGIN PASSWORD 'only-test'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_reader_relay') THEN CREATE ROLE shared_reader_relay NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_reader_migrator') THEN CREATE ROLE shared_reader_migrator NOLOGIN; END IF;
   END $$;`)
  await applySharedSourceContract(pool)
  await pool.query(`INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,authorization_epoch,config_version,granted_scopes,enabled_services,event_filter) VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')`,[inst])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[inst])
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:session')")

  await pool.query("CREATE INDEX idx_events_session_id ON public.events(session_id,id)")
  await pool.query("INSERT INTO public.sessions VALUES('page-plan',1,'daemon','codex','hot','codex')")
  await pool.query(`INSERT INTO public.events(id,session_id,user_id,event_type,payload,effect_status,body_storage)
   SELECT 10000+n,'page-plan',1,'agent_text',jsonb_build_object('text','page fact '||n,'turn_id','page-turn-'||n),'completed','hot' FROM generate_series(1,512)n`)
  await installNativeAliasFixture(pool,{inputPolicy:'retained_history',inputFoundation})
  await pool.query("SELECT shared.mark_memory_source_dirty('relay_event','1:page-plan')")
  await provisionSharedDatabase(pool,{memoryRole:'shared_reader_memory',relayRole:'shared_reader_relay',migratorRole:'shared_reader_migrator'})
  const runtimeUrl=new URL(url);runtimeUrl.username='shared_reader_memory';runtimeUrl.password='only-test'
  runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:3})
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query('ANALYZE public.events;ANALYZE memory.source_events')
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 const nodes=(n:any):any[]=>[n,...(n.Plans??[]).flatMap(nodes)]
 test('generic pagination checks native authority for only the consumed ordered page',async()=>{
  const fn=(await pool.query("SELECT pg_get_functiondef('shared.read_memory_relay_sources(jsonb,text,bigint,integer,bigint[])'::regprocedure) AS definition")).rows[0].definition as string
  const start=fn.indexOf('RETURN QUERY WITH selected AS'),end=fn.indexOf('ORDER BY e.id;',start)
  expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start)
  let sql=fn.slice(start+'RETURN QUERY '.length,end+'ORDER BY e.id;'.length).replace(/;$/,'')
  for(const [k,v]of Object.entries({p_scope:'$1',p_root:'$2',p_after:'$3',p_limit:'$4',p_ids:'$5',native:'$6'}))sql=sql.replace(new RegExp('\\b'+k+'\\b','g'),v)
  const c=await pool.connect()
  try{
   await c.query('BEGIN');await c.query('SET LOCAL plan_cache_mode=force_generic_plan')
   await c.query(`PREPARE page_plan(jsonb,text,bigint,integer,bigint[],jsonb) AS ${sql}`)
   const native=(await c.query("SELECT public.native_session_authority('page-plan',1,NULL) AS value")).rows[0].value
   const literal=(x:unknown)=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb"
   const result=await c.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE page_plan(${literal(scope)},'1:page-plan',NULL,64,NULL,${literal(native)})`)
   const plan=result.rows[0]['QUERY PLAN'][0].Plan,all=nodes(plan)
   expect(plan['Actual Rows']).toBe(64)
   const guarded=all.filter(n=>typeof n.Filter==='string'&&n.Filter.includes('native_event_authority'))
   expect(guarded.length).toBeGreaterThan(0)
   const checked=guarded.reduce((n,p)=>n+((p['Actual Rows']??0)+(p['Rows Removed by Filter']??0))*(p['Actual Loops']??1),0)
   // The original bitmap/sort evaluates all512 native/input guards before LIMIT.
   expect(checked).toBeLessThanOrEqual(65)
   // Small fixtures may choose an ordered primary-key scan; the regression
   // is full-session authority evaluation, independent of index cost choice.
   await c.query('ROLLBACK')
  }finally{await c.query('ROLLBACK');c.release()}
 },20000)

 const read=async(after:string|null,limit:number,ids:string[]|null)=>(await runtime.query('SELECT value FROM shared.read_memory_relay_sources($1,$2,$3,$4,$5) AS value',[scope,'1:page-plan',after,limit,ids])).rows.map(r=>r.value)
 test('first, continuation and explicit-key pages keep exact ordered identities and body bytes',async()=>{
  const first=await read(null,64,null),second=await read('10064',64,null)
  expect(first.map(r=>r.id)).toEqual(Array.from({length:64},(_,i)=>String(10001+i)))
  expect(second.map(r=>r.id)).toEqual(Array.from({length:64},(_,i)=>String(10065+i)))
  for(const row of [...first,...second]){
   const n=Number(row.id)-10000
   expect(row.payload).toEqual({text:'page fact '+n,turn_id:'page-turn-'+n})
   expect(row.retention_denied).toBe(false);expect(row.header_ref_conflict).toBe(false)
  }
  expect((await read(null,2,['10128','10001','10066'])).map(r=>r.id)).toEqual(['10001','10066'])
  expect(await read('10512',64,null)).toEqual([])
  expect(await read(null,64,[])).toEqual([])
 })
 test('retention exclusions run before the page limit and explicit denied references remain visible',async()=>{
  await runtime.query(`INSERT INTO memory_source_retention_receipts(installation_id,session_id,turn_id,episode_id,source_digest,compiler_version,extraction_completed_at,state)
   SELECT $1,'page-plan','page-turn-'||n,NULL,decode(repeat('00',32),'hex'),'lifecycle-v1',now(),'reclaiming' FROM generate_series(1,70)n`,[inst])
  try{
   const page=await read(null,64,null)
   expect(page.map(r=>r.id)).toEqual(Array.from({length:64},(_,i)=>String(10071+i)))
   const exact=await read(null,64,['10001','10071'])
   expect(exact.map(r=>r.id)).toEqual(['10001','10071'])
   expect(exact[0].retention_denied).toBe(true);expect(exact[0].payload).toBeNull()
   expect(exact[1].retention_denied).toBe(false);expect(exact[1].payload.text).toBe('page fact 71')
  }finally{await runtime.query("DELETE FROM memory_source_retention_receipts WHERE installation_id=$1 AND session_id='page-plan'",[inst])}
 })
})
