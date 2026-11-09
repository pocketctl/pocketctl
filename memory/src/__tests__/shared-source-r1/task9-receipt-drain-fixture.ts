import pg from 'pg'
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase,assertSharedRuntimeContract} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {governanceFixture} from '../../testing/governance-fixture.js'
import {createAutomationRepository} from '../../governance/automation-repository.js'
const root=new URL('../../../../',import.meta.url),dir=new URL('.superpowers/sdd/pocketctl-shared-w2-receipt-drain/',root)
const config=JSON.parse(fs.readFileSync(new URL('task9-private-config.json',dir),'utf8'))
export const task9Evidence=(name:string,value:unknown)=>fs.writeFileSync(new URL(name+'.json',dir),JSON.stringify(value,null,2),{mode:0o600})
export async function task9Identity(pool:pg.Pool,runtime=false){
 const c=JSON.parse(execFileSync('docker',['inspect',config.cid],{encoding:'utf8'}))[0]
 if(c.Id!==config.cid||c.Name!=='/'+config.name||c.Image!==config.image||c.Config.Labels['pocketctl.verification']!==config.label||JSON.stringify(c.HostConfig.PortBindings['5432/tcp'])!==JSON.stringify([{HostIp:'127.0.0.1',HostPort:'56619'}]))throw Error('task9_owned_container_required')
 const i=(await pool.query(`SELECT current_database() AS database_name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,current_user AS role_name,host(inet_server_addr()) AS server_addr,inet_server_port() AS server_port,current_setting('server_version_num') AS server_version_num,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`)).rows[0]
 if(i.database_name!=='task9_receipt_drain_red_test'||i.database_oid!==config.identity.database_oid||i.role_name!==(runtime?config.roles.memoryRole:'postgres')||i.server_addr!==config.identity.server_addr||i.server_port!==5432||i.server_version_num!==config.identity.server_version_num||runtime&&i.privileged)throw Error('task9_host_identity_mismatch')
 return i
}
export async function task9Fixture(){
 const admin=new pg.Pool({connectionString:config.adminUrl,max:4,statement_timeout:5000,lock_timeout:1000,query_timeout:10000})
 await task9Identity(admin)
 // Actual fresh native Relay bootstrap. No readiness markers or source facts are fabricated.
 const {initDB}=await import(new URL('../../../../relay/src/db.ts',import.meta.url).href)
 await initDB(admin)
 await applyMemorySchema(admin,{namespace:'memory'})
 await applySharedSourceContract(admin)
 await provisionSharedDatabase(admin,config.roles)
 const runtimeUrl=new URL(config.runtimeUrl)
 for(const [key,value]of Object.entries({statement_timeout:'5000',lock_timeout:'1000',query_timeout:'10000'}))runtimeUrl.searchParams.set(key,value)
 const runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:4})
 await task9Identity(runtime,true);await assertSharedRuntimeContract(runtime)
 const timeouts=(await runtime.query("SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0]
 if(timeouts.statement_timeout!=='5s'||timeouts.lock_timeout!=='1s')throw Error('task9_runtime_timeout_required')
 task9Evidence('task9-runtime-identity',{...await task9Identity(runtime,true),timeouts,physicalQueryTimeoutMs:10000})
 async function review(){
  const f=await governanceFixture(runtime),organization=randomUUID()
  await admin.query("INSERT INTO public.extension_providers(provider_id,manifest_version,manifest,status) VALUES('pocketctl-memory',1,'{}','enabled') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
  const owner=(await admin.query("INSERT INTO public.users(email,password_hash) VALUES($1,'synthetic-only') RETURNING id",[randomUUID()+'@task9.invalid'])).rows[0].id
  await admin.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'Task9 synthetic')",[organization])
  await admin.query("INSERT INTO public.extension_teams(team_id,organization_id,name) VALUES($1,$2,'Task9 synthetic')",[f.team,organization])
  for(const [id,kind]of[[f.personal,'personal'],[f.team,'team']])await admin.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,$3,$1,'active',ARRAY['session:events:read'],ARRAY['session.event.v1'],ARRAY['memory.manage'],'retained_history')",[id,kind==='personal'?owner:null,kind])
  for(const [id,roles]of[[f.proposer,['contributor']],[f.reviewer,['reviewer']],[f.publisher,['scope_administrator']]]as const){
   const user=(await admin.query("INSERT INTO public.users(email,password_hash) VALUES($1,'synthetic-only') RETURNING id",[randomUUID()+'@task9.invalid'])).rows[0].id
   await admin.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'team',$2,$3,$4)",[id,f.team,user,roles])
  }
  const proposed=await f.proposed(),repo=createAutomationRepository(runtime)
  await repo.setPolicy({installationId:f.team,grant:f.grant(f.publisher,['read','policy_admin']),expectedRevision:0,document:{mode:'shadow',model:'task9-synthetic',promptVersion:'review-v1'}})
  const jobId=randomUUID()
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'evaluate_review_shadow',$1::uuid::text,85,'running','task9-worker',1,clock_timestamp()+interval '5 minutes')",[jobId,f.team])
  return {repo,target:{installationId:f.team,candidateId:proposed.candidate.candidate_id,subjectKind:'promotion' as const},jobId,fence:{jobId,claimedBy:'task9-worker',claimEpoch:1}}
 }
 return {admin,runtime,review,close:async()=>{await runtime.end();await admin.end()}}
}
