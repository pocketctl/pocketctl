import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {ProviderReceiptRepository} from '../../model/provider-receipt.js'
import {withTextProviderBudget,createProviderBudgetStore} from '../../model/provider-budget.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
import type {TextGenerator} from '../../ports/text-generator.js'
import {randomUUID} from 'node:crypto'
import {evaluateAutomation} from '../../governance/automation-evaluator.js'
import {recordReviewProviderUsage} from '../../generation/provider-effect.js'
import {providerReceiptIdentity} from '../../model/provider-receipt.js'
import {RECEIPT_IDENTITY,type ReceiptIdentity} from '../../model/provider-receipt-contract.js'
import {guardSourceExecutionCommit} from '../../sources/source-execution.js'
import {auditProviderReceiptComponent} from '../../migrations/provider-receipt/migration.js'
import {createPromotionService} from '../../governance/promotion-service.js'
let task9ComponentFixture:typeof import('./task9-receipt-component-fixture.js').task9ComponentFixture
let componentEvidence:typeof import('./task9-receipt-component-fixture.js').componentEvidence
const privateSuite=process.env.RUN_PRIVATE_SHARED_RECEIPT_TESTS==='1'?describe:describe.skip
privateSuite('explicit private provider receipt component',()=>{
let f:Awaited<ReturnType<typeof task9ComponentFixture>>
beforeAll(async()=>{({task9ComponentFixture,componentEvidence,componentFaults}=await import('./task9-receipt-component-fixture.js'));f=await task9ComponentFixture()})
afterAll(async()=>{await f?.close()})
test('actual budget-wrapped review persists its explicitly enrolled original full receipt',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'}),key=randomUUID();let calls=0
 const provider=withTextProviderBudget({async generateJson(){calls++;return {ok:true,value:{support:true,conflict:false,risk:'low'},usage:{model:'task9-synthetic',inputTokens:12,outputTokens:3,costMicros:4}}}}as TextGenerator,createProviderBudgetStore(f.runtime),{key,maxRequests:10,maxInputTokens:1000000,maxOutputTokens:10000,maxOutputTokensPerRequest:100})
 await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const prepared=(await s.repo.prepare(s.target))!
  const receipt=repository.review({installationId:s.target.installationId,runId:prepared.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{inputRate:250000,outputRate:333333}})
  const result=await provider.generateJson({operation:'review_shadow',requestKey:'review:'+prepared.runId,receipt,system:'synthetic',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal})
  const rows=(await f.admin.query('SELECT original_attempt_id,budget_reservation_id,phase,sink_state,input_tokens::text,output_tokens::text,cost_micros::text FROM memory.memory_provider_receipts WHERE installation_id=$1',[s.target.installationId])).rows
  componentEvidence('enrollment',{rows,calls,resultReceipt:Boolean(result.providerReceipt),runId:prepared.runId,key})
  expect(calls).toBe(1)
  expect(rows,'enrolled real wrapper must preserve full usage under the original preHTTP anchor').toHaveLength(1)
  expect(rows[0]).toMatchObject({phase:'received',sink_state:'recorded',input_tokens:'12',output_tokens:'3',cost_micros:'4'})
 })
})

test('original source-attempt hash cannot be rebound to another existing review run',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'})
 await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const prepared=(await s.repo.prepare(s.target))!,wrongKey='review:'+randomUUID()
  const held=await createProviderBudgetStore(f.runtime).reserve({key:randomUUID(),requestKey:wrongKey,kind:'text',inputTokens:1500,outputTokens:100,maxRequests:10,maxInputTokens:10000,maxOutputTokens:1000})
  if(!held.ok)throw Error('fixture_reservation_failed')
  const {startSourceProviderAttempt}=await import('../../sources/source-execution.js')
  await startSourceProviderAttempt(held.reservationId,wrongKey)
  const receipt=repository.review({installationId:s.target.installationId,runId:prepared.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
  await expect(repository.admit(receipt,held.reservationId),'wrong original paid request hash must refuse before provider IO').rejects.toThrow('receipt_original_attempt_unproved')
 })
})

