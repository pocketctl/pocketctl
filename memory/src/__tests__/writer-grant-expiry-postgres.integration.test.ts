import pg from 'pg'
import Fastify from 'fastify'
import {registerWikiRoutes} from '../api/wiki-routes.js'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'
import {createWikiManualService} from '../wiki/manual-service.js'
import {createWikiPublicationService} from '../wiki/publication-service.js'
import {createSkillGovernanceFixture} from '../testing/skill-fixture.js'
import {createSkillReviewService} from '../skills/review-service.js'
import {createSkillPublicationFixture,skillPublicationFixtureContext as context} from '../testing/skill-publication-fixture.js'
import {gitDbFixture} from '../testing/phase6-db-fixture.js'
import {createGitRepository,type GitTargetRegistry} from '../git-sync/repository.js'
import {createSkillAdmissionService} from '../skills/admission-service.js'
import {createSkillRolloutService} from '../skills/rollout-service.js'
import {createSkillExecutionService} from '../skills/execution-service.js'
import {createSkillPolicyService,DEFAULT_SKILL_PUBLICATION_POLICY} from '../skills/policy-service.js'
import {gitExportFixture} from '../testing/phase6-export-fixture.js'
import {attestationFixture} from '../testing/phase6-attestation-fixture.js'
import {createGitExportService} from '../git-sync/export-service.js'
import {createGitInboxService} from '../git-sync/inbox-service.js'
import {loadGitSyncConfig} from '../git-sync/config.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('all writer signed Grant expiry fences',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:6});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 const expired=<T extends {grant:object}>(identity:T)=>({...identity,grant:{...identity.grant,expiresAt:1}})
 test('Wiki manual edit rejects expired authorization before writing an immutable revision',async()=>{
  const f=await insertWikiCandidateFixture(pool,'expiry-manual')
  await expect(createWikiManualService(pool).edit({grant:{...f.grant,expiresAt:1},targetInstallationId:f.installationId,wikiId:f.wikiId,sectionKey:'notes',markdown:'Expired mutation',expectedLockVersion:0})).rejects.toMatchObject({code:'forbidden'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_wiki_manual_section_versions')).rows[0].n).toBe(0)
 })
 test.each(['direct','v1_http'])('Wiki %s expiry while waiting for its section head rolls back the edit',async(path)=>{
  const f=await insertWikiCandidateFixture(pool,'expiry-blocked')
  const input={grant:f.grant,targetInstallationId:f.installationId,wikiId:f.wikiId,sectionKey:'notes',markdown:'Initial',expectedLockVersion:0}
  await createWikiManualService(pool).edit(input)
  const locker=await pool.connect()
  let entered!:()=>void;const blocked=new Promise<void>(resolve=>{entered=resolve})
  const hooked={query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect()
   return new Proxy(client,{get(target,key){if(key==='query')return(...args:unknown[])=>{
    const pending=Reflect.apply(target.query,target,args)
    if(typeof args[0]==='string'&&args[0].includes('FROM memory_wiki_manual_section_heads')&&args[0].includes('FOR UPDATE'))entered()
    return pending
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  }} as unknown as pg.Pool
  let pending:Promise<unknown>|undefined,app:ReturnType<typeof Fastify>|undefined
  try{
   await locker.query('BEGIN');await locker.query('SELECT wiki_id FROM memory_wiki_manual_section_heads WHERE installation_id=$1 FOR UPDATE',[f.installationId])
   const expiresAt=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+0.7
   if(path==='v1_http'){
    app=Fastify()
    registerWikiRoutes(app,{pool:hooked,wikiMode:'enabled',cursorSigningKey:'isolated-wiki-clock',guard:{guardMcp:async()=>({installationId:f.installationId,configVersion:'1',expiresAt,services:['memory.manage'],callerType:'web'})} as never})
    pending=app.inject({method:'PUT',url:`/api/v1/memory/wikis/${f.wikiId}/manual-sections/notes`,payload:{markdown:'Must roll back',expected_lock_version:1}}).then((response:{statusCode:number})=>({httpStatus:response.statusCode}))
   }else pending=createWikiManualService(hooked).edit({...input,grant:{...f.grant,expiresAt},markdown:'Must roll back',expectedLockVersion:1})
   const outcome=pending!.then(value=>({value}),error=>({error}))
   await blocked
   await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[expiresAt+0.01])
   await locker.query('COMMIT')
   expect(await outcome).toMatchObject(path==='v1_http'?{value:{httpStatus:403}}:{error:{code:'forbidden'}})
   expect((await pool.query('SELECT count(*)::int AS n FROM memory_wiki_manual_section_versions')).rows[0].n).toBe(1)
  }finally{await locker.query('ROLLBACK');locker.release();await pending?.catch(()=>undefined);await app?.close()}
 })
 test('Wiki publication rejects expired authorization without activating a head',async()=>{
  const f=await insertWikiCandidateFixture(pool,'expiry-publish')
  await expect(createWikiPublicationService(pool).publish({grant:{...f.grant,expiresAt:1},targetInstallationId:f.installationId,wikiId:f.wikiId,runId:f.runId,expectedGeneration:1,expectedHeadRevision:0})).rejects.toMatchObject({code:'forbidden'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_wiki_heads')).rows[0].n).toBe(0)
 })
 test('Skill draft rejects expired authorization without creating a version',async()=>{
  const f=await createSkillGovernanceFixture(pool,context)
  await expect(createSkillReviewService({pool,context}).execute(expired(f.author),{action:'draft',candidateId:f.candidateId,expectedRevision:0})).rejects.toMatchObject({code:'forbidden'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_skill_versions')).rows[0].n).toBe(0)
 })
 test('Skill replay receipt cannot be read using expired authorization',async()=>{
  const f=await createSkillPublicationFixture(pool,{publish:false})
  await expect(f.replay.execute(expired(f.reviewer),{...f.reviewed.subject,caseIds:f.reviewed.records.map(c=>c.case_id),idempotencyKey:`replay-${f.reviewed.versionId}`})).rejects.toMatchObject({code:'forbidden'})
 })
 test('Skill publish rejects expired authorization before changing publication heads',async()=>{
  const f=await createSkillPublicationFixture(pool,{publish:false})
  await expect(f.publication.execute(expired(f.publisher),f.publishRequest)).rejects.toMatchObject({code:'forbidden'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_skill_publication_heads')).rows[0].n).toBe(0)
 })
 test('Skill rollback rejects expired authorization and preserves the current published version',async()=>{
  const f=await createSkillPublicationFixture(pool),next=await f.prepareVersion(f.reviewed)
  await f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})
  await expect(f.rollback.execute(expired(f.publisher),{skillId:next.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:next.revision,expectedPublicationRevision:2})).rejects.toMatchObject({code:'forbidden'})
  expect((await pool.query('SELECT current_version_id FROM memory_skill_publication_heads')).rows[0].current_version_id).toBe(next.versionId)
 })
 async function deadlinePool(marker:string){
  const expiresAt=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+0.7
  let reached=false
  const hooked={query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect()
   return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
    if(!reached&&typeof args[0]==='string'&&args[0].includes(marker)){
     reached=true
     await client.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[expiresAt+0.01])
    }
    return Reflect.apply(target.query,target,args)
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  }} as unknown as pg.Pool
  return{hooked,expiresAt,reached:()=>reached}
 }
 test.each(['new','replay'])('Skill %s admission expiry after source resolution rolls back task scheduling',async path=>{
  const f=await createSkillGovernanceFixture(pool,context,'personal'),d=await deadlinePool('skill:task:')
  const before=(await pool.query('SELECT count(*)::int AS n FROM memory_skill_tasks')).rows[0].n
  await expect(createSkillAdmissionService({pool:d.hooked,context}).schedule({...f.author,grant:{...f.author.grant,expiresAt:d.expiresAt},candidateKey:path==='new'?'clock-new':'method',source:{kind:'episode',episodeId:f.episodeId}})).rejects.toMatchObject({code:'skill_forbidden'})
  expect(d.reached()).toBe(true)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_skill_tasks')).rows[0].n).toBe(before)
 })
 test.each([['repository','new'],['repository','replay'],['wiki','new'],['wiki','replay']])('Wiki %s HTTP %s build admission expiry rejects inside its scheduling transaction',async(route,path)=>{
  const f=await insertWikiCandidateFixture(pool,'expiry-admission-'+route+'-'+path)
  if(path==='replay')await pool.query("UPDATE memory_wiki_build_runs SET state='queued' WHERE run_id=$1",[f.runId])
  const generation=Number((await pool.query('SELECT generation FROM memory_wikis WHERE wiki_id=$1',[f.wikiId])).rows[0].generation)
  const d=await deadlinePool('FROM memory_wikis')
  const app=Fastify()
  registerWikiRoutes(app,{pool:d.hooked,wikiMode:'enabled',cursorSigningKey:'isolated-wiki-admission-clock',guard:{guardMcp:async()=>({installationId:f.installationId,configVersion:'1',expiresAt:d.expiresAt,services:['memory.manage'],callerType:'web'})} as never})
  try{
   const response=await app.inject({method:'POST',url:route==='repository'?`/api/v1/memory/repositories/${f.repositoryId}/wiki/builds`:`/api/v1/memory/wikis/${f.wikiId}/builds`,payload:{expected_generation:generation}})
   expect(d.reached()).toBe(true)
   expect(response.statusCode).toBe(403)
   expect((await pool.query('SELECT count(*)::int AS n FROM memory_wiki_build_runs')).rows[0].n).toBe(1)
   expect(Number((await pool.query('SELECT generation FROM memory_wikis WHERE wiki_id=$1',[f.wikiId])).rows[0].generation)).toBe(generation)
  }finally{await app.close()}
 })
 test('Skill rollout expiry inside the transaction rolls back rollout and execution cancellation',async()=>{
  const f=await createSkillPublicationFixture(pool),d=await deadlinePool('INSERT INTO memory_skill_rollouts')
  await expect(createSkillRolloutService({...f.deps,pool:d.hooked}).configure({...f.publisher,grant:{...f.publisher.grant,expiresAt:d.expiresAt}},
   {skillId:f.reviewed.skillId,expectedRevision:0,state:'disabled',basisPoints:0})).rejects.toMatchObject({code:'forbidden'})
  expect(d.reached()).toBe(true)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_skill_rollouts')).rows[0].n).toBe(0)
 })
 test('Skill policy expiry inside the transaction rolls back policy version and allowed audit',async()=>{
  const f=await createSkillPublicationFixture(pool),d=await deadlinePool('INSERT INTO memory_skill_publication_policy_versions')
  await expect(createSkillPolicyService({pool:d.hooked}).execute({...f.policyAdmin,grant:{...f.policyAdmin.grant,expiresAt:d.expiresAt}},
   {expectedRevision:0,policy:DEFAULT_SKILL_PUBLICATION_POLICY})).rejects.toMatchObject({code:'forbidden'})
  expect(d.reached()).toBe(true)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_skill_publication_policy_versions')).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int AS n FROM memory_skill_audit_events WHERE action='policy' AND outcome='allowed'")).rows[0].n).toBe(0)
 })
 test('Skill execution receipt expiry inside the transaction preserves its unfinished state',async()=>{
  const f=await createSkillPublicationFixture(pool)
  await createSkillRolloutService(f.deps).configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:0,state:'canary',basisPoints:10000})
  const started=await createSkillExecutionService(f.deps).start(f.reader,{skillId:f.reviewed.skillId,versionId:f.reviewed.versionId,expectedPublicationRevision:f.published!.publicationRevision,sessionId:f.sessionId,idempotencyKey:'clock-start'})
  const d=await deadlinePool('UPDATE memory_skill_executions SET state=')
  await expect(createSkillExecutionService({...f.deps,pool:d.hooked}).complete({...f.reader,grant:{...f.reader.grant,expiresAt:d.expiresAt}},
   {executionId:started.executionId,expectedRevision:1,outcome:'succeeded',idempotencyKey:'clock-receipt'})).rejects.toMatchObject({code:'forbidden'})
  expect(d.reached()).toBe(true)
  expect((await pool.query('SELECT state,revision::int AS revision FROM memory_skill_executions WHERE execution_id=$1',[started.executionId])).rows[0]).toEqual({state:'started',revision:1})
 })
 async function queueFixture(){
  const f=await gitExportFixture(pool),keys=attestationFixture()
  const bundle=await createGitExportService({pool,keys:keys.registry,skill:{context:f.skill.context,cases:f.skill.cases}}).export(f.grant,
   {installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')})
  return{f,subject:{installationId:f.installationId,connectionId:f.connectionId,exportId:bundle.exportId,expectedGeneration:'1'},config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'})}
 }
 test('Git enrollment retains signed expiry before sanitizing durable principal facts',async()=>{
  const {f,subject,config}=await queueFixture()
  await expect(createGitInboxService({pool,config,scopeMode:async()=> 'enabled'}).enroll({...f.grant,expiresAt:1},subject)).rejects.toThrow('git_forbidden')
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_sync_principals')).rows[0].n).toBe(0)
 })
 test('Git enrollment expiry during admission rolls back its durable principal',async()=>{
  const {f,subject,config}=await queueFixture(),d=await deadlinePool('INSERT INTO memory_git_sync_principals')
  await expect(createGitInboxService({pool:d.hooked,config,scopeMode:async()=> 'enabled'}).enroll({...f.grant,expiresAt:d.expiresAt},subject)).rejects.toThrow('git_forbidden')
  expect(d.reached()).toBe(true)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_sync_principals')).rows[0].n).toBe(0)
 })
 const target={provider:'github' as const,providerRepositoryId:'123',branch:'main',credentialRef:'local-ref'}
 test('Git connection creation rejects expired authorization before registry lookup',async()=>{
  const f=await gitDbFixture(pool)
  await expect(createGitRepository({pool,targets:{resolve:async()=>target}}).createConnection({...f.grant,expiresAt:1},{installationId:f.installationId,repositoryId:f.repositoryId,targetId:'local-target',syncMode:'shadow',writeMode:'off'})).rejects.toThrow('git_forbidden')
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_connections')).rows[0].n).toBe(0)
 })
 test('Git expiry while inside the transaction rolls back its connection and audit',async()=>{
  const f=await gitDbFixture(pool)
  const expiresAt=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+0.7
  const targets:GitTargetRegistry={resolve:async()=>{
   await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[expiresAt+0.01]);return target
  }}
  await expect(createGitRepository({pool,targets}).createConnection({...f.grant,expiresAt},{installationId:f.installationId,repositoryId:f.repositoryId,targetId:'local-target',syncMode:'shadow',writeMode:'off'})).rejects.toThrow('git_forbidden')
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_connections')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_audit_events')).rows[0].n).toBe(0)
 })
})
