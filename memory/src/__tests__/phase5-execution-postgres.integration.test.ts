import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSkillPublicationFixture } from '../testing/skill-publication-fixture.js'
import { createSkillExecutionService } from '../skills/execution-service.js'
import { createSkillRolloutService,skillAssignmentBucket } from '../skills/rollout-service.js'
import { createSkillLifecycleService } from '../skills/lifecycle-service.js'
import { skillFixtureDocument } from '../testing/skill-fixture.js'
import {createMemoryMetrics,updatePhase5Gauges} from '../metrics.js'

const url=process.env.MEMORY_TEST_DATABASE_URL,db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase5 fixture execution lifecycle',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');await applyMemorySchema(pool)},60000)
  afterAll(()=>pool?.end());beforeEach(()=>pool.query('TRUNCATE memory_installations CASCADE'))
  async function fixture(){
    const f=await createSkillPublicationFixture(pool)
    const rollout=createSkillRolloutService(f.deps),execution=createSkillExecutionService(f.deps)
    await rollout.configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:0,state:'canary',basisPoints:10000})
    const request={skillId:f.reviewed.skillId,versionId:f.reviewed.versionId,expectedPublicationRevision:f.published!.publicationRevision,sessionId:f.sessionId,idempotencyKey:'invocation-1'}
    return {...f,rollout,execution,request}
  }
  test('start is durable before delivery; duplicate starts/receipts do not inflate denominators',async()=>{
    const f=await fixture(),started=await f.execution.start(f.reader,f.request)
    expect(started.document).toEqual(skillFixtureDocument())
    expect((await pool.query(`SELECT state FROM memory_skill_executions WHERE execution_id=$1`,[started.executionId])).rows).toEqual([{state:'started'}])
    expect(await f.execution.start(f.reader,f.request)).toMatchObject({executionId:started.executionId,state:'started'})
    const receipt={executionId:started.executionId,expectedRevision:1,outcome:'succeeded',idempotencyKey:'receipt-1'}
    expect(await f.execution.complete(f.reader,receipt)).toMatchObject({state:'succeeded',revision:2,naturalExecutionCount:0})
    await f.execution.complete(f.reader,receipt)
    await expect(f.execution.complete(f.reader,{...receipt,outcome:'failed'})).rejects.toMatchObject({code:'receipt_conflict'})
    const listing=await f.execution.list(f.reader,{skillId:f.reviewed.skillId})
    expect(listing).toMatchObject({counts:{started:0,succeeded:1},unfinished:0,naturalExecutionCount:0})
    const metrics=createMemoryMetrics();await updatePhase5Gauges(pool,metrics.phase5)
    expect(await metrics.registry.metrics()).toContain('pocketctl_memory_skill_ledger_rows{stage="execution",state="succeeded",provenance="fixture"} 1')
    expect(await metrics.registry.metrics()).toContain('pocketctl_memory_skill_natural_executions 0')
  })
  test.each(['failed','taken_over','cancelled'])('records %s separately from unfinished executions',async outcome=>{
    const f=await fixture(),started=await f.execution.start(f.reader,f.request)
    expect(await f.execution.list(f.reader,{skillId:f.reviewed.skillId})).toMatchObject({unfinished:1,counts:{succeeded:0}})
    expect(await f.execution.complete(f.reader,{executionId:started.executionId,expectedRevision:1,outcome,idempotencyKey:'receipt'})).toMatchObject({state:outcome})
  })
  test('production construction and request-supplied fixture capability cannot start or enable Canary',async()=>{
    const f=await fixture(),execution=createSkillExecutionService({...f.deps,fixtureCapability:undefined}),rollout=createSkillRolloutService({...f.deps,fixtureCapability:undefined})
    await expect(execution.start(f.reader,f.request)).rejects.toMatchObject({code:'product_gate_closed'})
    await expect(execution.start(f.reader,{...f.request,fixtureCapability:f.fixtureCapability})).rejects.toMatchObject({code:'invalid_request'})
    await expect(rollout.configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:1,state:'canary',basisPoints:10000})).rejects.toMatchObject({code:'product_gate_closed'})
    expect((await pool.query(`SELECT 1 FROM memory_skill_executions`)).rowCount).toBe(0)
  })
  test('assignment is stable, zero allocation prevents delivery, stale rollout CAS fails',async()=>{
    const f=await fixture(),args=[f.installationId,f.installationId,f.reader.membershipId!,f.repositoryId,f.reviewed.skillId] as const
    expect(skillAssignmentBucket(...args)).toBe(skillAssignmentBucket(...args))
    expect(skillAssignmentBucket(...args)).toBeGreaterThanOrEqual(0)
    expect(skillAssignmentBucket(...args)).toBeLessThan(10000)
    await f.rollout.configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:1,state:'canary',basisPoints:0})
    await expect(f.execution.start(f.reader,f.request)).rejects.toMatchObject({code:'not_assigned'})
    await expect(f.rollout.configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:1,state:'canary',basisPoints:10000})).rejects.toMatchObject({code:'revision_conflict'})
  })
  test.each(['disable','member','reviewer','revoke','session'])('%s prevents late completion and cancels or purges unfinished delivery',async action=>{
    const f=await fixture(),started=await f.execution.start(f.reader,f.request)
    if(action==='disable') await f.rollout.configure(f.publisher,{skillId:f.reviewed.skillId,expectedRevision:1,state:'disabled',basisPoints:0})
    if(action==='member'||action==='reviewer') await pool.query(`UPDATE memory_scope_memberships SET state='revoked',membership_revision=membership_revision+1 WHERE membership_id=$1`,[action==='member'?f.reader.membershipId:f.reviewer.membershipId])
    if(action==='revoke') await f.review.execute(f.publisher,{action:'revoke',skillId:f.reviewed.skillId,expectedRevision:f.reviewed.revision})
    if(action==='session') await createSkillLifecycleService({pool,hmacKey:'fixture-only'}).purgeSession({installationId:f.installationId,sessionId:f.sessionId,reason:'fixture',sourceFeedId:null})
    await expect(f.execution.complete(f.reader,{executionId:started.executionId,expectedRevision:1,outcome:'succeeded',idempotencyKey:'late'})).rejects.toThrow()
    const rows=(await pool.query(`SELECT state FROM memory_skill_executions`)).rows
    expect(rows).toEqual(action==='session'?[]:[{state:'cancelled'}])
  })
  test('head switch prevents old delivery completion; new version has an independent execution',async()=>{
    const f=await fixture(),started=await f.execution.start(f.reader,f.request)
    const next=await f.prepareVersion(f.reviewed,{...skillFixtureDocument(),title:'Next version'})
    await f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})
    await expect(f.execution.complete(f.reader,{executionId:started.executionId,expectedRevision:1,outcome:'succeeded',idempotencyKey:'late'})).rejects.toMatchObject({code:'state_conflict'})
    const current=await f.execution.start(f.reader,{...f.request,versionId:next.versionId,expectedPublicationRevision:2,idempotencyKey:'invocation-2'})
    expect(current.versionId).toBe(next.versionId)
    expect(current.executionId).not.toBe(started.executionId)
  })
  test('other members and installations cannot submit the owner receipt',async()=>{
    const f=await fixture(),started=await f.execution.start(f.reader,f.request),other=await f.actor(['reader'],['read'])
    const receipt={executionId:started.executionId,expectedRevision:1,outcome:'succeeded',idempotencyKey:'receipt'}
    await expect(f.execution.complete(other,receipt)).rejects.toMatchObject({code:'not_found'})
    await expect(f.execution.complete({...other,installationId:randomUUID()},receipt)).rejects.toMatchObject({code:'forbidden'})
    expect((await pool.query(`SELECT state FROM memory_skill_executions`)).rows).toEqual([{state:'started'}])
  })
})
