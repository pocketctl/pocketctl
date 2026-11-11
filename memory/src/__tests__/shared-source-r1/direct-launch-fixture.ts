import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
/** Fresh, explicitly named database only. Never connects to old private fixtures. */
export async function directLaunchFixture(url:string,options:{originalBinding?:boolean;necessaryOriginal?:boolean;personalClosure?:boolean}={}){
 const u=new URL(url),adminUrl=process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL,database=options.personalClosure?'shared_personal_closure_test':options.necessaryOriginal?'shared_necessary_original_test':options.originalBinding?'shared_original_binding_test':'shared_direct_launch_memory_test'
 if(!adminUrl||u.search||u.hash||u.pathname!=='/'+database||u.username!==database||!['127.0.0.1','localhost'].includes(u.hostname))throw Error('dedicated_direct_launch_fixture_required')
 const au=new URL(adminUrl)
 if(au.host!==u.host||au.pathname!==u.pathname||au.username!=='postgres'||au.search||au.hash)throw Error('dedicated_direct_launch_fixture_required')
 const pool=new pg.Pool({connectionString:adminUrl,max:4})
 const identity=(await pool.query("SELECT current_database() AS database_name,current_user AS role_name,to_regclass('public.users') IS NULL AS fresh")).rows[0]
 if(identity.database_name!==database||identity.role_name!=='postgres'||!identity.fresh)throw Error('fresh_direct_launch_fixture_required')
 const prefix=options.personalClosure?'personal_closure':options.necessaryOriginal?'necessary_original':options.originalBinding?'original_binding':'direct_launch',memoryRole=prefix+'_memory',relayRole=prefix+'_relay',migratorRole=prefix+'_definer'
 await pool.query(`CREATE ROLE ${memoryRole} LOGIN PASSWORD 'synthetic-only' NOSUPERUSER;CREATE ROLE ${relayRole} LOGIN PASSWORD 'synthetic-only' NOSUPERUSER;CREATE ROLE ${migratorRole} NOLOGIN NOSUPERUSER`)
 const load=(name:string)=>import(pathToFileURL(resolve('../relay/dist/'+name+'.js')).href)
 const relay=await load('db'),capture=await load('shared-source/capture'),team=await load('shared-source/team-capture'),repository=await load('extensions/installation-repository'),journal=await load('extensions/journal')
 await relay.initDB(pool);await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool);await capture.applyRelaySourceCapture(pool);await team.applyRelayTeamSourceCapture(pool)
 await pool.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
 await provisionSharedDatabase(pool,{memoryRole,relayRole,migratorRole})
 const ru=new URL(url);ru.username=memoryRole;ru.password='synthetic-only'
 const runtime=createMemoryPool({databaseUrl:ru.href,databaseNamespace:'memory',dbPoolMax:5})
 const pu=new URL(url);pu.username=relayRole;pu.password='synthetic-only'
 const publisher=new pg.Pool({connectionString:pu.href,max:4,options:'-c search_path=pg_catalog,public,shared'})
 async function source(){
  const key=randomUUID(),session='direct-'+key,daemon='direct-daemon-'+key
  const owner=(await publisher.query("INSERT INTO public.users(email,password_hash,team_enabled) VALUES($1,'x',true) RETURNING id",[key+'@test.invalid'])).rows[0].id as number
  await publisher.query("INSERT INTO public.daemons(daemon_id,user_id,hostname,status) VALUES($1,$2,'synthetic','online')",[daemon,owner])
  await publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[session,daemon,owner])
  return {owner,session,daemon}
 }
 async function install(s:{owner:number},policy:'from_now'|'retained_history'){
  const inst=await new repository.ExtensionInstallationRepository(publisher).createInstallation({providerId:'pocketctl-memory',ownerUserId:s.owner,grantedScopes:['session:events:read','session:snapshot:read'],subscriptions:['session.event.v1'],enabledServices:['memory.manage'],eventFilter:{},startPolicy:policy})
  await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[inst.installation_id])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[inst.installation_id])
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst.installation_id])
  return {inst}
 }
 async function event(s:{owner:number;session:string},terminal=false,options:{unknownPublication?:boolean}={}){
  const eventType=terminal?'turn_status':'agent_text'
  const turn='direct-turn-'+s.session
  const payload={...(terminal?{turn_status:'completed'}:{text:'bounded direct launch synthetic body'}),turn_id:turn,actor_scope:'assistant',memory_source:{version:1,producer:'codex',session_id:s.session,turn_id:turn,event_id:randomUUID(),sequence:terminal?'2':'1',invocation_id:'direct-launch',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}}
  // Owned negative fixture: an existing UNKNOWN sentinel must never acquire
  // an invented publication XID/order when a later real event is observed.
  const explicitId=options.unknownPublication?(await pool.query("SELECT nextval('public.events_id_seq')::text AS id")).rows[0].id:undefined
  if(explicitId)await pool.query("INSERT INTO public.native_source_publications(source_kind,source_key,owner_key,source_session_id) VALUES('relay_event',$1,$2,$3)",[explicitId,String(s.owner),s.session])
  const id=(await publisher.query(`INSERT INTO public.events(${explicitId?'id,':''}session_id,event_type,payload,event_hash,effect_status,user_id) VALUES(${explicitId?'$6::bigint,':''}$1,$5,$2,$3,'completed',$4) RETURNING id::text`,[s.session,payload,randomUUID().replaceAll('-',''),s.owner,eventType,...(explicitId?[explicitId]:[])])).rows[0].id
  await journal.createPostgresExtensionJournalSink({sharedHeaders:true}).appendCanonicalEvent(publisher,{sourceEventId:id,ownerUserId:s.owner,sessionId:s.session,eventType,occurredAt:null,payload})
  return id as string
 }
 return {pool,runtime,publisher,source,install,event,root:(s:{owner:number;session:string})=>s.owner+':'+s.session,close:async()=>{await runtime.end();await publisher.end();await pool.end()}}
}
export type DirectLaunchFixture=Awaited<ReturnType<typeof directLaunchFixture>>
