import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
let task9Fixture:typeof import('./task9-receipt-drain-fixture.js').task9Fixture
let task9Evidence:typeof import('./task9-receipt-drain-fixture.js').task9Evidence
import {withTextProviderBudget,createProviderBudgetStore} from '../../model/provider-budget.js'
import {evaluateAutomation} from '../../governance/automation-evaluator.js'
import {recordReviewProviderUsage} from '../../generation/provider-effect.js'
import {withSourceJobExecution,guardSourceExecutionCommit} from '../../sources/source-execution.js'
import type {TextGenerator,ModelJsonResult} from '../../ports/text-generator.js'
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
const usage={model:'task9-synthetic',inputTokens:12,outputTokens:3,costMicros:4}
// RED contracts: late failed full-receipt bookkeeping needs an original-promise
// recovery owner; settled/accounted alone must not pass producer mode drain.
const privateSuite=process.env.RUN_PRIVATE_SHARED_RECEIPT_TESTS==='1'?describe:describe.skip
privateSuite('Task9 real budget/review receipt and drain integration RED',()=>{
 let f:Awaited<ReturnType<typeof task9Fixture>>
 beforeAll(async()=>{({task9Fixture,task9Evidence}=await import('./task9-receipt-drain-fixture.js'));f=await task9Fixture()},60000)
 afterAll(async()=>{await f?.close()})
 const wrap=(provider:TextGenerator,key:string)=>withTextProviderBudget(provider,createProviderBudgetStore(f.runtime),{key,maxRequests:10,maxInputTokens:1000000,maxOutputTokens:10000,maxOutputTokensPerRequest:100})
 const rows=async(jobId:string)=>(await f.admin.query(`SELECT a.execution_id,a.reservation_id,a.state AS attempt_state,e.job_id,e.installation_id,e.generation::text,e.claim_epoch::text,b.state AS budget_state,b.actual_input_tokens::text,b.actual_output_tokens::text,b.reserved_input_tokens::text,b.reserved_output_tokens::text FROM shared.memory_source_provider_attempts a JOIN shared.memory_source_executions e USING(execution_id) JOIN memory.memory_provider_budget_reservations b USING(reservation_id) WHERE e.job_id=$1`,[jobId])).rows
 test.each([false,true])('R1 abort-first recovers original late full receipt after SQL recovery (budget settlement fails=%s)',async settleFails=>{
  const s=await f.review(),key=randomUUID(),response=deferred<ModelJsonResult<unknown>>(),started=deferred<void>(),callbackDone=deferred<void>()
  let calls=0,callbacks=0,callbackFailure='',original:any,received:any,prepared:any
  const provider=wrap({async generateJson(){calls++;original=(await rows(s.jobId))[0];started.resolve();return response.promise}}as TextGenerator,key)
  const receiptFunction='task9_reject_receipt_'+(settleFails?'held':'settled'),budgetFunction='task9_reject_budget'
  await f.admin.query(`CREATE FUNCTION memory.${receiptFunction}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.installation_id='${s.target.installationId}'::uuid THEN RAISE EXCEPTION 'task9_synthetic_receipt_failure';END IF;RETURN NEW;END$$;CREATE TRIGGER ${receiptFunction} BEFORE INSERT ON memory.memory_usage_outbox FOR EACH ROW EXECUTE FUNCTION memory.${receiptFunction}()`)
  if(settleFails)await f.admin.query(`CREATE FUNCTION memory.${budgetFunction}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.budget_key='${key}' THEN RAISE EXCEPTION 'task9_synthetic_budget_failure';END IF;RETURN NEW;END$$;CREATE TRIGGER ${budgetFunction} BEFORE UPDATE ON memory.memory_provider_budget_reservations FOR EACH ROW EXECUTE FUNCTION memory.${budgetFunction}()`)
  try{
   const controller=new AbortController()
   const decision=await withSourceJobExecution(f.runtime,s.fence,async()=>{
    prepared=(await s.repo.prepare(s.target))!
    const pending=evaluateAutomation(prepared,{provider,signal:controller.signal,onProviderUsage:async r=>{callbacks++;received=r;try{await recordReviewProviderUsage(f.runtime,{installationId:prepared.installationId,runId:prepared.runId,usage:r.usage,budgetReservationId:r.budgetReservationId})}catch(e){callbackFailure=(e as Error).message;throw e}finally{callbackDone.resolve()}}})
    await started.promise;expect(original.attempt_state).toBe('inflight');expect(original.budget_state).toBe('reserved')
    controller.abort();const d=await pending;expect(d).toMatchObject({recommendation:'deferred',reason:'aborted'});expect(d.usage).toBeUndefined();await s.repo.finish(prepared,d);return d
   })
   response.resolve({ok:true,value:{support:true,conflict:false,risk:'low'},usage});await callbackDone.promise
   expect(callbackFailure).toBe('task9_synthetic_receipt_failure')
   await f.admin.query(`DROP TRIGGER ${receiptFunction} ON memory.memory_usage_outbox;DROP FUNCTION memory.${receiptFunction}()`)
   if(settleFails)await f.admin.query(`DROP TRIGGER ${budgetFunction} ON memory.memory_provider_budget_reservations;DROP FUNCTION memory.${budgetFunction}()`)
   // The real cancelled decision has no later response. Repeating ordinary
   // finish cannot smuggle the test observer's captured late tuple into it.
   await s.repo.finish(prepared,decision);await new Promise(r=>setTimeout(r,100))
   const state=await rows(s.jobId),receipts=(await f.runtime.query('SELECT usage_id,model,input_tokens::text,output_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1',[s.target.installationId])).rows
   expect(calls).toBe(1);expect(callbacks).toBe(1);expect(received.budgetReservationId).toBe(original.reservation_id);expect(received.usage).toEqual(usage)
   expect(state).toHaveLength(1);expect(state[0].execution_id).toBe(original.execution_id);expect(state[0].reservation_id).toBe(original.reservation_id)
   expect(state[0].attempt_state).toBe(settleFails?'uncertain':'accounted');expect(state[0].budget_state).toBe(settleFails?'reserved':'settled')
   if(!settleFails)expect(state[0].actual_input_tokens).toBe('12')
   const repeated=await withSourceJobExecution(f.runtime,s.fence,async()=>evaluateAutomation(prepared,{provider}));expect(repeated.reason).toBe('provider_result_unknown');expect(calls).toBe(1)
   expect((await f.runtime.query("SELECT 1 FROM memory_review_automation_decisions WHERE run_id=$1 AND recommendation IN('eligible_auto','needs_human')",[prepared.runId])).rowCount).toBe(0)
   task9Evidence('task9-r1-'+(settleFails?'budget-held':'budget-settled'),{original,runId:prepared.runId,received:{usage:received.usage,reservationId:received.budgetReservationId},state,receipts,callbackFailure,calls,callbacks,decision,repeated})
   expect(receipts,'known late full receipt must recover once under its original review identity after SQL recovery').toEqual([{usage_id:'review:'+prepared.runId,model:'task9-synthetic',input_tokens:'12',output_tokens:'3',cost_micros:'4'}])
  }finally{
   await f.admin.query(`DROP TRIGGER IF EXISTS ${receiptFunction} ON memory.memory_usage_outbox;DROP FUNCTION IF EXISTS memory.${receiptFunction}()`)
   if(settleFails)await f.admin.query(`DROP TRIGGER IF EXISTS ${budgetFunction} ON memory.memory_provider_budget_reservations;DROP FUNCTION IF EXISTS memory.${budgetFunction}()`)
  }
 })
 test('R4 nonpaused transition refuses known pending full receipt after attempt becomes accounted',async()=>{
  const s=await f.review(),response=deferred<ModelJsonResult<unknown>>(),started=deferred<void>(),receiptStarted=deferred<void>(),releaseReceipt=deferred<void>(),receiptDone=deferred<void>(),key=randomUUID()
  let calls=0,prepared:any,transition:any
  const provider=wrap({async generateJson(){calls++;started.resolve();return response.promise}}as TextGenerator,key)
  const controller=new AbortController()
  await withSourceJobExecution(f.runtime,s.fence,async()=>{
   prepared=(await s.repo.prepare(s.target))!
   const pending=evaluateAutomation(prepared,{provider,signal:controller.signal,onProviderUsage:async r=>{receiptStarted.resolve();await releaseReceipt.promise;try{await recordReviewProviderUsage(f.runtime,{installationId:prepared.installationId,runId:prepared.runId,usage:r.usage,budgetReservationId:r.budgetReservationId})}finally{receiptDone.resolve()}}})
   await started.promise;controller.abort();const decision=await pending;await s.repo.finish(prepared,decision)
   response.resolve({ok:true,value:{support:true,conflict:false,risk:'low'},usage});await receiptStarted.promise
   try{
    const state=await rows(s.jobId);expect(state[0].budget_state).toBe('settled');expect(state[0].attempt_state).toBe('accounted')
    expect((await f.runtime.query('SELECT 1 FROM memory_usage_outbox WHERE installation_id=$1',[s.target.installationId])).rowCount).toBe(0)
    await f.admin.query("SELECT shared.transition_memory_source_mode($1,1,'paused')",[s.target.installationId])
    const c=await f.runtime.connect();try{await c.query('BEGIN');await expect(guardSourceExecutionCommit(c)).rejects.toThrow('source_execution_generation_changed')}finally{await c.query('ROLLBACK');c.release()}
    transition=await f.admin.query("SELECT shared.transition_memory_source_mode($1,2,'legacy-feed') AS generation",[s.target.installationId]).then(r=>({ok:true,generation:r.rows[0].generation}),e=>({ok:false,message:e.message}))
    task9Evidence('task9-r4-mode-gap',{state,runId:prepared.runId,calls,fullReceiptPending:true,transition})
    expect(transition,'known received full receipt is still pending although its source attempt is budget-accounted').toEqual({ok:false,message:'source_executions_not_drained'})
   }finally{releaseReceipt.resolve();await receiptDone.promise;task9Evidence('task9-r4-after-receipt',{originalState:await rows(s.jobId),receipts:(await f.runtime.query('SELECT usage_id,model,input_tokens::text,output_tokens::text,cost_micros::text FROM memory_usage_outbox WHERE installation_id=$1',[s.target.installationId])).rows,calls})}
  })
 })
})