const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
const nativeUsage={model:'task9-synthetic',inputTokens:12,outputTokens:3,costMicros:4}
const budget=(raw:TextGenerator,key=randomUUID())=>withTextProviderBudget(raw,createProviderBudgetStore(f.runtime),{key,maxRequests:10,maxInputTokens:1000000,maxOutputTokens:10000,maxOutputTokensPerRequest:100})
async function callReview(options:{pricing?:{inputRate?:number;outputRate?:number};raw?:()=>Promise<any>}={}){
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'});let calls=0
 const provider=budget({async generateJson(){calls++;return options.raw?options.raw():{ok:true,value:{support:true,conflict:false,risk:'low'},usage:nativeUsage}}}as TextGenerator)
 const returned=await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const prepared=(await s.repo.prepare(s.target))!,receipt=repository.review({installationId:s.target.installationId,runId:prepared.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:options.pricing??{inputRate:250000,outputRate:333333}})
  const result=await provider.generateJson({operation:'review_shadow',requestKey:'review:'+prepared.runId,receipt,system:'synthetic',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal})
  return {prepared,receipt,result}
 })
 return {s,repository,provider,...returned,calls:()=>calls}
}
async function drainAssert(repository:ProviderReceiptRepository,installationId:string){const c=await f.runtime.connect();try{await c.query('BEGIN');const r=await repository.assertReceiptDrain(c,installationId);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
async function ledger(installationId:string){return (await f.admin.query('SELECT * FROM memory.memory_provider_receipts WHERE installation_id=$1 ORDER BY original_attempt_id',[installationId])).rows}
async function outbox(installationId:string){return (await f.admin.query('SELECT * FROM memory.memory_usage_outbox WHERE installation_id=$1 ORDER BY usage_id',[installationId])).rows}

let componentFaults:typeof import('./task9-receipt-component-fixture.js').componentFaults

test.each([false,true])('R1 abort-first late callback failure recovers original full receipt, budget failure=%s',async budgetFails=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'}),response=deferred<any>(),started=deferred<void>(),fault=componentFaults(f.runtime);let calls=0,runId='',prepared:any,decision:any
 const provider=budget({async generateJson(){calls++;started.resolve();return response.promise}}as TextGenerator)
 try{
  await withSourceJobExecution(f.runtime,s.fence,async()=>{
   prepared=(await s.repo.prepare(s.target))!;runId=prepared.runId
   const receipt=repository.review({installationId:s.target.installationId,runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{inputRate:250000,outputRate:333333}}),controller=new AbortController()
   const pending=evaluateAutomation(prepared,{provider,receipt,signal:controller.signal,onProviderUsage:async r=>recordReviewProviderUsage(f.runtime,{installationId:s.target.installationId,runId,usage:r.usage,budgetReservationId:r.budgetReservationId})})
   await started.promise
   await expect(drainAssert(repository,s.target.installationId)).rejects.toThrow('provider_receipts_not_drained')
   controller.abort();decision=await pending;expect(decision.reason).toBe('aborted');expect(decision.usage).toBeUndefined();await s.repo.finish(prepared,decision)
  })
  const original=(await ledger(s.target.installationId))[0];expect(original.phase).toBe('pending_original_result')
  fault.sink=true;fault.budget=budgetFails;response.resolve({ok:true,value:{support:true,conflict:false,risk:'low'},usage:nativeUsage})
  expect((await repository.drain.wait(1000)).drained).toBe(true)
  const pending=(await ledger(s.target.installationId))[0];expect(pending.phase).toBe('received');expect(pending.sink_state).toBe('pending')
  expect(Number((await drainAssert(repository,s.target.installationId)).sink_pending_count)).toBe(1)
  expect(await outbox(s.target.installationId)).toHaveLength(0)
  fault.sink=false;fault.budget=false;await repository.flushKnown()
  const final=(await ledger(s.target.installationId))[0],facts=await outbox(s.target.installationId)
  expect(final.original_attempt_id).toBe(original.original_attempt_id);expect(final.budget_reservation_id).toBe(original.budget_reservation_id);expect(final.source_execution_id).toBe(original.source_execution_id)
  expect(final.phase).toBe('received');expect(final.sink_state).toBe('recorded');expect(facts).toHaveLength(1);expect(facts[0].usage_id).toBe('provider-attempt:v1:'+original.original_attempt_id);expect(facts[0].cost_micros).toBe('4')
  expect(facts.some(x=>x.usage_id==='review:'+runId)).toBe(false)
  const b=(await f.admin.query('SELECT b.state,a.state AS attempt_state FROM memory.memory_provider_budget_reservations b JOIN shared.memory_source_provider_attempts a ON a.reservation_id=b.reservation_id WHERE b.reservation_id=$1',[original.budget_reservation_id])).rows[0]
  expect(b).toEqual({state:budgetFails?'reserved':'settled',attempt_state:budgetFails?'uncertain':'accounted'})
  await withSourceJobExecution(f.runtime,s.fence,async()=>{const retry=await evaluateAutomation(prepared,{provider});expect(retry.reason).toBe('provider_result_unknown')})
  expect(calls).toBe(1);expect((await s.repo.currentAdvice(s.target))?.reason).toBe('aborted')
  componentEvidence('r1-'+(budgetFails?'held':'settled'),{original,pending,final,facts,b,calls,decision,physicalFaults:fault.events,reporterStarted:false})
 }finally{fault.central=false;fault.sink=false;fault.budget=false;response.resolve({ok:true,value:{},usage:nativeUsage});await repository.drain.wait(1000);fault.restore()}
})

test('independent COMMIT A survives central SQL failure and lost ACK; recreated repository repairs exact COMMIT B',async()=>{
 const fault=componentFaults(f.runtime);fault.central=true;fault.loseSinkAck=true
 try{
  const r=await callReview();expect(r.result.ok).toBe(false);expect(r.result.providerReceipt).toBeDefined()
  const pending=(await ledger(r.s.target.installationId))[0],facts=await outbox(r.s.target.installationId)
  expect(pending.phase).toBe('pending_original_result');expect(pending.received_model).toBeNull();expect(pending.sink_state).toBe('pending');expect(facts).toHaveLength(1);expect(facts[0].cost_micros).toBe('4');expect(fault.events).toContain('real_sink_commit_ack_lost')
  const observed=(await f.runtime.query('SELECT * FROM memory.read_provider_receipt_drain_v1($1)',[r.s.target.installationId])).rows[0]
  expect(Number(observed.independent_full_preserved_count)).toBe(1);await expect(drainAssert(r.repository,r.s.target.installationId)).rejects.toThrow('provider_receipts_not_drained')
  // Recover only from actual durable anchor+sink; no captured response tuple
  // or new generation/operation identity is supplied by the test observer.
  const identity=Object.fromEntries(RECEIPT_IDENTITY.map(([k])=>[k,pending[k]])) as ReceiptIdentity
  fault.central=false
  const recreated=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'})
  await recreated.reconcile(identity);await recreated.reconcile(identity)
  const final=(await ledger(r.s.target.installationId))[0];expect(final.phase).toBe('received');expect(final.sink_state).toBe('recorded');expect(final.received_model).toBe('task9-synthetic');expect(final.original_attempt_id).toBe(pending.original_attempt_id);expect(await outbox(r.s.target.installationId)).toHaveLength(1);expect(r.calls()).toBe(1)
  componentEvidence('independent-a-b',{pending,facts,observed,final,calls:r.calls(),events:fault.events,repositoryRecreated:true,processCrash:false,reporterStarted:false})
 }finally{fault.central=false;fault.sink=false;fault.restore()}
})

test('both full writes unpersisted block receipt drain; exact live retry preserves first original tuple',async()=>{
 const fault=componentFaults(f.runtime);fault.central=true;fault.sink=true
 try{
  const r=await callReview(),before=(await ledger(r.s.target.installationId))[0]
  expect(before.phase).toBe('pending_original_result');expect(await outbox(r.s.target.installationId)).toHaveLength(0);await expect(drainAssert(r.repository,r.s.target.installationId)).rejects.toThrow('provider_receipts_not_drained')
  fault.central=false;fault.sink=false;await r.repository.flushKnown()
  const final=(await ledger(r.s.target.installationId))[0];expect(final.phase).toBe('received');expect(final.sink_state).toBe('recorded');expect(final.original_attempt_id).toBe(before.original_attempt_id);expect(r.calls()).toBe(1);await drainAssert(r.repository,r.s.target.installationId)
  componentEvidence('r4-primitive-unpreserved',{before,final,calls:r.calls(),nativeModeHook:false,events:fault.events})
 }finally{fault.central=false;fault.sink=false;fault.restore()}
})

test('R3 real sink COMMIT ACK loss plus callback/finish/same retry keeps one exact receipt',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'}),fault=componentFaults(f.runtime);let calls=0
 const provider=budget({async generateJson(){calls++;return {ok:true,value:{support:true,conflict:false,risk:'low'},usage:nativeUsage}}}as TextGenerator)
 try{
  await withSourceJobExecution(f.runtime,s.fence,async()=>{
   const prepared=(await s.repo.prepare(s.target))!,receipt=repository.review({installationId:s.target.installationId,runId:prepared.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{inputRate:250000,outputRate:333333}})
   const decision=await evaluateAutomation(prepared,{provider,receipt,onProviderUsage:async response=>{fault.loseSinkAck=true;await recordReviewProviderUsage(f.runtime,{installationId:s.target.installationId,runId:prepared.runId,usage:response.usage,budgetReservationId:response.budgetReservationId,providerReceipt:response.providerReceipt})}})
   expect(decision).toMatchObject({reason:'provider_result_unknown',billingUncertain:true,usage:nativeUsage})
   await Promise.all([s.repo.finish(prepared,decision),recordReviewProviderUsage(f.runtime,{installationId:s.target.installationId,runId:prepared.runId,usage:decision.usage,budgetReservationId:decision.budgetReservationId,providerReceipt:decision.providerReceipt})])
   expect(await outbox(s.target.installationId)).toHaveLength(1);expect(calls).toBe(1);expect(fault.events).toContain('real_sink_commit_ack_lost')
   componentEvidence('r3-same-ack',{decision,calls,events:fault.events,facts:await outbox(s.target.installationId)})
  })
 }finally{fault.restore()}
})

