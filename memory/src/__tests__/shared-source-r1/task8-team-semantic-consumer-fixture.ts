import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {expect} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import type {SourceRoot,SourceScope} from '@pocketctl/session-source'

export interface Task8ConsumerConfig {
 databaseUrl:string
 roles:{memoryRole:string;relayRole:string;migratorRole:string}
 runtimeDatabaseUrls:Record<string,string>
 expected:{database:string;databaseOid:string;role:string;serverAddress:string;serverPort:string}
}
/** Root-created exact fresh fixture only. No reset, role creation or flag
 * mutation; source imports initialize schema ports, never application loops. */
export async function task8ConsumerFixture(config:Task8ConsumerConfig){
 const u=new URL(config.databaseUrl),name=u.pathname.slice(1)
 if(!/^task8_team_semantic_consumer_(red|green|retry1|retry2|retry3|retry4|retry5|retry6)_test$/.test(name)||!['127.0.0.1','localhost'].includes(u.hostname)||u.search||u.hash)throw Error('exact_task8_consumer_fixture_required')
 const admin=new pg.Pool({connectionString:u.href,max:6,statement_timeout:5000,lock_timeout:1000}),opened:pg.Pool[]=[admin]
 try{
 expect((await admin.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
 const fresh=(await admin.query("SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','memory','shared') AND c.relkind IN('r','p')) AS fresh")).rows[0].fresh
 if(!fresh)throw Error('task8_fresh_consumer_fixture_required')
 for(const [key,role] of Object.entries(config.roles)){
  if(!/^task8_[a-z0-9_]+$/.test(role))throw Error('exact_task8_roles_required')
  const r=(await admin.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1',[role])).rows[0]
  expect(r).toEqual({rolcanlogin:key!=='migratorRole',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolinherit:false})
 }
 const load=(path:string)=>import(new URL('../../../../relay/src/'+path+'.ts',import.meta.url).href)
 const {initDB}=await load('db')
 await initDB(admin)
 await applyMemorySchema(admin,{namespace:'memory'});await applySharedSourceContract(admin)
 expect((await admin.query("SELECT max(version)::int AS version FROM memory.memory_schema_migrations")).rows[0].version).toBe(96)
 expect((await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND c.relkind IN('r','p')")).rows[0].n).toBe(191)
 const capture=await load('shared-source/capture'),teamCapture=await load('shared-source/team-capture'),control=await load('shared-source/control-capture')
 await capture.applyRelaySourceCapture(admin);await teamCapture.applyRelayTeamSourceCapture(admin);await control.applyRelayControlCapture(admin)
 await provisionSharedDatabase(admin,config.roles)
 const runtimeUrl=(roleKey:'memoryRole'|'relayRole')=>{
  const value=config.runtimeDatabaseUrls[roleKey]??config.runtimeDatabaseUrls[roleKey==='memoryRole'?'memory':'relay']
  if(!value)throw Error('task8_explicit_runtime_url_required')
  const r=new URL(value)
  if(r.host!==u.host||r.pathname!==u.pathname||r.username!==config.roles[roleKey])throw Error('task8_runtime_identity_mismatch')
  return r.href
 }
 const runtime=createMemoryPool({databaseUrl:runtimeUrl('memoryRole'),databaseNamespace:'memory',dbPoolMax:6})
 opened.push(runtime)
 const publisher=new pg.Pool({connectionString:runtimeUrl('relayRole'),max:6,statement_timeout:5000,lock_timeout:1000,options:'-c search_path=pg_catalog,public,shared'})
 opened.push(publisher)
 expect((await runtime.query('SELECT current_user AS role')).rows[0].role).toBe(config.roles.memoryRole)
 expect((await publisher.query('SELECT current_user AS role')).rows[0].role).toBe(config.roles.relayRole)
 await publisher.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
 await admin.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
 const {humanTeamFixture}=await load('__tests__/fixtures/team-v2'),{TeamSessionService}=await load('team/session-service'),{TeamDispatchRepository}=await load('team/dispatch-repository'),{TeamMemorySourceProjector}=await load('team/memory-source-projector')
 async function group(options:{gapBeforeTerminal?:boolean}={}){
  const f=await humanTeamFixture(publisher),organization=randomUUID(),scope=randomUUID(),installation=randomUUID(),binding='task8-binding-'+randomUUID()
  await publisher.query("INSERT INTO public.extension_organizations(organization_id,name,created_by_user_id) VALUES($1,$2,$3)",[organization,organization,f.users[0]])
  await publisher.query("INSERT INTO public.extension_teams(team_id,organization_id,name,created_by_user_id) VALUES($1,$2,$3,$4)",[scope,organization,scope,f.users[0]])
  for(const user of f.users.slice(0,2))await publisher.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'team',$2,$3,ARRAY['reader'])",[randomUUID(),scope,user])
  await publisher.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','team',$2,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'from_now')",[installation,scope])
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  for(const user of f.users.slice(0,2)){
   const personal=randomUUID()
   await publisher.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'personal',$1,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'from_now')",[personal,user])
  }
  await publisher.query("INSERT INTO public.team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,revision,created_by_user_id) VALUES($1,$2,'team',$3,$4,1,$5)",[binding,f.teamId,scope,installation,f.users[0]])
  await admin.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',3)",[installation])
  const sources=new TeamMemorySourceProjector(true),sessions=new TeamSessionService(publisher,{},sources)
  const daemon='task8-daemon-'+randomUUID(),offer='task8-offer-'+randomUUID(),nativeSession='task8-native-'+randomUUID()
  await publisher.query(`INSERT INTO public.daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'synthetic','online',$2,
   '[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]')`,[daemon,f.users[0]])
  await publisher.query("INSERT INTO public.team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[offer,f.teamId,f.users[0],daemon])
  const active=await sessions.changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:offer,active:true,expectedRevision:f.session.revision,requestId:'task8-bind'})
  const task=await sessions.assignTask({sessionId:f.session.id,actorUserId:f.users[0],requestId:'task8-assign',instruction:'Preserve the original semantic core',acceptance:'One original group and exactly three roles',targetOfferIds:[offer],contextVersion:0})
  const call=(await publisher.query('SELECT call_id FROM public.collaboration_calls WHERE task_id=$1',[task.task_id])).rows[0].call_id as string
  const dispatch=new TeamDispatchRepository(publisher,sources)
  expect(await dispatch.claim(call)).toBeTruthy();expect(await dispatch.bindNativeSession(call,daemon,f.users[0],nativeSession)).toBe(true)
  expect(await dispatch.projectDaemonEvent(daemon,f.users[0],{session_id:nativeSession,seq:1,type:'agent_text',text:'A stable semantic reply.'})).toBeTruthy()
  if(options.gapBeforeTerminal)await publisher.query('UPDATE public.collaboration_sessions SET latest_event_seq=latest_event_seq+10 WHERE team_session_id=$1',[f.session.id])
  expect(await dispatch.projectDaemonEvent(daemon,f.users[0],{session_id:nativeSession,seq:2,type:'turn_status',turn_status:'completed'})).toBeTruthy()
  return {...f,installation,scope,binding,call,task,active,sessions,dispatch,daemon,offer,nativeSession,root:{kind:'team_collaboration',key:call} as SourceRoot}
 }
 async function scopes(installation:string,root:SourceRoot){
  const result:{cursor:string;scope:SourceScope;state:string}[]=[];let after=''
  for(let page=0;page<8;page++){
   const rows=(await runtime.query('SELECT * FROM shared.enumerate_memory_source_targets($1,$2,$3,128)',[root.kind,root.key,after])).rows
   if(!rows.length)return result.filter(r=>r.scope.installationId===installation)
   for(const r of rows)result.push({cursor:r.cursor_key,scope:r.source_scope,state:r.state})
   after=rows.at(-1)!.cursor_key
  }
  throw Error('task8_complete_scope_limit')
 }
 async function execution<T>(installation:string,work:()=>Promise<T>){
  const job=randomUUID(),worker='task8-semantic-fixture'
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'project_shared_source',$3,52,'running',$4,1,clock_timestamp()+interval '5 minutes')",[job,installation,job,worker])
  return withSourceJobExecution(runtime,{jobId:job,claimedBy:worker,claimEpoch:1},work,{branch:'canonical'})
 }
 async function sourceJobs(installation:string,root:SourceRoot){
  const {createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js'),errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:runtime,workerId:'task8-source-'+randomUUID(),signal:new AbortController().signal,pageSize:128,onError:error=>errors.push(error)})
  try{
   for(let i=0;i<512;i++){
    await scheduler.runOnce()
    if(errors.length)throw errors[0]
    const controls=(await admin.query('SELECT count(*)::int AS n FROM shared.memory_source_control_work WHERE processed_revision<revision')).rows[0].n
    const current=(await runtime.query('SELECT shared.current_memory_source_distribution($1,$2,$3) AS current',[root.kind,root.key,installation])).rows[0].current
    const complete=(await admin.query('SELECT dispatch_complete FROM shared.memory_source_distributions WHERE source_kind=$1 AND root_key=$2',[root.kind,root.key])).rows[0]?.dispatch_complete
    if(controls===0&&current&&complete){
     const jobs=(await runtime.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source' AND payload->'root'->>'kind'=$2 AND payload->'root'->>'key'=$3 AND payload->>'distribution_scan'=$4 ORDER BY payload->>'target_cursor'",[installation,root.kind,root.key,current.scanId])).rows
     if(jobs.length)return jobs
    }
   }
   throw Error('task8_source_distribution_not_ready')
  }finally{await scheduler.stop()}
 }
 async function runSourceJob(job:any){
  const worker='task8-project-'+randomUUID(),current=(await runtime.query("UPDATE memory_jobs SET state='running',claimed_by=$2,claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE job_id=$1 RETURNING *",[job.job_id,worker])).rows[0]
  const {createCanonicalProjectionHandler}=await import('../../sources/canonical-projection-worker.js')
  await withSourceJobExecution(runtime,{jobId:current.job_id,claimedBy:worker,claimEpoch:current.claim_epoch},()=>createCanonicalProjectionHandler(runtime,{pageSize:64,deferMs:0,stabilizationMs:0})(current,new AbortController().signal),{branch:'canonical'})
 }
 return {admin,runtime,publisher,group,scopes,execution,load,sourceJobs,runSourceJob,roles:config.roles,async close(){await Promise.allSettled(opened.map(pool=>pool.end()))}}
 }catch(error){await Promise.allSettled(opened.map(pool=>pool.end()));throw error}
}
