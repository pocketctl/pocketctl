import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSkillPublicationFixture} from '../testing/skill-publication-fixture.js'
import {createSkillRollbackService} from '../skills/rollback-service.js'
import {createSharedClaimLifecycle} from '../governance/publication-service.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('rollback cleanup agrees with Claim invalidation lock order',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!)
  await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await applyMemorySchema(pool)
 },60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function previousTarget(){
  const f=await createSkillPublicationFixture(pool),next=await f.prepareVersion(f.reviewed)
  await f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})
  const source=(await pool.query<{claim_id:string;version_id:string}>(`SELECT k.claim_id,k.version_id FROM memory_skill_versions v
   JOIN memory_skill_archives a USING(installation_id,archive_id)
   JOIN knowledge_versions k ON k.installation_id=a.installation_id AND k.version_id=a.claim_version_id
   WHERE v.installation_id=$1 AND v.version_id=$2`,[f.installationId,f.reviewed.versionId])).rows[0]!
  const request={skillId:next.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:next.revision,expectedPublicationRevision:2}
  return {f,next,source,request}
 }
 async function expire(versionId:string){await pool.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval '1 second' WHERE version_id=$1",[versionId])}
 test('expired previous cleanup and concurrent shared Claim revoke finish without a task/archive deadlock',async()=>{
  const {f,source,request}=await previousTarget();await expire(source.version_id)
  let release!:()=>void,entered!:()=>void
  const resume=new Promise<void>(resolve=>{release=resolve}),reached=new Promise<void>(resolve=>{entered=resolve})
  let paused=false,revokePid:number|undefined,revokeFinished=false
  const cleanupPool={query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect()
   return new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
    if(!paused&&typeof args[0]==='string'&&args[0].includes('FROM memory_skill_tasks')&&args[0].includes('FOR UPDATE')){
     paused=true;entered();await resume
    }
    return Reflect.apply(target.query,target,args)
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  }} as unknown as pg.Pool
  const revokePool={query:pool.query.bind(pool),connect:async()=>{
   const client=await pool.connect();revokePid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
   return client
  }} as unknown as pg.Pool
  const cleanup=createSkillRollbackService({...f.deps,pool:cleanupPool}).execute(f.publisher,request)
   .then(value=>({value}),error=>({error}))
  let revoke:Promise<{value?:unknown;error?:unknown}>|undefined
  try{
   await reached
   revoke=createSharedClaimLifecycle(revokePool).revokeSharedClaim({grant:f.publisher.grant,targetInstallationId:f.installationId,
    claimId:source.claim_id,expectedRevision:1,reason:'Concurrent source withdrawal'})
    .then(value=>{revokeFinished=true;return {value}},error=>{revokeFinished=true;return {error}})
   let observed=false
   for(let attempt=0;attempt<200;attempt++){
    if(revokeFinished||(revokePid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[revokePid])).rows[0].blocked)){
     observed=true;break
    }
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(observed).toBe(true)
   release()
   // Both outcomes are consumer-visible: source withdrawal must succeed and
   // rollback retains its original invalid-source denial rather than 40P01.
   expect(await revoke).toEqual({value:{state:'revoked'}})
   expect(await cleanup).toMatchObject({error:{code:'source_invalid'}})
   expect((await pool.query('SELECT state FROM knowledge_claims WHERE claim_id=$1',[source.claim_id])).rows).toEqual([{state:'revoked'}])
   expect((await pool.query('SELECT 1 FROM memory_skill_archives WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
  }finally{release();await cleanup;await revoke}
 },15000)
 test('a valid exact previous version still rolls back successfully',async()=>{
  const {f,next,request}=await previousTarget()
  expect(await f.rollback.execute(f.publisher,request)).toMatchObject({versionId:f.reviewed.versionId,state:'active',publicationRevision:3})
  expect((await pool.query('SELECT current_version_id,state,revision::int FROM memory_skill_publication_heads WHERE skill_id=$1',[next.skillId])).rows)
   .toEqual([{current_version_id:f.reviewed.versionId,state:'active',revision:3}])
 })
 test('invalid-source cleanup disables delivery only for a current publisher and matching revisions',async()=>{
  const {f,next,source,request}=await previousTarget();await expire(source.version_id)
  const expired={...f.publisher,grant:{...f.publisher.grant,expiresAt:1}}
  for(const identity of [f.reader,expired])await expect(f.rollback.execute(identity,request)).rejects.toMatchObject({code:'forbidden'})
  await expect(f.rollback.execute(f.publisher,{...request,expectedPublicationRevision:1})).rejects.toMatchObject({code:'source_invalid'})
  expect((await pool.query('SELECT state,revision::int FROM memory_skill_publication_heads WHERE skill_id=$1',[next.skillId])).rows).toEqual([{state:'active',revision:2}])
  await expect(f.rollback.execute(f.publisher,request)).rejects.toMatchObject({code:'source_invalid'})
  expect((await pool.query('SELECT current_version_id,state,revision::int FROM memory_skill_publication_heads WHERE skill_id=$1',[next.skillId])).rows)
   .toEqual([{current_version_id:next.versionId,state:'disabled',revision:3}])
 })
})