test.each(['input','output','model','cost','installation','run','reservation','route','price']as const)('R3 conflicting %s commits absorbing conflict then refuses',async field=>{
 const r=await callReview(),handle=r.result.providerReceipt!,identity=providerReceiptIdentity(handle),usage={...nativeUsage},input={installationId:r.s.target.installationId,runId:r.prepared.runId,usage,budgetReservationId:r.result.budgetReservationId,providerReceipt:handle}
 if(field==='input')usage.inputTokens++
 if(field==='output')usage.outputTokens++
 if(field==='model')usage.model='conflicting-model'
 if(field==='cost')usage.costMicros++
 if(field==='installation')input.installationId=r.s.fixture.personal
 if(field==='run')input.runId=randomUUID()
 if(field==='reservation')input.budgetReservationId=randomUUID()
 const before=(await ledger(r.s.target.installationId))[0],facts=await outbox(r.s.target.installationId)
 if(field==='route'||field==='price'){
  const changed={...identity,[field==='route'?'route_fingerprint':'pricing_fingerprint']:Buffer.alloc(32,9)}
  await expect(r.repository.call('receive_provider_receipt_v1',changed,{...nativeUsage,receivedAt:before.received_at.toISOString()})).rejects.toThrow('provider_receipt_conflict')
 }else await expect(recordReviewProviderUsage(f.runtime,input)).rejects.toThrow('provider_receipt_conflict')
 const final=(await ledger(r.s.target.installationId))[0]
 expect(final.conflict_at).not.toBeNull();expect(final.phase).toBe('received');expect(final.received_model).toBe(before.received_model);expect(final.input_tokens).toBe(before.input_tokens);expect(final.cost_micros).toBe(before.cost_micros);expect(await outbox(r.s.target.installationId)).toEqual(facts);expect(r.calls()).toBe(1)
 await expect(drainAssert(r.repository,r.s.target.installationId)).rejects.toThrow('provider_receipts_not_drained')
 componentEvidence('conflict-'+field,{before,final,firstFacts:facts,calls:r.calls(),durableConflict:true})
})

