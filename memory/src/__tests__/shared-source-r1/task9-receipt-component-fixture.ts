import pg from 'pg'
import fs from 'node:fs'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createMemoryPool} from '../../db.js'
import {assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {governanceFixture} from '../../testing/governance-fixture.js'
import {createAutomationRepository} from '../../governance/automation-repository.js'
const dir=new URL(process.env.TASK9_COMPONENT_EVIDENCE_DIRECTORY??'../../../../.superpowers/sdd/pocketctl-shared-w2-receipt-drain/',import.meta.url)
export const componentEvidence=(name:string,value:unknown)=>fs.writeFileSync(new URL('task9-component-'+name+'.json',dir),JSON.stringify(value,null,2),{mode:0o600})
export async function task9ComponentFixture(){
 const config=JSON.parse(fs.readFileSync(new URL('task9-component-private.json',dir),'utf8'))
 const inspect=JSON.parse(execFileSync('docker',['inspect',config.cid],{encoding:'utf8'}))[0]
 if(inspect.Id!==config.cid||inspect.Image!==config.image||inspect.Config.Labels['pocketctl.verification']!==config.label||JSON.stringify(inspect.HostConfig.PortBindings['5432/tcp'])!==JSON.stringify([{HostIp:'127.0.0.1',HostPort:'56619'}]))throw Error('task9_component_container_mismatch')
 const admin=new pg.Pool({connectionString:config.adminUrl,max:4,statement_timeout:5000,lock_timeout:1000,query_timeout:10000})
 const identity=(await admin.query("SELECT current_database() AS database_name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,current_user AS role_name,host(inet_server_addr()) AS server_addr,inet_server_port() AS server_port")).rows[0]
 if(identity.database_name!=='task9_receipt_drain_green5_test'||identity.database_oid!==config.identity.database_oid||identity.role_name!=='postgres'||identity.server_addr!==config.identity.server_addr||identity.server_port!==5432)throw Error('task9_component_host_mismatch')
 const runtimeUrl=new URL(config.runtimeUrl)
 for(const [key,value]of Object.entries({statement_timeout:'5000',lock_timeout:'1000',query_timeout:'10000'}))runtimeUrl.searchParams.set(key,value)
 const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:4})
 await assertSharedRuntimeContract(runtime)
 const runtimeIdentity=(await runtime.query("SELECT current_database() AS database_name,current_user AS role_name,host(inet_server_addr()) AS server_addr,inet_server_port() AS server_port,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0]
 if(runtimeIdentity.role_name!==config.roles.memoryRole||runtimeIdentity.server_addr!==identity.server_addr||runtimeIdentity.server_port!==5432)throw Error('task9_component_runtime_login_required')
 componentEvidence('runtime-identity',{...runtimeIdentity,databaseOid:identity.database_oid,reporterStarted:false})
 async function review(){
  const f=await governanceFixture(runtime),organization=randomUUID(),users:number[]=[]
  await admin.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
  const owner=(await admin.query("INSERT INTO public.users(email,password_hash) VALUES($1,'synthetic-only') RETURNING id",[randomUUID()+'@task9.invalid'])).rows[0].id
  await admin.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'Task9 synthetic')",[organization])
  await admin.query("INSERT INTO public.extension_teams(team_id,organization_id,name) VALUES($1,$2,'Task9 synthetic')",[f.team,organization])
  for(const [id,kind]of[[f.personal,'personal'],[f.team,'team']])await admin.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,$3,$1,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'retained_history')",[id,kind==='personal'?owner:null,kind])
  for(const [id,roles]of[[f.proposer,['contributor']],[f.reviewer,['reviewer']],[f.publisher,['scope_administrator']]]as const){
   const user=(await admin.query("INSERT INTO public.users(email,password_hash) VALUES($1,'synthetic-only') RETURNING id",[randomUUID()+'@task9.invalid'])).rows[0].id
   await admin.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'team',$2,$3,$4)",[id,f.team,user,roles]);users.push(user)
  }
  const proposed=await f.proposed(),repo=createAutomationRepository(runtime)
  await repo.setPolicy({installationId:f.team,grant:f.grant(f.publisher,['read','policy_admin']),expectedRevision:0,document:{mode:'shadow',model:'task9-synthetic',promptVersion:'review-v1'}})
  const jobId=randomUUID()
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at,payload) VALUES($1,$2,'evaluate_review_shadow',$1::uuid::text,85,'running','task9-worker',1,clock_timestamp()+interval '5 minutes',$3::jsonb)",[jobId,f.team,JSON.stringify({subject_kind:'promotion',candidate_id:proposed.candidate.candidate_id})])
  return {fixture:f,organization,users:[owner,...users],repo,target:{installationId:f.team,candidateId:proposed.candidate.candidate_id,subjectKind:'promotion' as const},jobId,fence:{jobId,claimedBy:'task9-worker',claimEpoch:1}}
 }

 return {admin,runtime,review,roles:config.roles,close:async()=>{await runtime.end();await admin.end()}}
}
/** Physical runtime fault injection executes a genuine SQL error, with no
 * fixture trigger/function/schema mutation. COMMIT ACK loss occurs only after
 * real COMMIT resolves, independently verified by an administrator read. */
export function componentFaults(pool:pg.Pool,hooks?:{afterAdmissionSql?:()=>Promise<void>}){
 const original=pool.connect.bind(pool),faults={central:false,sink:false,budget:false,loseSinkAck:false,events:[]as string[]}
 const instrument=(c:pg.PoolClient)=>{
  const query=c.query.bind(c),release=c.release.bind(c);let independent=false
  const execute=async(args:any[])=>{
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
   if((faults.central&&sql.includes('memory.receive_provider_receipt_v1'))||(faults.sink&&(sql.includes('memory.commit_provider_sink_')))||(faults.budget&&sql.includes('UPDATE memory_provider_budget_reservations'))){faults.events.push('sql_fault:'+sql.split('(')[0].trim());return query('SELECT 1/0')}
   if(sql.includes('memory.commit_provider_sink_'))independent=true
   const result=await(query as any)(...args)
   if(sql.includes('memory.admit_provider_receipt_v1'))await hooks?.afterAdmissionSql?.()
   if(sql==='COMMIT'&&independent&&faults.loseSinkAck){faults.loseSinkAck=false;faults.events.push('real_sink_commit_ack_lost');throw Error('component_sink_commit_ack_lost')}
   return result
  }
  ;(c as any).query=(...args:any[])=>{const callback=typeof args.at(-1)==='function'?args.pop():undefined;const pending=execute(args);if(callback){void pending.then(r=>callback(null,r),e=>callback(e));return}return pending}
  c.release=(error?:Error|boolean)=>{c.query=query as any;release(error)}
  return c
 }
 ;(pool as any).connect=(callback?:any)=>{const pending=original().then(instrument);if(callback){void pending.then(c=>callback(null,c,c.release),e=>callback(e));return}return pending}
 return {...faults,get central(){return faults.central},set central(v:boolean){faults.central=v},get sink(){return faults.sink},set sink(v:boolean){faults.sink=v},get budget(){return faults.budget},set budget(v:boolean){faults.budget=v},get loseSinkAck(){return faults.loseSinkAck},set loseSinkAck(v:boolean){faults.loseSinkAck=v},restore(){pool.connect=original as any}}
}
