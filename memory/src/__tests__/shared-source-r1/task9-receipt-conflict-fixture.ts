import pg from 'pg'
import fs from 'node:fs'
import {randomUUID} from 'node:crypto'
import {createMemoryPool} from '../../db.js'
import {assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {governanceFixture} from '../../testing/governance-fixture.js'
import {createAutomationRepository} from '../../governance/automation-repository.js'
import {task9Identity,task9Evidence} from './task9-receipt-drain-fixture.js'
const dir=new URL('../../../../.superpowers/sdd/pocketctl-shared-w2-receipt-drain/',import.meta.url)
export async function task9ConflictFixture(){
 const config=JSON.parse(fs.readFileSync(new URL('task9-private-config.json',dir),'utf8'))
 const admin=new pg.Pool({connectionString:config.adminUrl,max:4,statement_timeout:5000,lock_timeout:1000,query_timeout:10000})
 await task9Identity(admin)
 // Existing owned DB only. No schema installer, reinitialization or DDL.
 const runtimeUrl=new URL(config.runtimeUrl)
 for(const [key,value]of Object.entries({statement_timeout:'5000',lock_timeout:'1000',query_timeout:'10000'}))runtimeUrl.searchParams.set(key,value)
 const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:4})
 await task9Identity(runtime,true);await assertSharedRuntimeContract(runtime)
 task9Evidence('task9-r3-runtime-identity',await task9Identity(runtime,true))
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
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'evaluate_review_shadow',$1::uuid::text,85,'running','task9-worker',1,clock_timestamp()+interval '5 minutes')",[jobId,f.team])
  return {fixture:f,organization,users:[owner,...users],repo,target:{installationId:f.team,candidateId:proposed.candidate.candidate_id,subjectKind:'promotion' as const},jobId,fence:{jobId,claimedBy:'task9-worker',claimEpoch:1}}
 }

 async function cleanup(s:Awaited<ReturnType<typeof review>>){
  const ids=[s.fixture.personal,s.fixture.team],c=await admin.connect()
  try{
   await c.query('BEGIN')
   const anchors=(await c.query('SELECT e.execution_id,a.reservation_id FROM shared.memory_source_executions e LEFT JOIN shared.memory_source_provider_attempts a USING(execution_id) WHERE e.job_id=$1',[s.jobId])).rows
   const executions=anchors.map(a=>a.execution_id),reservations=anchors.flatMap(a=>a.reservation_id?[a.reservation_id]:[])
   await c.query('DELETE FROM shared.memory_source_provider_attempts WHERE execution_id=ANY($1::uuid[])',[executions])
   await c.query('DELETE FROM shared.memory_source_executions WHERE execution_id=ANY($1::uuid[])',[executions])
   await c.query('DELETE FROM memory.memory_provider_budget_reservations WHERE reservation_id=ANY($1::uuid[])',[reservations])
   await c.query('DELETE FROM memory.memory_review_automation_runs WHERE installation_id=$1',[s.fixture.team])
   await c.query('DELETE FROM memory.memory_review_automation_policy_heads WHERE installation_id=$1',[s.fixture.team])
   await c.query('DELETE FROM memory.memory_installations WHERE installation_id=ANY($1::uuid[])',[ids])
   await c.query('DELETE FROM public.extension_installations WHERE installation_id=ANY($1::uuid[])',[ids])
   await c.query("DELETE FROM public.extension_scope_memberships WHERE scope_kind='team' AND scope_id=$1",[s.fixture.team])
   await c.query('DELETE FROM public.extension_teams WHERE team_id=$1',[s.fixture.team])
   await c.query('DELETE FROM public.extension_organizations WHERE organization_id=$1',[s.organization])
   await c.query('DELETE FROM public.users WHERE id=ANY($1::int[])',[s.users])
   await c.query('COMMIT')
   const remaining=(await admin.query(`SELECT (SELECT count(*)::int FROM memory.memory_installations WHERE installation_id=ANY($1::uuid[])) AS installations,(SELECT count(*)::int FROM memory.memory_usage_outbox WHERE installation_id=ANY($1::uuid[])) AS outbox,(SELECT count(*)::int FROM memory.memory_review_automation_runs WHERE installation_id=ANY($1::uuid[])) AS runs,(SELECT count(*)::int FROM shared.memory_source_executions WHERE job_id=$2) AS executions,(SELECT count(*)::int FROM memory.memory_provider_budget_reservations WHERE reservation_id=ANY($3::uuid[])) AS reservations`,[ids,s.jobId,reservations])).rows[0]
   task9Evidence('task9-r3-exact-cleanup',{ids,jobId:s.jobId,executions,reservations,remaining,note:'Native installer privacy/control facts may retain exact synthetic tombstones; no broad native cleanup.'})
   if(Object.values(remaining).some(v=>v!==0))throw Error('task9_r3_exact_cleanup_incomplete')
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }
 return {admin,runtime,review,cleanup,close:async()=>{await runtime.end();await admin.end()}}
}
/** Inject ACK loss only after the original physical COMMIT resolves. The real
 * pool/client and original writer execute every SQL statement unchanged. */
export async function task9LoseCommittedAck(pool:pg.Pool,work:()=>Promise<void>){
 const originalConnect=pool.connect.bind(pool),events:string[]=[]
 ;(pool as any).connect=async()=>{
  const client=await originalConnect(),query=client.query.bind(client),release=client.release.bind(client)
  ;(client as any).query=async(...args:any[])=>{
   const result=await (query as any)(...args)
   if(args[0]==='COMMIT'&&!events.includes('committed')){events.push('committed');throw Error('task9_synthetic_commit_ack_lost')}
   return result
  }
  client.release=(error?:Error|boolean)=>{client.query=query as any;release(error)}
  return client
 }
 try{await work();return {ok:true,events}}catch(e){return {ok:false,message:(e as Error).message,events}}finally{pool.connect=originalConnect as any}
}