test.each([{pricing:{},cost:null,basis:'unknown'},{pricing:{inputRate:0,outputRate:0},cost:'0',basis:'configured'}])('price presence stays explicit (%j)',async({pricing,cost,basis})=>{
 const r=await callReview({pricing}),row=(await ledger(r.s.target.installationId))[0],facts=await outbox(r.s.target.installationId)
 expect(row.price_basis).toBe(basis);expect(row.cost_micros).toBe(cost);expect(facts[0].cost_micros).toBe(cost);expect(facts[0].price_basis).toBe(basis);expect(facts[0].receipt_protocol).toBe('provider-attempt-v1')
 componentEvidence('price-'+basis,{row,facts,reporterStarted:false})
})

test('finished unknown remains nonreplayable and unresolved, distinct from known sink-pending',async()=>{
 const r=await callReview({raw:async()=>({ok:false,code:'http_error',detail:'timeout',retryable:false})}),row=(await ledger(r.s.target.installationId))[0]
 expect(row.phase).toBe('finished_unknown');expect(row.owner_state).toBe('completed');expect(row.received_model).toBeNull();expect(row.sink_state).toBe('not_applicable');expect(row.unknown_disposition).toBe('unresolved');expect(await outbox(r.s.target.installationId)).toHaveLength(0)
 await expect(drainAssert(r.repository,r.s.target.installationId)).rejects.toThrow('provider_receipts_not_drained')
 componentEvidence('unknown',{row,calls:r.calls(),carrySupported:false})
})

