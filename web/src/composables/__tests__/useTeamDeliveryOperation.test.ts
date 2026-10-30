import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useTeamDeliveryOperation } from '../useTeamDeliveryOperation'
import { TeamDeliveryOperationJournal } from '../../services/teamDeliveryOperationJournal'
import { TeamApiError } from '../../services/teamClient'
const user=ref<{id:number}|null>({id:1}),origin=ref('relay-a')
vi.mock('../useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../useEnv',()=>({getRelayOrigin:()=>origin.value}))
const api=vi.hoisted(()=>({decideTaskDelivery:vi.fn(),reviseDeliverySpec:vi.fn(),executeDeliveryTask:vi.fn(),getDeliveryReceipt:vi.fn()}))
vi.mock('../../services/teamDeliveryClient',()=>api)
const planAPI=vi.hoisted(()=>({controlTaskPlan:vi.fn(),getTaskPlanControlReceipt:vi.fn(),saveTaskPlanDraft:vi.fn(),getTaskPlanDraftReceipt:vi.fn()}))
vi.mock('../../services/teamPlanClient',()=>planAPI)
const decision={kind:'acceptance' as const,input:{request_id:'key',expected_revision:2,spec_revision:1,submission_id:'submission',decision:'accepted' as const,reason:'',verified_checks:['unit']}}
const execution={kind:'execute_task' as const,session:'session',input:{request_id:'run',expected_revision:2,spec_revision:1,context_version:6,target_offer_ids:['offer']}}
const result={revision:3,submission_id:'submission',decision:'accepted',decision_id:'decision'}
const wrappers:Array<ReturnType<typeof mount>>=[]
const scope=JSON.stringify(['relay-a',1])
const records=()=>new TeamDeliveryOperationJournal().load(scope,'task')
async function render(){let state!:ReturnType<typeof useTeamDeliveryOperation>;const complete=vi.fn(),denied=vi.fn();const w=mount(defineComponent({setup(){state=useTeamDeliveryOperation(()=> 'task',()=>1,complete,denied);return()=>null}}));wrappers.push(w);await vi.waitFor(()=>expect(state.ready.value||!!state.storageError.value||state.revoked.value).toBe(true));return {state,complete,denied,w}}
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto);user.value={id:1};origin.value='relay-a';sessionStorage.clear();api.decideTaskDelivery.mockResolvedValue(result);api.executeDeliveryTask.mockResolvedValue({revision:3,spec_revision:1,call_ids:['call']})})
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.unstubAllGlobals()})
test('a truncated response persists through closed component and restored journal; query does not send again',async()=>{
 api.decideTaskDelivery.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}));const one=await render();await one.state.submit(decision);one.w.unmount();sessionStorage.clear()
 const next=await render();expect(next.state.pending.value?.operation).toEqual(decision)
 api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:'key',found:true,receipt:{operation:'acceptance',response:result}})
 await next.state.resolve();expect(next.complete).toHaveBeenCalledTimes(1);expect(api.decideTaskDelivery).toHaveBeenCalledTimes(1);expect(await records()).toEqual([])
})
test('decision and execution controllers cannot both create different operations for the same task',async()=>{
 api.decideTaskDelivery.mockRejectedValueOnce(new TypeError('lost'));api.executeDeliveryTask.mockRejectedValueOnce(new TypeError('lost'))
 const a=await render(),b=await render();await Promise.all([a.state.submit(decision),b.state.submit(execution)])
 expect(api.decideTaskDelivery.mock.calls.length+api.executeDeliveryTask.mock.calls.length).toBe(1);expect(await records()).toHaveLength(1)
})
test('identity change during a request never publishes success or deletes the old intent',async()=>{
 let resolve!:(value:unknown)=>void;api.decideTaskDelivery.mockReturnValueOnce(new Promise(r=>resolve=r))
 const c=await render(),work=c.state.submit(decision);await vi.waitFor(()=>expect(api.decideTaskDelivery).toHaveBeenCalledTimes(1))
 user.value={id:2};await flushPromises();resolve(result);await work
 expect(c.complete).not.toHaveBeenCalled();expect(await records()).toHaveLength(1);expect(c.state.revoked.value).toBe(true)
 expect(api.decideTaskDelivery.mock.calls[0][2]).toEqual({userId:1,origin:'relay-a'})
})
test('wrong success payload remains unknown and cannot enable a different operation',async()=>{
 api.decideTaskDelivery.mockResolvedValueOnce({...result,submission_id:'other'});const c=await render();await c.state.submit(decision)
 expect(c.complete).not.toHaveBeenCalled();expect(c.state.pending.value?.operation).toEqual(decision);await c.state.submit(execution);expect(api.executeDeliveryTask).not.toHaveBeenCalled();expect(await records()).toHaveLength(1)
})
test('retry requires explicit missing receipt plus confirmation and reuses original payload',async()=>{
 api.executeDeliveryTask.mockRejectedValueOnce(new TypeError('lost'));const c=await render();await c.state.submit(execution)
 c.state.confirmRetry.value=true;await c.state.retry();expect(api.executeDeliveryTask).toHaveBeenCalledTimes(1)
 api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:'run',found:false,receipt:null});await c.state.resolve();await c.state.retry();expect(api.executeDeliveryTask).toHaveBeenCalledTimes(1)
 c.state.confirmRetry.value=true;await c.state.retry();expect(api.executeDeliveryTask.mock.calls[1]).toEqual(api.executeDeliveryTask.mock.calls[0]);expect(await records()).toEqual([])
})
test('legacy acceptance and management are migrated before cleanup, then reconciled in order',async()=>{
 sessionStorage.setItem('team-delivery:relay-a:1:task',JSON.stringify(decision.input));sessionStorage.setItem('team-delivery-management:relay-a:1:task',JSON.stringify(execution))
 const c=await render();expect(await records()).toHaveLength(2);expect(sessionStorage.length).toBe(0)
 api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:'key',found:true,receipt:{operation:'acceptance',response:result}});await c.state.resolve()
 expect(c.state.pending.value?.operation).toEqual(execution);expect(await records()).toHaveLength(1);expect(api.decideTaskDelivery).not.toHaveBeenCalled()
})
test('failed migration keeps legacy bytes and blocks all new writes',async()=>{
 sessionStorage.setItem('team-delivery:relay-a:1:task','{broken');const c=await render();expect(c.state.ready.value).toBe(false)
 await c.state.submit(execution);expect(api.executeDeliveryTask).not.toHaveBeenCalled();expect(sessionStorage.getItem('team-delivery:relay-a:1:task')).toBe('{broken')
})
test('a mismatched spec revision success does not clear the frozen revision intent',async()=>{
 const op={kind:'revise_spec' as const,specRevision:3,input:{request_id:'revise',expected_revision:8,goal:'goal',acceptance:'proof',policy:{reviewer_user_id:2,primary_offer_id:'offer',required_checks:[]}}}
 api.reviseDeliverySpec.mockResolvedValue({revision:9,spec_revision:3});const c=await render();await c.state.submit(op);expect(c.complete).not.toHaveBeenCalled();expect(await records()).toHaveLength(1)
})
test('a storage event switching accounts fences actions even before auth store updates',async()=>{
 const c=await render();window.dispatchEvent(new StorageEvent('storage',{key:'pocketctl_user',newValue:'{"id":2}'}));await c.state.submit(decision)
 expect(c.state.revoked.value).toBe(true);expect(api.decideTaskDelivery).not.toHaveBeenCalled()
})

