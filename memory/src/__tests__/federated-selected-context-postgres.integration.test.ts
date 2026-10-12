import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import {registerContextRoutes} from '../api/context-routes.js'
import {createGrantGuard} from '../auth/grant-guard.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import {createPackRepository} from '../context/pack-repository.js'
import {createLoadoutRepository} from '../context/loadout-repository.js'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {queryHookPool} from './helpers/query-hook-pool.js'
import {originContextFixture} from './helpers/origin-context-fixture.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'
import {createWikiPublicationService} from '../wiki/publication-service.js'
import {createContextSettingsRepository} from '../context/settings-repository.js'
import {createAdmissionService} from '../context/admission-service.js'
import type {V2GrantFacts} from '../governance/authorization.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('authenticated selected foreign Context (dedicated PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(kind:'team'|'organization'='team',sourceKind:'memory_claim'|'memory_evidence'='memory_claim'){
  const ids=[randomUUID(),randomUUID()],repos=[randomUUID(),randomUUID()],snaps=[randomUUID(),randomUUID()],member=randomUUID(),owner=randomUUID(),claim=randomUUID(),version=randomUUID(),evidence=randomUUID(),episode=randomUUID()
  for(const [i,id] of ids.entries()){
   await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[id])
   await pool.query('INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,$2,$3)',[id,i?kind:'personal',i?owner:id])
   await pool.query('INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,$3,$4,NOW(),NOW())',[id,repos[i],'/same-cwd',i?'git@github.com:Acme/Repo.git':'https://github.com/Acme/Repo.git'])
   await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[id,repos[i],snaps[i],'a'.repeat(40)])
  }
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['reader'])",[ids[1],member])
  const applicability={scopeKind:'snapshot',scopeKey:snaps[1],canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:repos[1],snapshotId:snaps[1],branch:'main',status:'verified'}
  await pool.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,canonical_repository_key,owner_scope_kind,owner_scope_id) VALUES($1,$2,'test_invariant','snapshot',$3,'selected-foreign','active','github.com/Acme/Repo',$4,$5)",[claim,ids[1],snaps[1],kind,owner])
  await pool.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,repo_snapshot_id,branch,applicability) VALUES($1,$2,$3,1,'Foreign exact snapshot invariant',$4,1,$5,$6,'main',$7)",[version,ids[1],claim,kind+'_published',repos[1],snaps[1],applicability])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,'foreign-evidence','turn','ready','fixture')",[ids[1],episode])
  await pool.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,visibility) VALUES($1,$2,$3,$4,1,'episode','Foreign exact snapshot evidence',$5,NOW(),'shared')",[evidence,ids[1],version,episode,createHash('sha256').update('evidence').digest()])
  const grant:V2GrantFacts={primaryInstallationId:ids[0],configVersion:'1',expiresAt:Math.floor(Date.now()/1000)+3600,scopeBindings:[{installation_id:ids[0],owner_scope_kind:'personal',owner_scope_id:ids[0],membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']},{installation_id:ids[1],owner_scope_kind:kind,owner_scope_id:owner,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read']}]}
  const base=await originContextFixture(pool,ids[0]),ctx={...base,consume:(packId:string,injectionId:string,nonce:string)=>base.admission.consume({installationId:ids[0],sessionId:"origin-context-session",packId,injectionId,nonce,selectedScopeGrant:grant} as never)},ref={source_kind:sourceKind,source_id:sourceKind==='memory_claim'?claim:evidence,source_version:version,owner_scope_id:owner,installation_id:ids[1]}
  const input={installationId:ids[0],sessionId:'origin-context-session',clientRequestId:'origin-context-request',agent:'codex',adapterCapability:'native_hidden_v1' as const,query:'Foreign invariant',repositoryId:repos[0],repoSnapshotId:snaps[0],branch:'main',selectedReferences:[ref],selectedScopeGrant:grant,requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,3)}}
  const compile=()=>ctx.compiler.compile(input)
  const admit=(packId:string,g=grant)=>ctx.admission.admit({installationId:ids[0],sessionId:input.sessionId,clientRequestId:input.clientRequestId,packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',sharedGrantAuthorized:true,selectedScopeGrant:g} as never)
  return{ids,repos,snaps,member,owner,claim,version,evidence,grant,ctx,input,compile,admit}
 }
 async function ready(f:Awaited<ReturnType<typeof fixture>>){const c=await f.compile();expect(c.kind).toBe('ready');if(c.kind!=='ready')throw Error('ready required');return c.packId}
 test.each(['team','organization'] as const)('Personal session consumes an explicitly authorized %s Claim with target-local mapping',async kind=>{
  const f=await fixture(kind),packId=await ready(f),p=(await pool.query('SELECT * FROM memory_context_packs WHERE pack_id=$1',[packId])).rows[0]
  expect(p.installation_id).toBe(f.ids[0]);expect(p.stable_text).toContain('Foreign exact snapshot invariant');expect(p.selected_references).toEqual(f.input.selectedReferences)
  expect((await pool.query('SELECT * FROM memory_context_pack_items WHERE pack_id=$1',[packId])).rowCount).toBe(0)
  const a=await f.admit(packId);expect(a.ok).toBe(true);if(!a.ok||!('nonce'in a))throw Error('nonce required')
  expect(await f.ctx.consume(packId,a.injectionId,a.nonce)).toMatchObject({ok:true,pack:{stableText:p.stable_text}})
  expect(await f.ctx.consume(packId,a.injectionId,a.nonce)).toEqual({ok:false,error:'already_consumed'})
 })
 test('selected foreign Evidence preserves its immutable version and evidence identity',async()=>{const f=await fixture('team','memory_evidence'),packId=await ready(f),a=await f.admit(packId);expect(a.ok).toBe(true);expect((await pool.query('SELECT stable_text FROM memory_context_packs WHERE pack_id=$1',[packId])).rows[0].stable_text).toContain(f.evidence)})
 test.each(['absent','no_read','wrong_member','wrong_owner','expired'] as const)('%s binding cannot select foreign body',async change=>{
  const f=await fixture()
  if(change==='absent')delete (f.input as {selectedScopeGrant?:V2GrantFacts}).selectedScopeGrant
  if(change==='no_read')f.grant.scopeBindings[1].permissions=[]
  if(change==='wrong_member')f.grant.scopeBindings[1].membership_id=randomUUID()
  if(change==='wrong_owner')f.input.selectedReferences[0].owner_scope_id=randomUUID()
  if(change==='expired')f.grant.expiresAt=1
  expect((await f.compile()).kind).toBe('empty')
  expect((await pool.query("SELECT COUNT(*)::int n FROM memory_context_packs WHERE stable_text LIKE '%Foreign exact%'")).rows[0].n).toBe(0)
 })
 test.each(['missing','ambiguous','wrong_commit','task'] as const)('%s mapping never clears selected-source filters',async change=>{
  const f=await fixture()
  if(change==='missing')await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Other/Repo.git' WHERE repository_id=$1",[f.repos[1]])
  if(change==='ambiguous')await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,'alias','https://github.com/Acme/Repo.git',NOW(),NOW())",[f.ids[1],randomUUID()])
  if(change==='wrong_commit')await pool.query('UPDATE repo_snapshots SET commit_sha=$2 WHERE repo_snapshot_id=$1',[f.snaps[1],'b'.repeat(40)])
  if(change==='task')Object.assign(f.input,{taskScopeKey:'same-label'})
  expect((await f.compile()).kind).toBe('empty')
 })
 async function mutate(f:Awaited<ReturnType<typeof fixture>>,change:string){
  if(change==='membership')await pool.query("UPDATE memory_scope_memberships SET state='revoked',membership_revision=membership_revision+1 WHERE membership_id=$1",[f.member])
  if(change==='epoch')await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1',[f.ids[1]])
  if(change==='generation')await pool.query('INSERT INTO memory_scope_consumption_generations(installation_id,generation) VALUES($1,2) ON CONFLICT(installation_id) DO UPDATE SET generation=memory_scope_consumption_generations.generation+1',[f.ids[1]])
  if(change==='mapping')await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Other/Repo.git' WHERE repository_id=$1",[f.repos[0]])
  if(change==='validity')await pool.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()-INTERVAL '1 second' WHERE version_id=$1",[f.version])
  if(change==='member_clock')await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-INTERVAL '1 second' WHERE membership_id=$1",[f.member])
  if(change==='hold')await pool.query("UPDATE knowledge_claims SET consumption_hold_reason='requires_review' WHERE claim_id=$1",[f.claim])
  if(change==='evidence')await pool.query('DELETE FROM knowledge_evidence WHERE evidence_id=$1',[f.evidence])
 }
 test.each(['membership','epoch','generation','mapping','validity','member_clock','hold','evidence'])('%s invalidates compiled foreign dependencies before admission',async change=>{const f=await fixture(),packId=await ready(f);await mutate(f,change);expect(await f.admit(packId)).toMatchObject({ok:false,error:'claim_invalid'})})
 test.each(['membership','epoch','generation','mapping','validity','member_clock','hold','evidence'])('%s after nonce precheck is fenced by the atomic consumption statement',async change=>{
  const f=await fixture(),packId=await ready(f),a=await f.admit(packId);expect(a.ok).toBe(true);if(!a.ok||!('nonce'in a))throw Error('nonce required')
  let changed=false
  const hooked=queryHookPool(pool,async(sql)=>{if(!changed&&sql.includes("SET state = 'prepared'")){changed=true;await mutate(f,change)}})
  const consume=createAdmissionService({pool:hooked,nonceHmacKey:Buffer.alloc(32,7)})
  expect(await consume.consume({installationId:f.ids[0],sessionId:f.input.sessionId,packId,injectionId:a.injectionId,nonce:a.nonce,selectedScopeGrant:f.grant} as never)).toEqual({ok:false,error:'expired'})
  expect(changed).toBe(true);expect((await pool.query('SELECT stable_text FROM memory_context_packs WHERE pack_id=$1',[packId])).rows[0].stable_text).toContain('Foreign exact snapshot invariant')
 })
 test.each(['absent','no_read','wrong_member','expired'])('%s current grant cannot redeem a foreign nonce',async change=>{
  const f=await fixture(),packId=await ready(f),a=await f.admit(packId);if(!a.ok||!('nonce'in a))throw Error('nonce required')
  const current=structuredClone(f.grant)
  if(change==='no_read')current.scopeBindings[1].permissions=[]
  if(change==='wrong_member')current.scopeBindings[1].membership_id=randomUUID()
  if(change==='expired')current.expiresAt=1
  expect(await f.ctx.admission.consume({installationId:f.ids[0],sessionId:f.input.sessionId,packId,injectionId:a.injectionId,nonce:a.nonce,...(change==='absent'?{}:{selectedScopeGrant:current})} as never)).toEqual({ok:false,error:'expired'})
 })
 test('current signed deadline expiring after precheck is fenced atomically',async()=>{
  const f=await fixture(),packId=await ready(f),a=await f.admit(packId);if(!a.ok||!('nonce'in a))throw Error('nonce required')
  const current={...f.grant,expiresAt:Date.now()/1000+1}
  let delayed=false
  const hooked=queryHookPool(pool,async(sql)=>{if(!delayed&&sql.includes("SET state = 'prepared'")){delayed=true;await pool.query('SELECT pg_sleep(1.1)')}})
  expect(await createAdmissionService({pool:hooked,nonceHmacKey:Buffer.alloc(32,7)}).consume({installationId:f.ids[0],sessionId:f.input.sessionId,packId,injectionId:a.injectionId,nonce:a.nonce,selectedScopeGrant:current} as never)).toEqual({ok:false,error:'expired'})
  expect(delayed).toBe(true);expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now())
 })
 test('foreign revision interval expiring after precheck cannot deliver frozen bytes',async()=>{
  const f=await fixture()
  await pool.query("UPDATE knowledge_versions SET effective_from=created_at,effective_until=clock_timestamp()+INTERVAL '2 seconds' WHERE version_id=$1",[f.version])
  const packId=await ready(f),a=await f.admit(packId);if(!a.ok||!('nonce'in a))throw Error('nonce required')
  let delayed=false
  const hooked=queryHookPool(pool,async(sql)=>{if(!delayed&&sql.includes("SET state = 'prepared'")){delayed=true;await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (effective_until-clock_timestamp())))::double precision+0.03) FROM knowledge_versions WHERE version_id=$1',[f.version])}})
  expect(await createAdmissionService({pool:hooked,nonceHmacKey:Buffer.alloc(32,7)}).consume({installationId:f.ids[0],sessionId:f.input.sessionId,packId,injectionId:a.injectionId,nonce:a.nonce,selectedScopeGrant:f.grant})).toEqual({ok:false,error:'expired'})
  expect(delayed).toBe(true)
 })
 test('an oversized selected foreign item cannot bypass the stable budget',async()=>{
  const f=await fixture();await createContextSettingsRepository(pool).upsert({installationId:f.ids[0],scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:100,expectedRevision:1});await pool.query('UPDATE knowledge_versions SET statement=$2 WHERE version_id=$1',[f.version,'Bounded foreign statement '.repeat(100)])
  expect(await f.compile()).toMatchObject({kind:'empty',reason:'token_budget'})
  expect((await pool.query("SELECT COUNT(*)::int n FROM memory_context_packs WHERE state='ready'")).rows[0].n).toBe(0)
 })
 test('selected foreign items share the item and rendered-token ceilings',async()=>{
  const f=await fixture()
  for(let i=0;i<11;i++){
   const claim=randomUUID(),version=randomUUID(),evidence=randomUUID()
   await pool.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,canonical_repository_key,owner_scope_kind,owner_scope_id) SELECT $2,installation_id,claim_type,scope_kind,scope_key,$3,state,canonical_repository_key,owner_scope_kind,owner_scope_id FROM knowledge_claims WHERE claim_id=$1",[f.claim,claim,'foreign-'+i])
   await pool.query('INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,repo_snapshot_id,branch,applicability) SELECT $2,installation_id,$3,1,$4,authority,confidence,repository_id,repo_snapshot_id,branch,applicability FROM knowledge_versions WHERE version_id=$1',[f.version,version,claim,'Unique foreign selected item '+i])
   await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
   await pool.query('INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,visibility) SELECT $2,installation_id,$3,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,visibility FROM knowledge_evidence WHERE evidence_id=$1',[f.evidence,evidence,version])
   f.input.selectedReferences.push({...f.input.selectedReferences[0],source_id:claim,source_version:version})
  }
  const outcome=await f.compile();expect(outcome.kind).toBe('ready');if(outcome.kind!=='ready')throw Error('ready required')
  expect(outcome.itemCount).toBeGreaterThan(0);expect(outcome.itemCount).toBeLessThanOrEqual(8)
  const p=(await pool.query('SELECT stable_tokens,selected_references FROM memory_context_packs WHERE pack_id=$1',[outcome.packId])).rows[0]
  expect(p.stable_tokens).toBeLessThanOrEqual(300);expect(p.selected_references).toHaveLength(outcome.itemCount)
  expect((await f.compile())).toMatchObject({kind:'ready',packId:outcome.packId,itemCount:outcome.itemCount})
 })
 async function foreignWikiFixture(){
  const f=await fixture(),w=await insertWikiCandidateFixture(pool,'foreign-wiki',f.ids[1])
  await pool.query("UPDATE memory_scope_memberships SET roles=ARRAY['scope_administrator'] WHERE membership_id=$1",[f.member])
  const publisher={...f.grant,primaryInstallationId:f.ids[1],scopeBindings:[{...f.grant.scopeBindings[1],permissions:['read','contribute','publish']}]}
  await createWikiPublicationService(pool).publish({grant:publisher,targetInstallationId:f.ids[1],wikiId:w.wikiId,runId:w.runId,expectedGeneration:1,expectedHeadRevision:0})
  await pool.query('UPDATE repositories SET canonical_remote=NULL WHERE repository_id=$1',[f.repos[1]])
  await pool.query("UPDATE repositories SET canonical_remote='git@github.com:Acme/Repo.git' WHERE repository_id=$1",[w.repositoryId])
  await pool.query('UPDATE repo_snapshots SET commit_sha=$2 WHERE repo_snapshot_id=$1',[f.snaps[0],w.commitSha])
  await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[f.ids[1],w.repositoryId,randomUUID(),w.commitSha])
  const section=(await pool.query('SELECT section_id,wiki_version_id FROM memory_wiki_sections WHERE installation_id=$1 LIMIT 1',[f.ids[1]])).rows[0]
  Object.assign(f.input,{selectedReferences:[{source_kind:'wiki_section',source_id:section.section_id,source_version:section.wiki_version_id,owner_scope_id:f.owner,installation_id:f.ids[1]}]})

  return{f,w}
 }
 test('foreign commit-only Wiki references require a recorded primary snapshot',async()=>{
  const {f,w}=await foreignWikiFixture()
  await pool.query('DELETE FROM repo_snapshots WHERE repo_snapshot_id=$1',[f.snaps[0]])
  expect(await f.ctx.compiler.compile({...f.input,repoSnapshotId:null,commitSha:w.commitSha})).toMatchObject({kind:'empty',reason:'missing_source'})
 })
 test('a foreign Wiki uses exact target mapping and loses its nonce after head removal',async()=>{
  const {f}=await foreignWikiFixture()
  const packId=await ready(f),a=await f.admit(packId);if(!a.ok||!('nonce'in a))throw Error('nonce required')
  expect(await f.ctx.consume(packId,a.injectionId,a.nonce)).toMatchObject({ok:true,pack:{stableText:expect.stringContaining('Generated content.')}})
  f.input.clientRequestId='second-wiki-read';const second=await ready(f),b=await f.admit(second);if(!b.ok||!('nonce'in b))throw Error('second nonce required')
  await pool.query('DELETE FROM memory_wiki_heads WHERE installation_id=$1',[f.ids[1]])
  expect(await f.ctx.consume(second,b.injectionId,b.nonce)).toEqual({ok:false,error:'expired'})
 })
 test('current grant expiring during ticket insertion rolls admission back',async()=>{
  const f=await fixture(),packId=await ready(f),current={...f.grant,expiresAt:Date.now()/1000+1}
  let delayed=false
  const hooked={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return{query:async(sql:string,args:unknown[])=>{if(!delayed&&sql.includes('INSERT INTO memory_context_injections')){delayed=true;await pool.query('SELECT pg_sleep(1.1)')}return c.query(sql,args)},release:()=>c.release()}}} as unknown as pg.Pool
  const result=await createAdmissionService({pool:hooked,nonceHmacKey:Buffer.alloc(32,7)}).admit({installationId:f.ids[0],sessionId:f.input.sessionId,clientRequestId:f.input.clientRequestId,packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',sharedGrantAuthorized:true,selectedScopeGrant:current})
  expect(delayed).toBe(true);expect(result).toMatchObject({ok:false,error:'claim_invalid'})
  expect((await pool.query('SELECT 1 FROM memory_context_injections WHERE pack_id=$1',[packId])).rowCount).toBe(0)
 })
 test('signed HTTP Context compiles, admits and consumes selected shared bytes with a current grant',async()=>{
  const f=await fixture(),keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keys.publicKey.export({format:'jwk'})
  const sign=(shared=true)=>jwt.sign({token_type:'extension_capability_v2',caller_type:'daemon',session_id:f.input.sessionId,services:['memory.context'],primary_installation_id:f.ids[0],scope_bindings:shared?f.grant.scopeBindings:[f.grant.scopeBindings[0]],config_version:'1'},keys.privateKey,{algorithm:'RS256',keyid:'context-http',issuer:'http://relay.test',audience:'pocketctl-memory',subject:'user:42',expiresIn:60})
  const token=sign(),headers={host:'memory.test',authorization:`Bearer ${token}`}
  const guard=createGrantGuard({pool,relayUrl:'http://relay.test',relayIssuer:'http://relay.test',fetchImpl:async()=>new Response(JSON.stringify({keys:[{...jwk,kid:'context-http',alg:'RS256',use:'sig'}]}))})
  const app=Fastify()
  registerContextRoutes(app,{pool,guard,policy:createCorsHostPolicy({allowedHosts:['memory.test'],allowedOrigins:[],isProduction:false}),sharedScopesEnabled:true,compiler:f.ctx.compiler,admission:f.ctx.admission,packs:createPackRepository(pool),settings:createContextSettingsRepository(pool),loadouts:createLoadoutRepository(pool),feedback:{} as never,requestKey:f.input.requestKey})
  try{
   const body={schema_version:1,client_request_id:f.input.clientRequestId,session_id:f.input.sessionId,agent:'codex',adapter_capability:'native_hidden_v1',query:'Foreign invariant',selected_references:f.input.selectedReferences,repository_hint:{repository_id:f.repos[0],repo_snapshot_id:f.snaps[0],branch:'main'}}
   const forbidden=await app.inject({method:'POST',url:'/api/v1/memory/context/compile',headers:{...headers,authorization:`Bearer ${sign(false)}`},payload:{...body,selectedScopeGrant:f.grant}})
   expect(forbidden.statusCode).toBe(403)
   for(const shared of [true,false]){
    body.client_request_id=shared?'http-positive':'http-lost-read'
    const compilation=await app.inject({method:'POST',url:'/api/v1/memory/context/compile',headers,payload:body})
    expect(compilation.statusCode).toBe(200);expect(compilation.json().outcome).toBe('ready')
    const packId=compilation.json().pack.pack_id
    const admission=await app.inject({method:'POST',url:`/api/v1/memory/context/packs/${packId}/admit`,headers,payload:{client_request_id:body.client_request_id,session_id:body.session_id,agent:'codex',adapter:'codex-app-server'}})
    expect(admission.statusCode).toBe(200);const ticket=admission.json()
    const read=await app.inject({method:'GET',url:`/api/v1/memory/context/packs/${packId}/text?session_id=${body.session_id}&injection_id=${ticket.injection_id}&nonce=${ticket.nonce}`,headers:{...headers,authorization:`Bearer ${shared?token:sign(false)}`}})
    expect(read.statusCode).toBe(shared?200:410)
    if(shared)expect(read.json().stable_text).toContain('Foreign exact snapshot invariant')
    else expect(read.body).not.toContain('Foreign exact snapshot invariant')
    const frozen=(await pool.query('SELECT query_context FROM memory_context_packs WHERE pack_id=$1',[packId])).rows[0]
    expect(JSON.stringify(frozen.query_context)).not.toContain(token)
   }
  }finally{await app.close()}
 })
 test('personal management history cannot expose frozen foreign body without a current source grant',async()=>{
  const f=await fixture(),packId=await ready(f)
  await mutate(f,'membership')
  const app=Fastify()
  registerContextRoutes(app,{pool,guard:{guard:async()=>({installationId:f.ids[0],configVersion:'1',callerType:'web',services:['memory.manage']})} as never,policy:createCorsHostPolicy({allowedHosts:['memory.test'],allowedOrigins:[],isProduction:false}),compiler:f.ctx.compiler,admission:f.ctx.admission,packs:createPackRepository(pool),settings:createContextSettingsRepository(pool),loadouts:createLoadoutRepository(pool),feedback:{} as never,requestKey:f.input.requestKey})
  try{
   const response=await app.inject({method:'GET',url:`/api/v1/memory/context/packs?session_id=${f.input.sessionId}`,headers:{host:'memory.test',authorization:'Bearer personal-management'}})
   expect(response.statusCode).toBe(200);expect(response.json().packs[0].pack_id).toBe(packId)
   expect(response.body).not.toContain('Foreign exact snapshot invariant')
   expect((await pool.query('SELECT stable_text FROM memory_context_packs WHERE pack_id=$1',[packId])).rows[0].stable_text).toContain('Foreign exact snapshot invariant')
  }finally{await app.close()}
 })
 test.each(['ttl','revoke'])('an injection row-lock wait cannot outlive %s',async change=>{
  const f=await fixture(),packId=await ready(f),service=createAdmissionService({pool,nonceHmacKey:Buffer.alloc(32,7),admissionTtlSeconds:change==='ttl'?0.5:5})
  const a=await service.admit({installationId:f.ids[0],sessionId:f.input.sessionId,clientRequestId:f.input.clientRequestId,packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',sharedGrantAuthorized:true,selectedScopeGrant:f.grant});if(!a.ok||!('nonce'in a))throw Error('nonce required')
  const locker=await pool.connect();await locker.query('BEGIN');await locker.query('SELECT 1 FROM memory_context_injections WHERE injection_id=$1 FOR UPDATE',[a.injectionId])
  let signal!:()=>void;const started=new Promise<void>(resolve=>{signal=resolve})
  const hooked=queryHookPool(pool,async(sql)=>{if(sql.includes("SET state = 'prepared'")||sql.includes('FOR UPDATE OF j'))signal()})
  const consumption=createAdmissionService({pool:hooked,nonceHmacKey:Buffer.alloc(32,7)}).consume({installationId:f.ids[0],sessionId:f.input.sessionId,packId,injectionId:a.injectionId,nonce:a.nonce,selectedScopeGrant:f.grant})
  try{
   await started
   if(change==='ttl')await pool.query('SELECT pg_sleep(0.7)')
   else await mutate(f,'membership')
   await locker.query('COMMIT')
   expect(await consumption).toEqual({ok:false,error:'expired'})
  }finally{await locker.query('ROLLBACK');locker.release()}
 })
})