test('original promise registry is bounded and handler-abort is not original drain',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'}),response=deferred<any>(),started=deferred<void>()
 const provider=budget({async generateJson(){started.resolve();return response.promise}}as TextGenerator),controller=new AbortController()
 try{
  await withSourceJobExecution(f.runtime,s.fence,async()=>{
   const p=(await s.repo.prepare(s.target))!,receipt=repository.review({installationId:s.target.installationId,runId:p.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
   const pending=evaluateAutomation(p,{provider,receipt,signal:controller.signal});await started.promise;controller.abort();expect((await pending).reason).toBe('aborted')
  })
  const waiting=await repository.drain.wait(10);expect(waiting.drained).toBe(false);expect(waiting.activeOriginal).toBe(1);expect(waiting.activeBusiness).toBe(1)
  componentEvidence('bounded-drain',{waiting,nativeShutdownWired:false})
 }finally{response.resolve({ok:true,value:{support:true,conflict:false,risk:'low'},usage:nativeUsage});expect((await repository.drain.wait(1000)).drained).toBe(true)}
})

test('malformed review operation/key refuses before reservation or provider IO',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'});let calls=0;const key=randomUUID(),provider=budget({async generateJson(){calls++;throw Error('must_not_call')}}as TextGenerator,key)
 await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const p=(await s.repo.prepare(s.target))!,receipt=repository.review({installationId:s.target.installationId,runId:p.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
  for(const operation of ['review_shadow','candidate_extract']as const)await expect(provider.generateJson({operation,requestKey:'review:'+randomUUID(),receipt,system:'synthetic',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal})).rejects.toThrow('receipt_budget_identity_mismatch')
 })
 expect(calls).toBe(0);expect((await f.admin.query('SELECT 1 FROM memory.memory_provider_budget_reservations WHERE budget_key=$1',[key])).rowCount).toBe(0)
})

test('unbudgeted provider is refused by explicit review enrollment without IO',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'});let calls=0
 await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const p=(await s.repo.prepare(s.target))!,receipt=repository.review({installationId:s.target.installationId,runId:p.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
  const d=await evaluateAutomation(p,{receipt,provider:{async generateJson(){calls++;throw Error('must_not_call')}}})
  expect(d.reason).toBe('receipt_budget_required')
 });expect(calls).toBe(0)
})

