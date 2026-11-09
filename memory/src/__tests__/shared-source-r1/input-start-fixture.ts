import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {readFile,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import type {SourceScope} from '@pocketctl/session-source'
export async function inputStartFixture(url:string){
 const u=new URL(url)
 if(u.search||u.hash||u.pathname!=='/shared_input_start_memory_test'||u.username!=='shared_input_start_memory_test'||!['127.0.0.1','localhost','host.docker.internal'].includes(u.hostname))throw Error('dedicated_input_start_memory_fixture_required')
 const pool=new pg.Pool({connectionString:url,max:8,statement_timeout:10000,lock_timeout:1000})
 const identity=(await pool.query('SELECT current_database() AS database_name,current_user AS role_name,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0]
 if(identity.database_name!=='shared_input_start_memory_test'||identity.role_name!==u.username||identity.superuser!==false)throw Error('dedicated_nosuper_input_start_fixture_required')
 const adminUrl=process.env.INPUT_START_FIXTURE_ADMIN_DATABASE_URL
 if(!adminUrl)throw Error('input_start_explicit_fixture_admin_required')
 const au=new URL(adminUrl)
 if(au.search||au.hash||au.host!==u.host||au.pathname!==u.pathname||au.username!=='postgres')throw Error('dedicated_input_start_fixture_admin_required')
 const admin=new pg.Pool({connectionString:adminUrl,max:2})
 const adminIdentity=(await admin.query('SELECT current_database() AS database_name,current_user AS role_name')).rows[0]
 if(adminIdentity.database_name!=='shared_input_start_memory_test'||adminIdentity.role_name!=='postgres')throw Error('dedicated_input_start_fixture_admin_required')
 await admin.query(`DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_input_start_memory_reader') THEN CREATE ROLE shared_input_start_memory_reader LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_input_start_memory_relay') THEN CREATE ROLE shared_input_start_memory_relay LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_input_start_memory_definer') THEN CREATE ROLE shared_input_start_memory_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;END IF;
 END $$;`)
 // Fixture administration is separate from both least-privilege runtimes.
 // The executable contract requires a non-login owner, including dormant
 // semantic definitions already present in the current schema.
 await admin.query('GRANT shared_input_start_memory_definer TO shared_input_start_memory_test')
 await admin.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public AUTHORIZATION shared_input_start_memory_test')
 const hash=createHash('sha256')
 for(const name of ['db','schema-runtime','shared-source/input-start','shared-source/capture','extensions/installation-repository','extensions/journal','team/delivery-service','team/delivery-memory-projector','team/dispatch-repository','__tests__/fixtures/accepted-delivery-transaction']){
  const src=resolve('../relay/src/'+name+'.ts'),built=resolve('../relay/dist/'+name+'.js')
  const [ss,bs]=await Promise.all([stat(src),stat(built)])
  if(ss.mtimeMs>bs.mtimeMs)throw Error('input_start_relay_build_stale:'+name)
  hash.update(name).update(await readFile(src)).update(await readFile(built))
 }
 console.info('input_start_relay_source_and_build_sha256='+hash.digest('hex'))
 const load=(name:string)=>import(pathToFileURL(resolve('../relay/dist/'+name+'.js')).href)
 const relay=await load('db'),capture=await load('shared-source/capture'),native=await load('shared-source/input-start'),journal=await load('extensions/journal'),repository=await load('extensions/installation-repository')
 await relay.initDB(pool);await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool);await capture.applyRelaySourceCapture(pool)
 const teamCapture=await load('shared-source/team-capture');await teamCapture.applyRelayTeamSourceCapture(pool)
 await pool.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
 await provisionSharedDatabase(admin,{memoryRole:'shared_input_start_memory_reader',relayRole:'shared_input_start_memory_relay',migratorRole:'shared_input_start_memory_definer'})
 const ru=new URL(url);ru.username='shared_input_start_memory_reader';ru.password='synthetic-only'
 const runtime=createMemoryPool({databaseUrl:ru.href,databaseNamespace:'memory',dbPoolMax:5})
 const pu=new URL(url);pu.username='shared_input_start_memory_relay';pu.password='synthetic-only'
 const publisher=new pg.Pool({connectionString:pu.href,max:5,options:'-c search_path=pg_catalog,public,shared',statement_timeout:5000,lock_timeout:1000})
 async function source(){
  const key=randomUUID().slice(0,8),session='input-'+key,daemon='daemon-'+key
  const owner=(await publisher.query("INSERT INTO public.users(email,password_hash,team_enabled) VALUES($1,'x',true) RETURNING id",['input-'+key+'@test.invalid'])).rows[0].id as number
  await publisher.query("INSERT INTO public.daemons(daemon_id,user_id,hostname,status) VALUES($1,$2,'synthetic','online')",[daemon,owner])
  await publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[session,daemon,owner])
  return {owner,session,daemon}
 }
 async function install(s:{owner:number},policy:'from_now'|'retained_history'='from_now',db:Pick<pg.Pool,'query'|'connect'>=publisher){
  const inst=await new repository.ExtensionInstallationRepository(db).createInstallation({providerId:'pocketctl-memory',ownerUserId:s.owner,grantedScopes:['session:events:read','session:snapshot:read'],subscriptions:['session.event.v1'],enabledServices:['memory.manage'],eventFilter:{},startPolicy:policy})
  await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[inst.installation_id])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[inst.installation_id])
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst.installation_id])
  const scope:SourceScope={installationId:inst.installation_id,principalUserId:String(s.owner),ownerScopeKind:'personal',ownerScopeId:inst.installation_id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
  return {inst,scope}
 }
 async function event(s:{owner:number;session:string},options:{id?:string;status?:string;text?:string;payload?:Record<string,unknown>;db?:Pick<pg.Pool,'query'>;journal?:boolean}={}){
  const db=options.db??publisher,payload=options.payload??{text:options.text??'synthetic input',turn_id:'turn',actor_scope:'assistant',memory_source:{version:1,producer:'codex',session_id:s.session,turn_id:'turn',event_id:randomUUID(),sequence:'1',invocation_id:'input-start',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  const row=(await db.query(`INSERT INTO public.events(${options.id?'id,':''}session_id,event_type,payload,event_hash,effect_status,user_id)
   VALUES(${options.id?'$6::bigint,':''}$1,'agent_text',$2,$3,$4,$5) RETURNING id::text`,[s.session,payload,randomUUID().replaceAll('-',''),options.status??'completed',s.owner,...(options.id?[options.id]:[])])).rows[0]
  if(options.journal!==false)await journal.createPostgresExtensionJournalSink({sharedHeaders:true}).appendCanonicalEvent(db,{sourceEventId:row.id,ownerUserId:s.owner,sessionId:s.session,eventType:'agent_text',occurredAt:null,payload})
  return row.id as string
 }
 const root=(s:{owner:number;session:string})=>s.owner+':'+s.session
 const rows=async(scope:SourceScope,s:{owner:number;session:string},options:{ids?:string[];after?:string;limit?:number}={})=>(await runtime.query('SELECT value FROM shared.read_memory_relay_sources($1,$2,$3,$4,$5) value',[scope,root(s),options.after??null,options.limit??256,options.ids??null])).rows.map(r=>r.value)
 async function feed(s:{owner:number;session:string},id:string,feedId:string){await publisher.query("INSERT INTO public.extension_feed(feed_id,owner_user_id,topic,source_kind,source_id,session_id,payload) VALUES($1,$2,'session.event.v1','canonical_event',$3,$4,'{}')",[feedId,s.owner,'event:'+id,s.session])}
 const proof=async(id:string)=>(await pool.query("SELECT * FROM public.native_source_publications WHERE source_kind='relay_event' AND source_key=$1",[id])).rows[0]
 return {pool,admin,runtime,publisher,relay,native,repository,load,source,install,event,root,rows,feed,proof,close:async()=>{await runtime.end();await publisher.end();await pool.end();await admin.end()}}
}
export type InputStartFixture=Awaited<ReturnType<typeof inputStartFixture>>

const freshFoundations=new WeakMap<object,{pool:Pick<pg.Pool,'query'>;database:string}>()
const foundationDatabases=new Set(['shared_r1_reader_test','shared_r1_team_test','team_semantic_registration_test','shared_r1_input_test','relay_capture_test','relay_r1_control_test','relay_team_capture_test','relay_r1_feed_mode_test','shared_r1_namespace_test','shared_processing_pin_test'])
/** Mint only immediately after a fixture has removed its old shared namespace;
 * a mature shared-v1/native-loss state cannot obtain this test-only token. */
export async function beginFreshInputFixture(pool:Pick<pg.Pool,'query'>):Promise<object>{
 const row=(await pool.query(`SELECT current_database() AS database_name,current_user AS role_name,
  (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
  to_regnamespace('shared') IS NULL AS fresh_shared,
  to_regclass('public.native_input_start_contract') IS NULL AND to_regclass('public.native_source_publications') IS NULL
   AND to_regclass('public.native_installation_starts') IS NULL AND to_regclass('public.native_input_start_order') IS NULL
   AND to_regprocedure('public.capture_native_installation_start()') IS NULL AS fresh_native`)).rows[0]
 if(!row||!foundationDatabases.has(row.database_name)||!row.fresh_shared||!row.fresh_native
  ||!(row.role_name===row.database_name&&row.superuser===false||row.role_name==='postgres'&&row.superuser===true))throw Error('fresh_input_fixture_namespace_required')
 const token=Object.freeze({});freshFoundations.set(token,{pool,database:row.database_name});return token
}
export async function declareFreshInputFoundation(pool:Pick<pg.Pool,'query'>,token:object):Promise<void>{
 const original=freshFoundations.get(token)
 if(!original||original.pool!==pool)throw Error('fresh_input_fixture_token_required')
 const row=(await pool.query(`SELECT current_database() AS database_name,
  EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='shared' AND nspowner=current_user::regrole) AS owns_shared,
  to_regclass('public.native_input_start_contract') IS NULL AND to_regclass('public.native_source_publications') IS NULL
   AND to_regclass('public.native_installation_starts') IS NULL AND to_regclass('public.native_input_start_order') IS NULL
   AND to_regprocedure('public.capture_native_installation_start()') IS NULL AS fresh_native`)).rows[0]
 if(row.database_name!==original.database||!row.owns_shared||!row.fresh_native)throw Error('fresh_input_fixture_namespace_required')
 freshFoundations.delete(token)
 await pool.query('UPDATE shared.memory_source_contract SET input_start_version=0 WHERE singleton AND input_start_version=1')
}

/** Test-only native input installer for the three explicitly historical reader
 * fixtures. It neither creates a runtime fallback nor fabricates old starts. */
export async function installRetainedInputStartFixture(pool:Pick<pg.Pool,'query'>,policy:'retained_history',foundation?:object):Promise<void>{
 const db=(await pool.query('SELECT current_database() AS database_name')).rows[0].database_name
 if(policy!=='retained_history'||!['shared_r1_reader_test','shared_r1_team_test','team_semantic_registration_test','shared_r1_input_test','relay_r1_feed_mode_test','shared_r1_namespace_test','shared_processing_pin_test'].includes(db))throw Error('dedicated_retained_input_fixture_required')
 if(foundation)await declareFreshInputFoundation(pool,foundation)
 // Empty native table scaffolding only where an older independent fixture
 // did not need that source kind. Production capture/guard functions are real.
 await pool.query(`
  CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS public.extension_providers(provider_id text PRIMARY KEY,status text);
  CREATE TABLE IF NOT EXISTS public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id integer,owner_scope_kind text,owner_scope_id uuid,status text,start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS public.events(id bigint PRIMARY KEY,session_id text,user_id int,event_type text,payload jsonb,effect_status text,owner_retired boolean DEFAULT FALSE,logical_source_session_id text);
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS session_id text,ADD COLUMN IF NOT EXISTS user_id integer,ADD COLUMN IF NOT EXISTS event_type text,ADD COLUMN IF NOT EXISTS effect_status text,ADD COLUMN IF NOT EXISTS owner_retired boolean DEFAULT FALSE,ADD COLUMN IF NOT EXISTS logical_source_session_id text;
  CREATE TABLE IF NOT EXISTS public.daemons(daemon_id text PRIMARY KEY,user_id integer);
  CREATE TABLE IF NOT EXISTS public.sessions(session_id text PRIMARY KEY,daemon_id text,user_id integer,source text);
  CREATE TABLE IF NOT EXISTS public.collaboration_teams(team_id text PRIMARY KEY,state text);
  CREATE TABLE IF NOT EXISTS public.collaboration_sessions(team_session_id text PRIMARY KEY,team_id text);
  CREATE TABLE IF NOT EXISTS public.collaboration_calls(call_id text PRIMARY KEY,team_session_id text,event_id text,state text);
  CREATE TABLE IF NOT EXISTS public.collaboration_events(event_id text PRIMARY KEY,team_session_id text,event_seq bigint,call_id text,kind text,content text);
  CREATE TABLE IF NOT EXISTS public.team_memory_bindings(binding_id text PRIMARY KEY,revision bigint,installation_id uuid,owner_scope_kind text,owner_scope_id uuid);
  CREATE TABLE IF NOT EXISTS public.team_task_submissions(submission_id uuid PRIMARY KEY,state text);
  CREATE TABLE IF NOT EXISTS public.team_acceptance_decisions(decision_id uuid PRIMARY KEY,submission_id uuid,decision text);
  CREATE TABLE IF NOT EXISTS public.team_delivery_memory_sources(source_session_id text PRIMARY KEY,decision_id uuid,submission_id uuid,team_id text,team_session_id text,binding_id text,binding_revision bigint,reader_user_id int,participant_revision bigint,revoked_at timestamptz,withdrawn_at timestamptz);
  CREATE TABLE IF NOT EXISTS public.extension_feed(feed_id bigint PRIMARY KEY,owner_user_id int,topic text,source_kind text,source_id text,session_id text,envelope_version int DEFAULT 1,payload jsonb);
 `)
 const policies=(await pool.query("SELECT start_policy FROM public.extension_installations WHERE start_policy IS DISTINCT FROM 'retained_history' LIMIT 1")).rows
 if(policies.length)throw Error('explicit_retained_history_fixture_required')
 const src=resolve('../relay/src/shared-source/input-start.ts'),built=resolve('../relay/dist/shared-source/input-start.js')
 if((await stat(src)).mtimeMs>(await stat(built)).mtimeMs)throw Error('input_start_relay_build_stale')
 const {installNativeInputStart}=await import(pathToFileURL(built).href)
 await installNativeInputStart(pool)
 await applySharedSourceContract(pool as pg.Pool)
}

/** Real native installations for preexisting mode/CAS/fee fixtures whose
 * original subject was generation fencing, with explicit retained history. */
export async function installNativeModeFixture(pool:pg.Pool,installations:readonly string[]):Promise<void>{
 const db=(await pool.query('SELECT current_database() AS database_name')).rows[0].database_name
 if(!['shared_r1_input_test','shared_r1_work_test'].includes(db))throw Error('dedicated_native_mode_fixture_required')
 const built=resolve('../relay/dist/db.js')
 if((await stat(resolve('../relay/src/db.ts'))).mtimeMs>(await stat(built)).mtimeMs)throw Error('input_start_relay_build_stale')
 const {initDB}=await import(pathToFileURL(built).href);await initDB(pool)
 await pool.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
 for(const id of installations){
  const owner=(await pool.query("INSERT INTO public.users(email,password_hash) VALUES($1,'x') RETURNING id",[id+'@native-mode.test'])).rows[0].id
  await pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'retained_history')",[id,owner])
 }
}
