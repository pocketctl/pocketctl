import {randomUUID,createHash} from 'node:crypto'
import Fastify from 'fastify'
import pg from 'pg'
import {z} from 'zod'
import type {McpServer} from '@modelcontextprotocol/server'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {registerReadRoutes} from '../api/read-routes.js'
import {registerMemoryTools} from '../mcp/tools.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import type {RouteV2Grant} from '../governance/authorization.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('federated query context mapping (dedicated PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(scopeKind='snapshot'){
  const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()],repos:string[]=[],snapshots:string[]=[],claims:string[]=[]
  const grant:RouteV2Grant={version:'v2',installationId:ids[0],primaryInstallationId:ids[0],services:['memory.search','memory.recall'],configVersion:'1',callerType:'web',scopeBindings:[]}
  for(const [i,installation] of ids.entries()){
   const kind=i===1?'team':i===2?'organization':'personal',repository=randomUUID(),snapshot=randomUUID(),claim=randomUUID(),version=randomUUID(),episode=randomUUID()
   repos.push(repository);snapshots.push(snapshot);claims.push(claim)
   await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
   await pool.query('INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,$2,$1)',[installation,kind])
   const member=kind==='personal'?null:randomUUID()
   if(member)await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['reader'])",[installation,member])
   if(i<3)grant.scopeBindings.push({installation_id:installation,owner_scope_kind:kind,owner_scope_id:installation,membership_id:member,membership_revision:member?'1':'0',authorization_epoch:'1',permissions:['read']})
   await pool.query('INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,$3,$4,NOW(),NOW())',[installation,repository,'/same-cwd',i===1?'git@github.com:Acme/Repo.git':'https://github.com/Acme/Repo.git'])
   await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[installation,repository,snapshot,'a'.repeat(40)])
   const scoped=['repository','snapshot','branch'].includes(scopeKind),scopeKey=scopeKind==='snapshot'?snapshot:scopeKind==='repository'?repository:scopeKind==='branch'?'main':scopeKind==='task'?'task-a':''
   const app={scopeKind,scopeKey,canonicalRepositoryKey:scoped?'github.com/Acme/Repo':null,repositoryId:scoped?repository:null,snapshotId:scoped?snapshot:null,branch:scoped?'main':null,status:'verified'}
   await pool.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,canonical_repository_key) VALUES($1,$2,'test_invariant',$3,$4,$5,'active',$6)",[claim,installation,scopeKind,scopeKey,'mapped-'+claim,app.canonicalRepositoryKey])
   await pool.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,repo_snapshot_id,branch,applicability) VALUES($1,$2,$3,1,'Mapped invariant',$4,1,$5,$6,$7,$8)",[version,installation,claim,kind==='personal'?'user_accepted':kind+'_published',app.repositoryId,app.snapshotId,app.branch,app])
   await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
   await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'mapping-fixture',$2::uuid::text,'ready','fixture')",[installation,episode])
   await pool.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,visibility) VALUES($1,$2,$3,$4,1,'episode','Mapped invariant evidence',$5,NOW(),$6)",[randomUUID(),installation,version,episode,createHash('sha256').update('Mapped invariant evidence').digest(),kind==='personal'?'personal':'shared'])
  }
  return{ids,repos,snapshots,claims,grant,request:{query:'invariant',repository_id:repos[0],repo_snapshot_id:snapshots[0],branch:'main',scope_installation_ids:ids.slice(0,3)}}
 }
 async function invoke(f:Awaited<ReturnType<typeof fixture>>,surface:'REST'|'MCP',method:'search'|'recall',body:Record<string,unknown>,beforeTeamCandidates?:()=>Promise<void>){
  const queryPool=beforeTeamCandidates?{query:async(sql:string,params:unknown[])=>{
   const mutate=beforeTeamCandidates
   if(mutate&&sql.includes('CROSS JOIN knowledge_claims')&&params[0]===f.ids[1]){beforeTeamCandidates=undefined;await mutate()}
   return pool.query(sql,params)
  }} as unknown as pg.Pool:pool
  if(surface==='REST'){
   const app=Fastify()
   registerReadRoutes(app,{pool:queryPool,guard:{guard:async()=>f.grant,guardV2:async()=>f.grant} as never,policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),sharedScopesEnabled:true,recallEmbeddingTimeoutMs:50,cursorSigningKey:'federated-mapping-key'})
   try{const response=await app.inject({method:'POST',url:'/api/v1/memory/'+method,payload:body});return{status:response.statusCode,data:response.json()}}finally{await app.close()}
  }
  const handlers=new Map<string,{schema:Record<string,z.ZodType>;handle:(args:unknown)=>Promise<{content:{text:string}[]}>}>()
  registerMemoryTools({registerTool(name:string,definition:{inputSchema:Record<string,z.ZodType>},handle:(args:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,{schema:definition.inputSchema,handle})}} as unknown as McpServer,{pool:queryPool,grant:()=>f.grant,sharedScopesEnabled:true,recallEmbeddingTimeoutMs:50,cursorSigningKey:'federated-mapping-key'})
  const tool=handlers.get('memory_'+method)!,args=z.strictObject(tool.schema).parse(body)
  return{status:200,data:JSON.parse((await tool.handle(args)).content[0].text)}
 }
 for(const surface of ['REST','MCP'] as const)for(const method of ['search','recall'] as const){
  test.each(['repository','snapshot','branch'])(`${surface} ${method} maps %s context to target-local IDs without foreign scope leakage`,async scopeKind=>{
   const f=await fixture(scopeKind),result=await invoke(f,surface,method,f.request)
   expect(result.status).toBe(200)
   expect(result.data[method==='search'?'hits':'claims'].map((h:{claimId:string})=>h.claimId).sort()).toEqual(f.claims.slice(0,3).sort())
  })
 }
 test.each(['missing','ambiguous','wrong_commit'])('%s mapping blocks the target scope without clearing repository filters',async mode=>{
  const f=await fixture()
  if(mode==='missing')await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Other/Repo.git' WHERE repository_id=$1",[f.repos[1]])
  if(mode==='wrong_commit')await pool.query('UPDATE repo_snapshots SET commit_sha=$2 WHERE repo_snapshot_id=$1',[f.snapshots[1],'b'.repeat(40)])
  if(mode==='ambiguous')await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,'another-cwd','https://github.com/Acme/Repo.git',NOW(),NOW())",[f.ids[1],randomUUID()])
  const result=await invoke(f,'REST','search',f.request)
  expect(result.data.hits.map((h:{claimId:string})=>h.claimId).sort()).toEqual([f.claims[0],f.claims[2]].sort())
  expect(result.data.degradedComponents).toContain('scope_context_unavailable')
 })
 test('outer cursor is invalidated when the canonical target mapping changes',async()=>{
  const f=await fixture('repository'),one=await invoke(f,'REST','search',{...f.request,limit:1})
  expect(one.data.nextCursor).toBeTruthy()
  await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Other/Repo.git' WHERE repository_id=$1",[f.repos[1]])
  const two=await invoke(f,'REST','search',{...f.request,limit:1,cursor:one.data.nextCursor})
  expect(two.status).toBe(400)
 })
 test('task keys are installation-local and cannot match an unrelated shared task with the same label',async()=>{
  const f=await fixture('task'),result=await invoke(f,'REST','recall',{query:'invariant',task_scope_key:'task-a',scope_installation_ids:f.ids.slice(0,3)})
  expect(result.data.claims.map((h:{claimId:string})=>h.claimId)).toEqual([f.claims[0]])
  expect(result.data.coverageGaps).toContain('task_mapping_required')
 })
 test('a snapshot-only query derives its owned repository before mapping shared contexts',async()=>{
  const f=await fixture(),{repository_id:unused,...body}=f.request,result=await invoke(f,'REST','search',body)
  expect(result.data.hits.map((h:{claimId:string})=>h.claimId).sort()).toEqual(f.claims.slice(0,3).sort())
 })
 test('an unauthorized foreign repository cannot serve as query context',async()=>{
  const f=await fixture(),result=await invoke(f,'REST','search',{...f.request,repository_id:f.repos[3],repo_snapshot_id:f.snapshots[3],scope_installation_ids:[f.ids[1]]})
  expect(result.data.hits).toEqual([])
  expect(result.data.degradedComponents).toContain('scope_context_unavailable')
 })
 test('an explicitly selected Team can own the source context used to query other selected scopes',async()=>{
  const f=await fixture(),result=await invoke(f,'REST','search',{...f.request,repository_id:f.repos[1],repo_snapshot_id:f.snapshots[1]})
  expect(result.data.hits.map((h:{claimId:string})=>h.claimId).sort()).toEqual(f.claims.slice(0,3).sort())
 })
 test('mapping does not read the primary registry when the primary binding has no read permission',async()=>{
  const f=await fixture();f.grant.scopeBindings[0].permissions=[]
  const result=await invoke(f,'REST','search',{...f.request,scope_installation_ids:[f.ids[1]]})
  expect(result.data.hits).toEqual([])
  expect(result.data.degradedComponents).toContain('source_context_forbidden')
 })
 test.each(['target_remote','target_ambiguity','source_remote','source_commit','source_tombstone'])('%s change after mapping is fenced at the actual candidate read',async change=>{
  const f=await fixture(),result=await invoke(f,'REST','search',f.request,async()=>{
   if(change==='target_remote'||change==='source_remote')await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Other/Repo.git' WHERE repository_id=$1",[f.repos[change==='target_remote'?1:0]])
   if(change==='target_ambiguity')await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,'late-alias','https://github.com/Acme/Repo.git',NOW(),NOW())",[f.ids[1],randomUUID()])
   if(change==='source_commit')await pool.query('UPDATE repo_snapshots SET commit_sha=$2 WHERE repo_snapshot_id=$1',[f.snapshots[0],'b'.repeat(40)])
   if(change==='source_tombstone')await pool.query("INSERT INTO memory_source_snapshot_tombstones(installation_id,repository_id,snapshot_id,commit_sha,reason_code) VALUES($1,$2,$3,$4,'fixture')",[f.ids[0],f.repos[0],randomUUID(),'a'.repeat(40)])
  })
  expect(result.status).toBe(200)
  expect(result.data.hits.map((h:{claimId:string})=>h.claimId)).not.toContain(f.claims[1])
 })
})