const pause={kind:'plan_control' as const,input:{request_id:'pause-original',expected_revision:4,plan_revision:2,action:'pause' as const}}
const paused={task_id:'task',revision:5,plan_revision:2,state:'paused',issued_calls_stopped:false}
test.each([
 ['plan invocation limit exhausted','调用次数已达到上限'],
 ['plan concurrent reservation limit reached','并发调用已达到上限'],
 ['plan duration limit reached; issued Calls are not stopped','计划执行时限已到'],
])('distinguishes budget constraint %s',async(message,expected)=>{
 planAPI.controlTaskPlan.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'budget_exhausted',message}}))
 const c=await render();await c.state.submit(pause)
 expect(c.state.error.value).toContain(expected);expect(await records()).toEqual([])
})
test.each(['capability_not_supported','acceptance_required','budget_exhausted'])('preserves the actual %s rejection across parent refresh',async(code)=>{
 planAPI.controlTaskPlan.mockRejectedValueOnce(new TeamApiError(409,{error:{code,message:'specific reason'}}))
 const c=await render();await c.state.submit(pause)
 expect(await records()).toEqual([])
 expect(c.state.error.value).not.toContain('版本已变化')
 expect(c.state.error.value).toContain(code)
 expect(c.complete).toHaveBeenCalledWith(c.state.error.value)
})
test('plan control unknown result shares the task lock and survives remount without resending',async()=>{
 planAPI.controlTaskPlan.mockRejectedValue(new Error('lost response'))
 const first=await render();await first.state.submit(pause);await first.state.submit(execution)
 expect(api.executeDeliveryTask).not.toHaveBeenCalled();expect(await records()).toHaveLength(1);first.w.unmount()
 const next=await render();expect(next.state.pending.value?.operation).toEqual(pause)
 planAPI.getTaskPlanControlReceipt.mockResolvedValue({task_id:'task',request_id:'pause-original',found:true,receipt:{operation:'plan_control',response:paused}})
 await next.state.resolve();expect(planAPI.controlTaskPlan).toHaveBeenCalledTimes(1);expect(await records()).toEqual([]);expect(next.complete).toHaveBeenCalledOnce()
})
test('plan route 404 never authorizes retry; explicit missing permits only the original request',async()=>{
 planAPI.controlTaskPlan.mockRejectedValue(new Error('lost response'));const c=await render();await c.state.submit(pause)
 planAPI.getTaskPlanControlReceipt.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'request_failed'}}));await c.state.resolve();expect(c.state.receiptMissing.value).toBe(false)
 planAPI.getTaskPlanControlReceipt.mockResolvedValue({task_id:'task',request_id:'pause-original',found:false,receipt:null});await c.state.resolve()
 expect(c.state.receiptMissing.value).toBe(true);await c.state.retry();expect(planAPI.controlTaskPlan).toHaveBeenCalledTimes(1)
 c.state.confirmRetry.value=true;planAPI.controlTaskPlan.mockResolvedValue(paused);await c.state.retry()
 expect(planAPI.controlTaskPlan).toHaveBeenLastCalledWith('task',pause.input,{userId:1,origin:'relay-a'});expect(await records()).toEqual([])
})
test('definitive plan rejection is forwarded to the refreshed parent instead of success feedback',async()=>{
 planAPI.controlTaskPlan.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'revision_conflict',message:'changed'}}))
 const c=await render();await c.state.submit({kind:'plan_control',input:{request_id:'pause',expected_revision:2,plan_revision:1,action:'pause'}})
 expect(await records()).toEqual([]);expect(c.complete).toHaveBeenCalledWith('交付、规格或共享材料版本已变化，请重新核对。')
})

test('draft save lost response restores the exact plan through its own receipt without reactivation',async()=>{
 const draft={kind:'plan_draft' as const,input:{request_id:'draft',expected_revision:0,team_session_id:'session',context_version:1,spec_revision:2,steps:[{step_id:'one',title:'One',instruction:'Do',acceptance:'Check',required:true,depends_on:[],review_policy:{reviewer_user_id:2,primary_offer_id:'offer',required_checks:[]}}]}}
 planAPI.saveTaskPlanDraft.mockRejectedValueOnce(new TypeError('lost'))
 const old=await render();await old.state.submit(draft);old.w.unmount()
 const next=await render();expect(next.state.pending.value?.operation).toEqual(draft)
 planAPI.getTaskPlanDraftReceipt.mockResolvedValue({task_id:'task',request_id:'draft',found:true,receipt:{operation:'plan_draft',response:{task_id:'task',revision:1,state:'draft',execution_enabled:false,plan_hash:'a'.repeat(64)}}})
 await next.state.resolve();expect(await records()).toEqual([]);expect(planAPI.saveTaskPlanDraft).toHaveBeenCalledOnce();expect(planAPI.controlTaskPlan).not.toHaveBeenCalled()
})