test('runtime has finite function capability and zero direct table/column access; malformed ACL is detected',async()=>{
 const roles={runtimeRole:f.roles.memoryRole,relayRole:f.roles.relayRole,ownerRole:f.roles.migratorRole}
 const audit=await auditProviderReceiptComponent(f.runtime,roles);expect(audit.functions).toHaveLength(8)
 await expect(f.runtime.query('SELECT original_attempt_id FROM memory.memory_provider_receipts LIMIT 1')).rejects.toMatchObject({code:'42501'})
 await expect(f.runtime.query("UPDATE memory.memory_provider_receipts SET phase='received'")).rejects.toMatchObject({code:'42501'})
 try{
  await f.admin.query(`GRANT SELECT(original_attempt_id) ON memory.memory_provider_receipts TO ${f.roles.memoryRole}`)
  await expect(auditProviderReceiptComponent(f.runtime,roles)).rejects.toThrow('receipt_runtime_acl_invalid')
 }finally{await f.admin.query(`REVOKE SELECT(original_attempt_id) ON memory.memory_provider_receipts FROM ${f.roles.memoryRole}`)}
 componentEvidence('acl',await auditProviderReceiptComponent(f.runtime,roles))
})

test('a local purged flag cannot substitute for the unimplemented native purge disposition',async()=>{
 const r=await callReview(),row=(await ledger(r.s.target.installationId))[0],identity=providerReceiptIdentity(r.result.providerReceipt!)
 await f.admin.query("UPDATE memory.memory_installations SET local_status='purged' WHERE installation_id=$1",[r.s.target.installationId])
 const result=await r.repository.call('commit_provider_sink_independent_v1',identity,{...nativeUsage,receivedAt:row.received_at.toISOString()})
 expect(result,'native Task7 proof is not implemented in this first component').toBe('purge_disposition_required')
})

test('original promise is registered before the actual synthetic provider dispatch starts',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'});let observed=-1
 const provider=budget({async generateJson(){observed=repository.drain.counts().activeOriginal;return {ok:true,value:{support:true,conflict:false,risk:'low'},usage:nativeUsage}}}as TextGenerator)
 await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const p=(await s.repo.prepare(s.target))!,receipt=repository.review({installationId:s.target.installationId,runId:p.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
  await provider.generateJson({operation:'review_shadow',requestKey:'review:'+p.runId,receipt,system:'synthetic',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal})
 });expect(observed,'original provider work must already have a drain owner before dispatch').toBe(1)
})

test('a valid review key for run B cannot escape its job-bound subject under job A',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'})
 const second=await createPromotionService(f.runtime).propose({...s.fixture.proposeInput,idempotencyDigest:randomUUID()})
 expect(second.candidate.candidate_id).not.toBe(s.target.candidateId)
 const targetB={...s.target,candidateId:second.candidate.candidate_id},jobB=randomUUID()
 await f.runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at,payload) VALUES($1,$2,'evaluate_review_shadow',$1::uuid::text,85,'running','task9-worker',1,clock_timestamp()+interval '5 minutes',$3::jsonb)",[jobB,s.target.installationId,JSON.stringify({subject_kind:'promotion',candidate_id:targetB.candidateId})])
 const preparedA=await withSourceJobExecution(f.runtime,s.fence,async()=>s.repo.prepare(s.target))
 const preparedB=await withSourceJobExecution(f.runtime,{...s.fence,jobId:jobB},async()=>s.repo.prepare(targetB))
 expect(preparedA!.runId).not.toBe(preparedB!.runId)
 await withSourceJobExecution(f.runtime,s.fence,async()=>{
  const requestKey='review:'+preparedB!.runId
  const held=await createProviderBudgetStore(f.runtime).reserve({key:randomUUID(),requestKey,kind:'text',inputTokens:1500,outputTokens:100,maxRequests:10,maxInputTokens:10000,maxOutputTokens:1000})
  if(!held.ok)throw Error('fixture_reservation_failed')
  const {startSourceProviderAttempt}=await import('../../sources/source-execution.js');await startSourceProviderAttempt(held.reservationId,requestKey)
  const receipt=repository.review({installationId:s.target.installationId,runId:preparedB!.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
  componentEvidence('job-run-mismatch',{installationId:s.target.installationId,jobA:s.jobId,jobB,runA:preparedA!.runId,runB:preparedB!.runId,candidateA:s.target.candidateId,candidateB:targetB.candidateId,reservation:held.reservationId,originalRequestKey:requestKey,noProviderInvoked:true})
  await expect(repository.admit(receipt,held.reservationId)).rejects.toThrow('receipt_original_run_job_unproved')
 })
})

