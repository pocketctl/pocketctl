import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
let task9ConflictFixture:typeof import('./task9-receipt-conflict-fixture.js').task9ConflictFixture
let task9LoseCommittedAck:typeof import('./task9-receipt-conflict-fixture.js').task9LoseCommittedAck
let task9Evidence:typeof import('./task9-receipt-drain-fixture.js').task9Evidence
import {evaluateAutomation} from '../../governance/automation-evaluator.js'
import {recordReviewProviderUsage} from '../../generation/provider-effect.js'
import {withTextProviderBudget,createProviderBudgetStore} from '../../model/provider-budget.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import type {TextGenerator} from '../../ports/text-generator.js'
const usage={model:'task9-synthetic',inputTokens:12,outputTokens:3,costMicros:4}
const privateSuite=process.env.RUN_PRIVATE_SHARED_RECEIPT_TESTS==='1'?describe:describe.skip
privateSuite('Task9 R3 actual review exact tuple and lost commit ACK',()=>{
 let f:Awaited<ReturnType<typeof task9ConflictFixture>>,s:Awaited<ReturnType<Awaited<ReturnType<typeof task9ConflictFixture>>['review']>>,prepared:any,effect:Parameters<typeof recordReviewProviderUsage>[1],observed:any
 let providerCalls=0
 beforeAll(async()=>{
  ;({task9ConflictFixture,task9LoseCommittedAck}=await import('./task9-receipt-conflict-fixture.js'))
  ;({task9Evidence}=await import('./task9-receipt-drain-fixture.js'))
  f=await task9ConflictFixture();s=await f.review()
  const key=randomUUID(),provider=withTextProviderBudget({async generateJson(){providerCalls++;return {ok:true,value:{support:true,conflict:false,risk:'low'},usage}}}as TextGenerator,createProviderBudgetStore(f.runtime),{key,maxRequests:10,maxInputTokens:1000000,maxOutputTokens:10000,maxOutputTokensPerRequest:100})
  await withSourceJobExecution(f.runtime,s.fence,async()=>{
   prepared=(await s.repo.prepare(s.target))!
   let ack:any,committed:any
   const decision=await evaluateAutomation(prepared,{provider,onProviderUsage:async response=>{
    effect={installationId:prepared.installationId,runId:prepared.runId,usage:response.usage,budgetReservationId:response.budgetReservationId}
    ack=await task9LoseCommittedAck(f.runtime,()=>recordReviewProviderUsage(f.runtime,effect))
    committed=(await f.admin.query('SELECT usage_id,model,input_tokens::text,output_tokens::text,cost_micros::text FROM memory.memory_usage_outbox WHERE installation_id=$1',[effect.installationId])).rows
    if(!ack.ok)throw Error(ack.message)
   }})
   const repeats=await Promise.allSettled([s.repo.finish(prepared,decision),recordReviewProviderUsage(f.runtime,effect),recordReviewProviderUsage(f.runtime,effect)])
   observed={ack,committed,decision,repeats:repeats.map(r=>r.status==='fulfilled'?{status:r.status,value:r.value}:{status:r.status,error:String(r.reason)}),providerCalls,effect}
   task9Evidence('task9-r3-lost-ack-same-tuple',observed)
  })
 },30000)
 afterAll(async()=>{try{if(s)await f.cleanup(s)}finally{await f?.close()}})
 const receipt=async()=>(await f.admin.query('SELECT usage_id,model,input_tokens::text,output_tokens::text,cost_micros::text FROM memory.memory_usage_outbox WHERE installation_id=$1',[effect.installationId])).rows
 test('actual COMMIT survives simulated lost ACK and same tuple callback finish retries retain one exact receipt',async()=>{
  expect(observed.ack).toEqual({ok:false,message:'task9_synthetic_commit_ack_lost',events:['committed']})
  const expected=[{usage_id:'review:'+prepared.runId,model:'task9-synthetic',input_tokens:'12',output_tokens:'3',cost_micros:'4'}]
  expect(observed.committed).toEqual(expected);expect(await receipt()).toEqual(expected)
  expect(observed.repeats.map((r:any)=>r.status)).toEqual(['fulfilled','fulfilled','fulfilled'])
  expect(observed.decision).toMatchObject({reason:'provider_result_unknown',billingUncertain:true,usage,budgetReservationId:effect.budgetReservationId})
  expect(providerCalls).toBe(1)
 })
 test.each(['input_tokens','output_tokens','model','cost','installation','run','reservation']as const)('conflicting %s in the original review receipt call is explicitly refused',async field=>{
  const changed={...effect,usage:{...usage}}
  if(field==='input_tokens')changed.usage.inputTokens=13
  if(field==='output_tokens')changed.usage.outputTokens=4
  if(field==='model')changed.usage.model='task9-conflicting-model'
  if(field==='cost')changed.usage.costMicros=5
  if(field==='installation')changed.installationId=s.fixture.personal
  if(field==='run')changed.runId=randomUUID()
  if(field==='reservation')changed.budgetReservationId=randomUUID()
  const before=await receipt()
  const result=await recordReviewProviderUsage(f.runtime,changed).then(()=>({accepted:true}),e=>({accepted:false,message:e.message}))
  const after=await receipt()
  task9Evidence('task9-r3-conflict-'+field,{field,original:effect,changed,result,before,after,providerCalls,note:'Current writer accepts reservation argument but does not persist a reservation link; installation/run mismatch may silently no-op. Refusal must be explicit.'})
  expect(after).toEqual(before);expect(providerCalls).toBe(1)
  expect(result.accepted,'conflicting tuple must be rejected visibly rather than ON CONFLICT ignored or zero-row no-op').toBe(false)
 })
})
