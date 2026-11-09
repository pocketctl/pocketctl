import {SHARED_TEAM_SEMANTIC_FUNCTIONS} from '../../migrations/shared-db/team-semantic-contract.js'
import {assertNativeInputStartCompatible} from '../../migrations/shared-db/input-start-contract.js'
import pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {expect} from 'vitest'
import {createMemoryPool} from '../../db.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import type {SourceRoot,SourceScope} from '@pocketctl/session-source'
import type {Task8ConsumerConfig} from './task8-team-semantic-consumer-fixture.js'
/** Attach only to an already initialized exact assigned target. No schema
 * installation/reset, role creation, model or background application startup. */
export async function task8ConsumerFixFixture(config:Task8ConsumerConfig){
 const u=new URL(config.databaseUrl)
 if(!/^task8_team_semantic_consumer_retry[2-6]_test$/.test(u.pathname.slice(1))||u.hostname!=='127.0.0.1')throw Error('exact_task8_existing_fixture_required')
 const admin=new pg.Pool({connectionString:u.href,max:2,statement_timeout:5000,lock_timeout:1000})
 const runtime=createMemoryPool({databaseUrl:config.runtimeDatabaseUrls.memoryRole,databaseNamespace:'memory',dbPoolMax:6})
 const publisher=new pg.Pool({connectionString:config.runtimeDatabaseUrls.relayRole,max:4,statement_timeout:5000,lock_timeout:1000,options:'-c search_path=pg_catalog,public,shared'})
 try{
 expect((await admin.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
 expect((await runtime.query('SELECT current_user AS role')).rows[0].role).toBe(config.roles.memoryRole)
 expect((await publisher.query('SELECT current_user AS role')).rows[0].role).toBe(config.roles.relayRole)
 expect((await admin.query("SELECT max(version)::int AS version FROM memory.memory_schema_migrations")).rows[0].version).toBe(96)
 if(process.env.TASK8_APPLY_CONSUMER_REVIEW_FIX1==='1'){
  const c=await admin.connect()
  try{await c.query('BEGIN');await assertNativeInputStartCompatible(c as unknown as Pick<pg.Pool,'query'>);for(const sql of SHARED_TEAM_SEMANTIC_FUNCTIONS)await c.query(sql);await assertNativeInputStartCompatible(c as unknown as Pick<pg.Pool,'query'>);await c.query('COMMIT')}
  catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }
 const load=(path:string)=>import(new URL('../../../../relay/src/'+path+'.ts',import.meta.url).href)
 const {humanTeamFixture}=await load('__tests__/fixtures/team-v2'),{TeamSessionService}=await load('team/session-service'),{TeamDispatchRepository}=await load('team/dispatch-repository'),{TeamMemorySourceProjector}=await load('team/memory-source-projector')
 async function group(options:{gapBeforeTerminal?:boolean;delivery?:boolean}={}){
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
  const sources=new TeamMemorySourceProjector(true,{acceptedDeliveriesEnabledForTeam:()=>true}),sessions=new TeamSessionService(publisher,{},sources,undefined,()=>true)
  const daemon='task8-daemon-'+randomUUID(),offer='task8-offer-'+randomUUID(),nativeSession='task8-native-'+randomUUID()
  await publisher.query(`INSERT INTO public.daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'synthetic','online',$2,
   '[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1","team_task_delivery_v1"]')`,[daemon,f.users[0]])
  await publisher.query("INSERT INTO public.team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')",[offer,f.teamId,f.users[0],daemon])
  const active=await sessions.changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:offer,active:true,expectedRevision:f.session.revision,requestId:'task8-bind'})
  const task=await sessions.assignTask({sessionId:f.session.id,actorUserId:f.users[0],requestId:'task8-assign',instruction:'Preserve the original semantic core',acceptance:'One original group and exactly three roles',targetOfferIds:[offer],contextVersion:0,...(options.delivery?{reviewPolicy:{reviewer_user_id:f.users[1],primary_offer_id:offer,required_checks:['unit']}}:{})})
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

 async function sealAll(installation:string,roots:SourceRoot[]){
  const {createSharedSourceScheduler}=await import('../../sources/shared-scheduler.js'),errors:unknown[]=[]
  const scheduler=createSharedSourceScheduler({pool:runtime,workerId:'task8-fix-seal-'+randomUUID(),signal:new AbortController().signal,pageSize:128,onError:e=>errors.push(e)})
  try{for(let i=0;i<512;i++){
   await scheduler.runOnce();if(errors.length)throw errors[0]
   const pending=(await admin.query('SELECT count(*)::int AS n FROM shared.memory_source_control_work WHERE processed_revision<revision')).rows[0].n
   if(pending)continue
   let complete=true
   for(const root of roots){const seal=(await runtime.query('SELECT shared.current_memory_source_distribution($1,$2,$3) AS seal',[root.kind,root.key,installation])).rows[0].seal
    if(!seal||!(await admin.query('SELECT dispatch_complete FROM shared.memory_source_distributions WHERE source_kind=$1 AND root_key=$2',[root.kind,root.key])).rows[0]?.dispatch_complete){complete=false;break}}
   if(complete)return
  }throw Error('task8_fix_seals_not_ready')}finally{await scheduler.stop()}
 }
 async function personal(user:number,newAfterBirth=false){
  let id:string|undefined
  if(!newAfterBirth)id=(await publisher.query("SELECT installation_id::text FROM public.extension_installations WHERE owner_scope_kind='personal' AND owner_user_id=$1 ORDER BY installation_id LIMIT 1",[user])).rows[0]?.installation_id
  if(newAfterBirth)await publisher.query("UPDATE public.extension_installations SET status='revoked' WHERE owner_scope_kind='personal' AND owner_user_id=$1 AND provider_id='pocketctl-memory' AND status IN('active','pending','reauth_required')",[user])
  if(!id){id=randomUUID();await publisher.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,'personal',$1,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'from_now')",[id,user])}
  await runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1) ON CONFLICT DO NOTHING",[id])
  await admin.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',3) ON CONFLICT DO NOTHING",[id])
  return id
 }
 async function accepted(g:Awaited<ReturnType<typeof group>>){
  const {TeamDeliveryService}=await load('team/delivery-service'),sources=new TeamMemorySourceProjector(true,{acceptedDeliveriesEnabledForTeam:()=>true})
  const delivery=new TeamDeliveryService(publisher,{writesEnabledForTeam:()=>true,memorySources:sources}),bytes=Buffer.from('Task8 synthetic acceptance proof'),sha=createHash('sha256').update(bytes).digest('hex')
  const draft=await delivery.prepare(g.task.task_id,g.users[0],{request_id:'task8-prepare-'+randomUUID(),expected_revision:1,spec_revision:1,source_call_id:g.call,summary:'Task8 accepted semantic summary',code_revision:'task8-synthetic',publish_scope:'team',contribution_ids:[],artifacts:[{id:'proof',name:'proof.txt',mime_type:'text/plain',byte_size:bytes.length,sha256:sha,required:true}],evidence:[{check_id:'unit',artifact_id:'proof',result:'passed',code_revision:'task8-synthetic',source_kind:'agent_claim'}]})
  await delivery.uploadArtifact(g.task.task_id,g.users[0],draft.submission_id,'proof',bytes)
  await delivery.publish(g.task.task_id,g.users[0],draft.submission_id,{request_id:'task8-publish-'+randomUUID(),expected_revision:1})
  const decision=await delivery.decide(g.task.task_id,g.users[1],{request_id:'task8-accept-'+randomUUID(),expected_revision:2,submission_id:draft.submission_id,spec_revision:1,decision:'accepted',reason:'Synthetic fixture acceptance',verified_checks:['unit']})
  const receipts=(await publisher.query('SELECT source_session_id,reader_user_id FROM public.team_delivery_memory_sources WHERE decision_id=$1 ORDER BY reader_user_id',[decision.decision_id])).rows
  expect(receipts).toHaveLength(2)
  return {delivery,decision,submission:draft.submission_id,receipts,roots:receipts.map(r=>({kind:'team_delivery',key:r.source_session_id} as SourceRoot))}
 }
 async function nextCall(g:Awaited<ReturnType<typeof group>>){
  const task=await g.sessions.assignTask({sessionId:g.session.id,actorUserId:g.users[0],requestId:'task8-next-'+randomUUID(),instruction:'New eligible Task8 group',acceptance:'No starvation after exclusion',targetOfferIds:[g.offer],contextVersion:0})
  const call=(await publisher.query('SELECT call_id FROM public.collaboration_calls WHERE task_id=$1',[task.task_id])).rows[0].call_id as string
  const claim=await g.dispatch.claim(call);expect(claim).toBeTruthy()
  const nativeSession=claim.nativeSessionId??'task8-next-native-'+randomUUID()
  if(claim.authorization.operation==='create')expect(await g.dispatch.bindNativeSession(call,g.daemon,g.users[0],nativeSession)).toBe(true)
  expect(await g.dispatch.projectDaemonEvent(g.daemon,g.users[0],{session_id:nativeSession,seq:3,type:'agent_text',text:'New eligible semantic reply'})).toBeTruthy()
  expect(await g.dispatch.projectDaemonEvent(g.daemon,g.users[0],{session_id:nativeSession,seq:4,type:'turn_status',turn_status:'completed'})).toBeTruthy()
  return {call,root:{kind:'team_collaboration',key:call} as SourceRoot}
 }
 return {admin,runtime,publisher,group,scopes,execution,load,sourceJobs,runSourceJob,sealAll,personal,accepted,nextCall,async close(){await Promise.allSettled([admin.end(),runtime.end(),publisher.end()])}}
 }catch(e){await Promise.allSettled([admin.end(),runtime.end(),publisher.end()]);throw e}
}
