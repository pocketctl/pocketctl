import { expect, test } from 'vitest'
import { confirmedDeliveryReceipt } from '../teamDeliveryRecovery'
const op = { kind: 'acceptance' as const, input: { request_id: 'key', expected_revision: 2, spec_revision: 1, submission_id: 'submission', decision: 'accepted' as const, reason: '', verified_checks: ['unit'] } }
const missing = { task_id: 'task', request_id: 'key', found: false, receipt: null }
const committed = { ...missing, found: true, receipt: { operation: 'acceptance', response: { revision: 3, submission_id: 'submission', decision: 'accepted', decision_id: 'decision' } } }
test('only explicit, identity-bound absence enables retry', () => {
 expect(confirmedDeliveryReceipt(missing, 'task', op)).toBe(false)
 for (const result of [null, {}, { ...missing, task_id: 'other' }, { ...missing, request_id: 'other' }, { ...missing, found: undefined }, { ...missing, receipt: {} }, { ...missing, found: true }]) expect(() => confirmedDeliveryReceipt(result, 'task', op)).toThrow()
})
test('accepted receipt must match decision, submission, revision and operation', () => {
 expect(confirmedDeliveryReceipt(committed, 'task', op)).toBe(true)
 for (const patch of [{ revision: 4 }, { submission_id: 'other' }, { decision: 'changes_requested' }, { decision_id: '' }]) expect(() => confirmedDeliveryReceipt({ ...committed, receipt: { ...committed.receipt, response: { ...committed.receipt.response, ...patch } } }, 'task', op)).toThrow()
 expect(() => confirmedDeliveryReceipt({ ...committed, receipt: { ...committed.receipt, operation: 'execute_task' } }, 'task', op)).toThrow()
})
test('execution receipt must match frozen spec and unique Call count', () => {
 const execution = { kind: 'execute_task' as const, input: { request_id: 'key', expected_revision: 2, spec_revision: 3, context_version: 5, target_offer_ids: ['a', 'b'] } }
 const response = { revision: 3, spec_revision: 3, call_ids: ['a-call', 'b-call'] }
 const value = (patch: object) => ({ ...committed, receipt: { operation: 'execute_task', response: { ...response, ...patch } } })
 expect(confirmedDeliveryReceipt(value({}), 'task', execution)).toBe(true)
 for (const patch of [{ spec_revision: 2 }, { call_ids: ['a-call'] }, { call_ids: ['a-call', 'a-call'] }, { call_ids: ['a-call', ''] }]) expect(() => confirmedDeliveryReceipt(value(patch), 'task', execution)).toThrow()
})

test('plan controls require exact plan, revision, state and issued-call scope',()=>{
 const op={kind:'plan_control' as const,input:{request_id:'pause',expected_revision:3,plan_revision:2,action:'pause' as const}}
 const response={task_id:'task',revision:4,plan_revision:2,state:'paused',issued_calls_stopped:false}
 const receipt=(patch:object)=>({task_id:'task',request_id:'pause',found:true,receipt:{operation:'plan_control',response:{...response,...patch}}})
 expect(confirmedDeliveryReceipt(receipt({}),'task',op)).toBe(true)
 for(const patch of [{task_id:'other'},{revision:5},{plan_revision:3},{state:'active'},{issued_calls_stopped:true}])expect(()=>confirmedDeliveryReceipt(receipt(patch),'task',op)).toThrow()
})

test('step receipt absence and success must prove the original exact attempt',()=>{
 const op={kind:'acceptance' as const,attemptId:'attempt',input:{request_id:'key',expected_revision:2,spec_revision:1,submission_id:'s',decision:'accepted' as const,reason:'',verified_checks:[]}}
 const missing={task_id:'task',request_id:'key',found:false,receipt:null}
 expect(()=>confirmedDeliveryReceipt(missing,'task',op)).toThrow();expect(confirmedDeliveryReceipt({...missing,attempt_id:'attempt'},'task',op)).toBe(false)
 const success={...missing,attempt_id:'attempt',found:true,receipt:{operation:'acceptance',response:{revision:3,submission_id:'s',decision:'accepted',decision_id:'d'}}}
 expect(()=>confirmedDeliveryReceipt(success,'task',op)).toThrow();expect(confirmedDeliveryReceipt({...success,receipt:{...success.receipt,response:{...success.receipt.response,attempt_id:'attempt'}}},'task',op)).toBe(true)
})

test('reconcile receipt must preserve original attempt Call and runtime without new work',()=>{
 const op={kind:'plan_control' as const,expectedState:'cancelled',expectedCallId:'original',input:{action:'reconcile' as const,attempt_id:'attempt',request_id:'request',expected_revision:2,plan_revision:1}}
 const response={task_id:'task',revision:3,plan_revision:1,state:'cancelled',issued_calls_stopped:false,recovery:{attempt_id:'attempt',call_id:'original',new_call_created:false}}
 const value={task_id:'task',request_id:'request',found:true,receipt:{operation:'plan_control',response}}
 expect(confirmedDeliveryReceipt(value,'task',op)).toBe(true)
 for(const recovery of [{...response.recovery,call_id:'other'},{...response.recovery,attempt_id:'other'},{...response.recovery,new_call_created:true}]) expect(()=>confirmedDeliveryReceipt({...value,receipt:{...value.receipt,response:{...response,recovery}}},'task',op)).toThrow()
})