test('receipt drain proof requires an explicit transaction on the same physical client',async()=>{
 const repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'}),c=await f.runtime.connect()
 try{await expect(repository.assertReceiptDrain(c,randomUUID())).rejects.toThrow('receipt_drain_requires_transaction')}finally{c.release()}
})

test('admission holds original job payload through physical COMMIT; late fees use captured anchor',async()=>{
 const s=await f.review(),repository=new ProviderReceiptRepository(f.runtime,{enrollment:'explicit-isolated-review-component',reporter:'not-started'}),admitted=deferred<void>(),release=deferred<void>(),started=deferred<void>(),response=deferred<any>()
 const other=await createPromotionService(f.runtime).propose({...s.fixture.proposeInput,idempotencyDigest:randomUUID()})
 const fault=componentFaults(f.runtime,{afterAdmissionSql:async()=>{admitted.resolve();await release.promise}}),blocker=await f.admin.connect();let originalRun=''
 const provider=budget({async generateJson(){started.resolve();return response.promise}}as TextGenerator)
 const pending=withSourceJobExecution(f.runtime,s.fence,async()=>{
  const p=(await s.repo.prepare(s.target))!;originalRun=p.runId
  const receipt=repository.review({installationId:s.target.installationId,runId:p.runId,jobId:s.jobId,claimEpoch:1,provider:'synthetic',model:'task9-synthetic',routeFingerprint:Buffer.alloc(32,1),pricing:{}})
  return provider.generateJson({operation:'review_shadow',requestKey:'review:'+p.runId,receipt,system:'synthetic',document:{},schema:{},timeoutMs:1000,signal:new AbortController().signal})
 })
 try{
  await admitted.promise;await blocker.query('BEGIN');await blocker.query("SET LOCAL lock_timeout='100ms'")
  const payload=JSON.stringify({subject_kind:'promotion',candidate_id:other.candidate.candidate_id})
  await expect(blocker.query('UPDATE memory.memory_jobs SET payload=$2::jsonb WHERE job_id=$1',[s.jobId,payload])).rejects.toMatchObject({code:'55P03'})
  await blocker.query('ROLLBACK');release.resolve();await started.promise
  // No lock is held across provider IO. Changed current payload cannot become
  // a different fee owner or erase the original receipt after dispatch.
  await f.admin.query('UPDATE memory.memory_jobs SET payload=$2::jsonb WHERE job_id=$1',[s.jobId,payload])
  response.resolve({ok:true,value:{support:true,conflict:false,risk:'low'},usage:nativeUsage});await pending
  const row=(await ledger(s.target.installationId))[0];expect(row.business_run_id).toBe(originalRun);expect(row.original_job_id).toBe(s.jobId);expect(row.phase).toBe('received');expect(row.sink_state).toBe('recorded')
  expect((await f.runtime.query('SELECT 1 FROM memory_review_automation_decisions WHERE run_id=$1',[originalRun])).rowCount).toBe(0)
  componentEvidence('job-payload-commit-lock',{jobId:s.jobId,originalRun,blockedUpdateCode:'55P03',currentCandidate:other.candidate.candidate_id,row,positiveOutputPublished:false,historyReparented:false})
 }finally{release.resolve();response.resolve({ok:true,value:{},usage:nativeUsage});await blocker.query('ROLLBACK');blocker.release();await pending.catch(()=>{});fault.restore()}
})
})
