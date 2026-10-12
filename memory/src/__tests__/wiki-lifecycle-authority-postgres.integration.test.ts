import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createPurgeRepository} from '../purge/repository.js'
import {createWikiManualService} from '../wiki/manual-service.js'
import {createWikiPublicationService} from '../wiki/publication-service.js'
import {createWikiBuildService} from '../wiki/build-service.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Wiki authority versus installation privacy lifecycle',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:6});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})

 test.each(['revoked','config_changed'] as const)('a secondary Wiki mutation rejects a %s primary Grant installation',async cause=>{
  const f=await insertWikiCandidateFixture(pool,'authority-primary-'+cause),primary=randomUUID(),member=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[primary])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[primary])
  await pool.query("UPDATE memory_owner_scopes SET owner_scope_kind='team' WHERE installation_id=$1",[f.installationId])
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['scope_administrator'],'active',1)",[f.installationId,member])
  const grant=f.grant
  grant.primaryInstallationId=primary
  Object.assign(grant.scopeBindings[0],{owner_scope_kind:'team',membership_id:member,membership_revision:'1'})
  grant.scopeBindings.push({installation_id:primary,owner_scope_kind:'personal',owner_scope_id:primary,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']})
  if(cause==='revoked')await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[primary])
  else await pool.query('UPDATE memory_installations SET config_version=2 WHERE installation_id=$1',[primary])
  await expect(createWikiManualService(pool).edit({grant,targetInstallationId:f.installationId,wikiId:f.wikiId,sectionKey:'notes',expectedLockVersion:0,markdown:'stale primary must not authorize this write'})).rejects.toMatchObject({code:'forbidden'})
  expect((await pool.query('SELECT 1 FROM memory_wiki_manual_section_versions')).rowCount).toBe(0)
 })

 test('purge winning first rejects a queued manual edit without an installation/Wiki deadlock',async()=>{
  const f=await insertWikiCandidateFixture(pool,'authority-purge-first')
  let reached!:()=>void,release!:()=>void,actorPid:number|undefined
  const wikiDeleted=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const purgePool={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args:unknown[])=>{
    const result=await Reflect.apply(target.query,target,args)
    if(typeof args[0]==='string'&&args[0].includes('DELETE FROM memory_wikis')){reached();await allowed}
    return result
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}} as unknown as pg.Pool
  const actorPool={connect:async()=>{const client=await pool.connect();actorPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
  const purging=createPurgeRepository(purgePool,{hmacKey:'isolated-authority-test'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_delete'})
  const purgeOutcome=purging.then(value=>({value}),error=>({error}))
  let editing:Promise<unknown>|undefined
  try{
   await Promise.race([wikiDeleted,purgeOutcome.then(result=>{if('error' in result)throw result.error;throw new Error('purge exited before deletion barrier')})])
   editing=createWikiManualService(actorPool).edit({grant:f.grant,targetInstallationId:f.installationId,wikiId:f.wikiId,sectionKey:'notes',expectedLockVersion:0,markdown:'must not survive purge'})
   const editOutcome=editing.then(value=>({value}),error=>({error}))
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    if(actorPid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[actorPid])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(blocked,'edit must reach a real PostgreSQL lifecycle wait').toBe(true)
   release()
   expect(await purgeOutcome).toHaveProperty('value')
   expect(await editOutcome).toMatchObject({error:{code:'forbidden'}})
   expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.installationId])).rows[0].local_status).toBe('purged')
   expect((await pool.query('SELECT 1 FROM memory_wiki_manual_section_versions')).rowCount).toBe(0)
  }finally{release();await purging.catch(()=>undefined);await editing?.catch(()=>undefined)}
 },15000)
 test('an edit winning first commits before purge removes its immutable version',async()=>{
  const f=await insertWikiCandidateFixture(pool,'authority-edit-first')
  let reached!:()=>void,release!:()=>void,purgePid:number|undefined
  const versionWritten=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const actorPool={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args:unknown[])=>{
    const result=await Reflect.apply(target.query,target,args)
    if(typeof args[0]==='string'&&args[0].includes('INSERT INTO memory_wiki_manual_section_versions')){reached();await allowed}
    return result
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}} as unknown as pg.Pool
  const purgePool={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();purgePid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
  const editing=createWikiManualService(actorPool).edit({grant:f.grant,targetInstallationId:f.installationId,wikiId:f.wikiId,sectionKey:'notes',expectedLockVersion:0,markdown:'deleted after commit'})
  const editOutcome=editing.then(value=>({value}),error=>({error}))
  let purging:Promise<unknown>|undefined
  try{
   await Promise.race([versionWritten,editOutcome.then(result=>{if('error' in result)throw result.error;throw new Error('edit exited before version barrier')})])
   purging=createPurgeRepository(purgePool,{hmacKey:'isolated-authority-test'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_delete'})
   const purgeOutcome=purging.then(value=>({value}),error=>({error}))
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    if(purgePid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[purgePid])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(blocked,'purge must drain the active Wiki writer').toBe(true)
   release();expect(await editOutcome).toMatchObject({value:{lockVersion:1}})
   expect(await purgeOutcome).toHaveProperty('value')
   expect((await pool.query('SELECT 1 FROM memory_wiki_manual_section_versions')).rowCount).toBe(0)
   expect((await pool.query('SELECT 1 FROM memory_purge_receipts WHERE installation_id=$1',[f.installationId])).rowCount).toBe(1)
  }finally{release();await editing.catch(()=>undefined);await purging?.catch(()=>undefined)}
 },15000)
 test('repository purge winning first rejects Wiki publication without a repository FK/Wiki deadlock',async()=>{
  const f=await insertWikiCandidateFixture(pool,'authority-repository-first')
  let reached!:()=>void,release!:()=>void,actorPid:number|undefined
  const repositoryLocked=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const purgePool={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args:unknown[])=>{
    const result=await Reflect.apply(target.query,target,args)
    if(typeof args[0]==='string'&&args[0].includes('FROM repositories')&&args[0].includes('FOR UPDATE')){reached();await allowed}
    return result
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}} as unknown as pg.Pool
  const actorPool={connect:async()=>{const client=await pool.connect();actorPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
  const purging=createPurgeRepository(purgePool,{hmacKey:'isolated-authority-test'}).purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'user_delete'})
  const purgeOutcome=purging.then(value=>({value}),error=>({error}))
  let publishing:Promise<unknown>|undefined
  try{
   await Promise.race([repositoryLocked,purgeOutcome.then(result=>{if('error' in result)throw result.error;throw new Error('purge exited before repository barrier')})])
   publishing=createWikiPublicationService(actorPool).publish({grant:f.grant,targetInstallationId:f.installationId,wikiId:f.wikiId,runId:f.runId,expectedGeneration:1,expectedHeadRevision:0})
   const publishOutcome=publishing.then(value=>({value}),error=>({error}))
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    if(actorPid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[actorPid])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(blocked,'publisher must reach the repository lifecycle wait').toBe(true)
   release();expect(await purgeOutcome).toMatchObject({value:{purged:true}})
   expect(await publishOutcome).toMatchObject({error:{code:'not_found'}})
   expect((await pool.query('SELECT 1 FROM memory_wiki_versions')).rowCount).toBe(0)
  }finally{release();await purging.catch(()=>undefined);await publishing?.catch(()=>undefined)}
 },15000)
 test('repository purge winning first cancels an asynchronous Wiki build without a generation/run deadlock',async()=>{
  const f=await insertWikiCandidateFixture(pool,'authority-background-build')
  const scheduled=await createWikiBuildService({pool}).scheduleBuild({installationId:f.installationId,repositoryId:f.repositoryId})
  const job=(await pool.query(`UPDATE memory_jobs SET state='running',claimed_by='wiki-authority-test',claim_epoch=claim_epoch+1
    WHERE job_type='build_wiki' AND payload->>'run_id'=$1 RETURNING *`,[scheduled.runId])).rows[0]
  let reached!:()=>void,release!:()=>void,workerPid:number|undefined
  const generationCancelled=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const purgePool={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args:unknown[])=>{
    const result=await Reflect.apply(target.query,target,args)
    if(typeof args[0]==='string'&&args[0].includes('UPDATE memory_generation_runs gr')){reached();await allowed}
    return result
   }
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}} as unknown as pg.Pool
  const workerPool={connect:async()=>{const client=await pool.connect();workerPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
  const purging=createPurgeRepository(purgePool,{hmacKey:'isolated-authority-test'}).purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'user_delete'})
  const purgeOutcome=purging.then(value=>({value}),error=>({error}))
  let building:Promise<void>|undefined
  try{
   await Promise.race([generationCancelled,purgeOutcome.then(result=>{if('error' in result)throw result.error;throw new Error('purge exited before generation barrier')})])
   building=createWikiBuildService({pool:workerPool}).handleBuildWiki({...job,claim_epoch:Number(job.claim_epoch)},new AbortController().signal,
     {fence:{jobId:job.job_id,claimedBy:'wiki-authority-test',claimEpoch:Number(job.claim_epoch)}})
   const buildOutcome=building.then(()=>({code:'unexpected_success'}),error=>({code:error.code}))
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    if(workerPid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[workerPid])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(blocked,'worker must reach the source lifecycle wait').toBe(true)
   release();expect(await purgeOutcome).toMatchObject({value:{purged:true}})
   expect(['job_fence_lost','wiki_build_not_found']).toContain((await buildOutcome).code)
   expect((await pool.query('SELECT 1 FROM memory_wiki_build_candidates')).rowCount).toBe(0)
  }finally{release();await purging.catch(()=>undefined);await building?.catch(()=>undefined)}
 },15000)
})
