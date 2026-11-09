import pg from 'pg'
import {randomUUID} from 'node:crypto'

/** Task8 owns only a freshly allocated, explicit synthetic database. Never
 * reset a fixture: separate RED/GREEN databases preserve both observations. */
export async function task8NativeFixture(url:string){
 const u=new URL(url)
 if(!/^task8_team_semantic_native_(red|green|final|fix)_test$/.test(u.pathname.slice(1))||u.search||u.hash
  ||!['localhost','127.0.0.1','host.docker.internal'].includes(u.hostname))throw Error('task8_exact_native_fixture_required')
 const pool=new pg.Pool({connectionString:url,max:4,statement_timeout:5000,lock_timeout:1000})
 const identity=(await pool.query(`SELECT current_database() AS database_name,current_user AS role_name,
  NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','memory','shared') AND c.relkind IN('r','p')) AS fresh`)).rows[0]
 if(identity.database_name!==u.pathname.slice(1)||!identity.fresh)throw Error('task8_fresh_native_fixture_required')
 await pool.query(`CREATE TABLE public.users(id integer PRIMARY KEY,team_enabled boolean DEFAULT TRUE);
 CREATE TABLE public.extension_providers(provider_id text PRIMARY KEY,status text);
 CREATE TABLE public.extension_installations(installation_id uuid PRIMARY KEY,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,start_policy text DEFAULT 'from_now',start_feed_id bigint DEFAULT 0);
 CREATE TABLE public.events(id bigint PRIMARY KEY,session_id text,user_id int,event_type text,payload jsonb,effect_status text,owner_retired boolean DEFAULT FALSE,logical_source_session_id text);
 CREATE TABLE public.collaboration_teams(team_id text PRIMARY KEY,state text);
 CREATE TABLE public.collaboration_sessions(team_session_id text PRIMARY KEY,team_id text NOT NULL REFERENCES public.collaboration_teams,state text DEFAULT 'active');
 CREATE TABLE public.collaboration_calls(call_id text PRIMARY KEY,team_session_id text REFERENCES public.collaboration_sessions,event_id text,state text,task_id text,offer_id text,context_version bigint DEFAULT 0);
 CREATE TABLE public.collaboration_events(event_id text PRIMARY KEY,team_session_id text REFERENCES public.collaboration_sessions,event_seq bigint,call_id text,kind text,content text);
 CREATE TABLE public.team_memory_bindings(binding_id text PRIMARY KEY,team_id text REFERENCES public.collaboration_teams,revision bigint,installation_id uuid REFERENCES public.extension_installations,owner_scope_kind text,owner_scope_id uuid,state text);
 CREATE UNIQUE INDEX uq_team_memory_binding_active ON public.team_memory_bindings(team_id) WHERE state='active';
 CREATE TABLE public.team_task_specs(task_id text,revision bigint,reviewer_user_id int,PRIMARY KEY(task_id,revision));
 CREATE TABLE public.team_task_submissions(submission_id uuid PRIMARY KEY,task_id text,spec_revision bigint,source_call_id text REFERENCES public.collaboration_calls,source_offer_id text,context_version bigint,state text);
 CREATE TABLE public.team_acceptance_decisions(decision_id uuid PRIMARY KEY,submission_id uuid REFERENCES public.team_task_submissions,task_id text,spec_revision bigint,reviewer_user_id int,decision text);
 CREATE TABLE public.team_delivery_memory_sources(source_session_id text PRIMARY KEY,decision_id uuid REFERENCES public.team_acceptance_decisions,submission_id uuid REFERENCES public.team_task_submissions,team_id text,team_session_id text,binding_id text,binding_revision bigint,reader_user_id int,participant_revision bigint,revoked_at timestamptz,withdrawn_at timestamptz);
 INSERT INTO public.users VALUES(1,TRUE),(2,TRUE);
 INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
 INSERT INTO public.collaboration_teams VALUES('team','active');
 INSERT INTO public.collaboration_sessions(team_session_id,team_id) VALUES('session','team');`)
 // Deliberate pre-capability originals: no semantic header or original
 // semantic publication can be backfilled from these historical bodies.
 await pool.query(`INSERT INTO public.collaboration_events VALUES
  ('task8_pre_header_goal','session',1,NULL,'member_message','old nonempty goal'),
  ('task8_pre_header_reply','session',2,'task8_pre_header_call','agent_message','old nonempty reply'),
  ('task8_pre_header_outcome','session',3,'task8_pre_header_call','status','completed');
  INSERT INTO public.collaboration_calls VALUES('task8_pre_header_call','session','task8_pre_header_goal','dispatched','task','offer',0);`)
 const {installNativeInputStart}=await import(new URL('../../../../relay/src/shared-source/input-start.ts',import.meta.url).href)
 await installNativeInputStart(pool)
 const target=randomUUID(),owner=randomUUID()
 await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'team',$2,'active','from_now',0)",[target,owner])
 await pool.query("INSERT INTO public.team_memory_bindings VALUES('binding','team',1,$1,'team',$2,'active')",[target,owner])
 async function call(state='dispatched'){
  const id=randomUUID(),goal=randomUUID()
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',1,NULL,'member_message','native goal')",[goal])
  await pool.query("INSERT INTO public.collaboration_calls VALUES($1,'session',$2,$3,'task','offer',0)",[id,goal,state])
  await pool.query("INSERT INTO public.collaboration_events VALUES($1,'session',2,$3,'agent_message','native reply'),($2,'session',3,$3,'status','completed')",[randomUUID(),randomUUID(),id])
  return id
 }
 async function accepted(){
  const callId=await call(),submission=randomUUID(),decision=randomUUID()
  await pool.query("INSERT INTO public.team_task_specs VALUES('task',1,1) ON CONFLICT DO NOTHING")
  await pool.query("INSERT INTO public.team_task_submissions VALUES($1,'task',1,$2,'offer',0,'published')",[submission,callId])
  await pool.query("INSERT INTO public.team_acceptance_decisions VALUES($1,$2,'task',1,1,'accepted')",[decision,submission])
  return {callId,submission,decision}
 }
 async function semantic(kind:string,key:string){
  if(!(await pool.query("SELECT to_regclass('public.native_team_semantic_publications') IS NOT NULL AS present")).rows[0].present)return undefined
  return (await pool.query(`SELECT source_kind,original_business_key AS business_key,team_id,team_session_id,binding_id,binding_revision::text,target_installation_id::text,target_owner_scope_kind,target_owner_scope_id::text,publication_xid::text,publication_order::text,retired FROM public.native_team_semantic_publications WHERE source_kind=$1 AND business_key_hash=sha256(convert_to(jsonb_build_array($1::text,$2::text)::text,'UTF8'))`,[kind,key])).rows[0]
 }
 return {pool,target,owner,call,accepted,semantic}
}