test.each(['retry','new_version'] as const)('%s receipt pins previous attempt and requires a distinct new attempt and Call',(action)=>{
 const attempt='aaaaaaaa-1111-4111-8111-111111111111',next='bbbbbbbb-1111-4111-8111-111111111111'
 const op={kind:'plan_control' as const,expectedState:'active',expectedCallId:'original',input:{action,attempt_id:attempt,expected_delivery_revision:4,request_id:'request',expected_revision:2,plan_revision:1}}
 const response={task_id:'task',revision:3,plan_revision:1,state:'active',issued_calls_stopped:false,recovery:{previous_attempt_id:attempt,attempt_id:next,call_id:'new-call',attempt_state:'reserved'}}
 const value={task_id:'task',request_id:'request',found:true,receipt:{operation:'plan_control',response}}
 expect(confirmedDeliveryReceipt(value,'task',op)).toBe(true)
 for(const recovery of [{...response.recovery,previous_attempt_id:next},{...response.recovery,attempt_id:attempt},{...response.recovery,call_id:'original'}])expect(()=>confirmedDeliveryReceipt({...value,receipt:{...value.receipt,response:{...response,recovery}}},'task',op)).toThrow()
})

test('activation receipt must preserve the explicit immutable invocation budget',()=>{
 const op={kind:'plan_control' as const,input:{request_id:'activate',expected_revision:0,plan_revision:2,action:'activate' as const,invocation_limit:3}}
 const value={task_id:'task',request_id:'activate',found:true,receipt:{operation:'plan_control',response:{task_id:'task',revision:1,plan_revision:2,state:'active',invocation_limit:3,issued_calls_stopped:false}}}
 expect(confirmedDeliveryReceipt(value,'task',op)).toBe(true)
 for(const invocation_limit of [undefined,4])expect(()=>confirmedDeliveryReceipt({...value,receipt:{...value.receipt,response:{...value.receipt.response,invocation_limit}}},'task',op)).toThrow()
})

test('adoption receipt must remain paused on the chosen revision',()=>{
 const op={kind:'plan_control' as const,input:{request_id:'adopt',expected_revision:2,plan_revision:3,action:'adopt_revision' as const}}
 const result={task_id:'task',request_id:'adopt',found:true,receipt:{operation:'plan_control',response:{task_id:'task',revision:3,plan_revision:3,state:'paused',issued_calls_stopped:false}}}
 expect(confirmedDeliveryReceipt(result,'task',op)).toBe(true)
 expect(()=>confirmedDeliveryReceipt({...result,receipt:{...result.receipt,response:{...result.receipt.response,state:'active'}}},'task',op)).toThrow()
})

test('activation receipts must echo the exact optional budget before the journal can clear',()=>{
 const op={kind:'plan_control' as const,input:{request_id:'budget',expected_revision:0,plan_revision:2,action:'activate' as const,invocation_limit:3,budget:{max_concurrent_calls:2,max_duration_seconds:3600,token_warning_limit:12000}}}
 const response:any={task_id:'task',revision:1,plan_revision:2,state:'active',invocation_limit:3,issued_calls_stopped:false,budget:{token_warning_limit:12000,max_duration_seconds:3600,max_concurrent_calls:2}}
 const receipt=()=>({task_id:'task',request_id:'budget',found:true,receipt:{operation:'plan_control',response}})
 expect(confirmedDeliveryReceipt(receipt(),'task',op)).toBe(true)
 response.budget.max_duration_seconds=3601;expect(()=>confirmedDeliveryReceipt(receipt(),'task',op)).toThrow()
 delete response.budget;expect(()=>confirmedDeliveryReceipt(receipt(),'task',op)).toThrow()
})

test('omitted activation budget accepts old receipts but rejects unexpected limits',()=>{
 const op={kind:'plan_control' as const,input:{request_id:'no-budget',expected_revision:0,plan_revision:2,action:'activate' as const,invocation_limit:3}}
 const response:any={task_id:'task',revision:1,plan_revision:2,state:'active',invocation_limit:3,issued_calls_stopped:false}
 const receipt=()=>({task_id:'task',request_id:'no-budget',found:true,receipt:{operation:'plan_control',response}})
 expect(confirmedDeliveryReceipt(receipt(),'task',op)).toBe(true)
 response.budget={};expect(confirmedDeliveryReceipt(receipt(),'task',op)).toBe(true)
 response.budget={max_concurrent_calls:1};expect(()=>confirmedDeliveryReceipt(receipt(),'task',op)).toThrow()
})

test('artifact revocation receipt binds operation target and attempt',()=>{
 const op={kind:'revoke_artifact' as const,submissionId:'s',artifactId:'a',attemptId:'11111111-1111-4111-8111-111111111111',input:{request_id:'r',expected_revision:2,reason:'wrong'}}
 const result={task_id:'t',request_id:'r',attempt_id:op.attemptId,found:true,receipt:{operation:'revoke:s:a',response:{revision:3,artifact_id:'a',state:'revoked',attempt_id:op.attemptId}}}
 expect(confirmedDeliveryReceipt(result,'t',op)).toBe(true)
 for(const patch of [{artifact_id:'other'},{state:'published'},{attempt_id:undefined}])expect(()=>confirmedDeliveryReceipt({...result,receipt:{...result.receipt,response:{...result.receipt.response,...patch}}},'t',op)).toThrow()
 expect(()=>confirmedDeliveryReceipt({...result,receipt:{...result.receipt,operation:'revoke:other:a'}},'t',op)).toThrow()
})
