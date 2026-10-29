import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { ref } from 'vue'
import { TeamDeliveryOperationJournal } from '../../services/teamDeliveryOperationJournal'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import TeamTaskExecutionPanel from './TeamTaskExecutionPanel.vue'
import { TeamApiError } from '../../services/teamClient'
import type { DeliveryManagement, TaskDelivery } from '../../types/teamDelivery'
const testUser=ref({id:1})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user:testUser})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
const journal=()=>new TeamDeliveryOperationJournal()
const saved=(task='task')=>journal().load(JSON.stringify([location.origin,1]),task)
const api=vi.hoisted(()=>({getDeliveryManagement:vi.fn(),reviseDeliverySpec:vi.fn(),executeDeliveryTask:vi.fn(),getDeliveryReceipt:vi.fn()}))
vi.mock('../../services/teamDeliveryClient',()=>api)
const spec={task_id:'task',revision:2,goal:'修复重连',acceptance:'消息不重复',reviewer_user_id:2,primary_offer_id:'primary',required_checks:['unit']}
const delivery:TaskDelivery={task_id:'task',task_state:'in_progress',revision:5,spec,specs:[spec],latest_submission_id:null,submissions:[],writes_enabled:true}
function options():DeliveryManagement{return {task_revision:12,requirements_revision:3,can_manage:true,revision:5,spec_revision:2,reviewers:[{user_id:2}],offers:[{offer_id:'primary',provider:'codex',owner_user_id:1},{offer_id:'contributor',provider:'claude-code',owner_user_id:3}],sessions:[{team_session_id:'session',title:'修复讨论',current_context_version:7,offer_ids:['primary','contributor']}],execution_block:null}}
const wrappers:Array<ReturnType<typeof mount>>=[]
async function idle(w:ReturnType<typeof mount>){await vi.waitFor(()=>expect((w.vm as any).$.setupState.operations.busy.value).toBe(false));await vi.waitFor(()=>expect(w.text()).not.toContain('正在读取操作记录'));await flushPromises()}
function button(w:ReturnType<typeof mount>,name:string){return w.findAll('button').find(b=>b.text()===name)!}
async function render(){const w=mount(TeamTaskExecutionPanel,{props:{delivery:structuredClone(delivery),currentUserId:1,members:[],locked:false,verified:true},global:{stubs:{ActionSelect:{template:'<span><slot /></span>'}}}});wrappers.push(w);await flushPromises();await vi.waitFor(()=>expect(w.text()).not.toContain('正在读取操作记录'));return w}
async function prepare(w:ReturnType<typeof mount>,kind='revise'){await button(w,kind==='revise'?'修订验收要求':'重新执行').trigger('click');await w.get('form').trigger('submit')}
beforeEach(()=>{vi.resetAllMocks();testUser.value={id:1};vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto);sessionStorage.clear();api.getDeliveryManagement.mockResolvedValue(options());api.reviseDeliverySpec.mockResolvedValue({revision:6,spec_revision:3});api.executeDeliveryTask.mockImplementation(async(_task,_session,input)=>({revision:input.expected_revision+1,spec_revision:input.spec_revision,call_ids:input.target_offer_ids.map((id:string)=>'call-'+id)}))})
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.unstubAllGlobals()})
test('parent polling preserves the management draft', async()=>{
 const w=await render();await button(w,'修订验收要求').trigger('click');await w.get('[aria-label="修订验收标准"]').setValue('保留正在编辑的内容')
 await w.setProps({delivery:structuredClone(delivery)});await flushPromises()
 expect(w.get('[aria-label="修订验收标准"]').element).toHaveProperty('value','保留正在编辑的内容')
})
test.each([403,404,409])('unknown retry %s preserves the original operation for reconciliation', async(status)=>{
 api.executeDeliveryTask.mockRejectedValueOnce(new TypeError('lost response'));const w=await render();await prepare(w,'execute');await w.get('form').trigger('submit');await idle(w)
 const original=api.executeDeliveryTask.mock.calls[0][2]
 api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:original.request_id,found:false,receipt:null});await button(w,'查询修订或执行结果').trigger('click');await idle(w)
 api.executeDeliveryTask.mockRejectedValueOnce(new TeamApiError(status,{error:{code:status===403?'team_access_denied':status===404?'team_not_found':'revision_conflict',message:'denied or changed'}}))
 await button(w,'重试原修订或执行').trigger('click');await button(w,'确认重试原修订或执行').trigger('click');await idle(w)
 expect((await saved()).some(v=>v.operation.input.request_id===original.request_id)).toBe(true)
 expect(button(w,'重试原修订或执行')).toBeUndefined();expect(api.executeDeliveryTask).toHaveBeenCalledTimes(2)
})
test.each(['request_failed','team_not_found'])('lookup 404 %s retains the intent without enabling retry', async(code)=>{
 api.executeDeliveryTask.mockRejectedValueOnce(new TypeError('lost response'));const w=await render();await prepare(w,'execute');await w.get('form').trigger('submit');await idle(w)
 const original=api.executeDeliveryTask.mock.calls[0][2]
 api.getDeliveryReceipt.mockRejectedValueOnce(new TeamApiError(404,{error:{code,message:'missing'}}));await button(w,'查询修订或执行结果').trigger('click');await idle(w)
 expect(button(w,'重试原修订或执行')).toBeUndefined();expect((await saved()).some(v=>v.operation.input.request_id===original.request_id)).toBe(true)
 expect(api.executeDeliveryTask).toHaveBeenCalledTimes(1)
})
test('spec revision needs confirmation and never dispatches automatically',async()=>{
 const w=await render();await button(w,'修订验收要求').trigger('click');await w.get('[aria-label="修订验收标准"]').setValue('连续三次重连不重复');await w.get('form').trigger('submit')
 expect(api.reviseDeliverySpec).not.toHaveBeenCalled();await w.get('form').trigger('submit');await idle(w)
 expect(api.reviseDeliverySpec).toHaveBeenCalledWith('task',expect.objectContaining({expected_revision:5,acceptance:'连续三次重连不重复',policy:{reviewer_user_id:2,primary_offer_id:'primary',required_checks:['unit']}}),{userId:1,origin:''});expect(api.executeDeliveryTask).not.toHaveBeenCalled();expect(w.emitted('changed')).toHaveLength(1)
})
test('execution freezes selected session context and includes the primary Agent',async()=>{
 const w=await render();await button(w,'重新执行').trigger('click');expect(w.get('input[value="primary"]').attributes('disabled')).toBeDefined();await w.get('input[value="contributor"]').setValue(true)
 await w.get('form').trigger('submit');expect(api.executeDeliveryTask).not.toHaveBeenCalled();await w.get('form').trigger('submit');await idle(w)
 expect(api.executeDeliveryTask).toHaveBeenCalledWith('task','session',expect.objectContaining({expected_revision:5,expected_task_revision:12,spec_revision:2,context_version:7,target_offer_ids:['primary','contributor']}),{userId:1,origin:''})
})
test.each(['outstanding_execution','accepted_delivery'] as const)('blocks %s execution while allowing an explicit spec revision',async(block)=>{
 api.getDeliveryManagement.mockResolvedValue({...options(),execution_block:block});const w=await render();expect(button(w,'重新执行').attributes('disabled')).toBeDefined();expect(button(w,'修订验收要求').attributes('disabled')).toBeUndefined()
})
test('unknown execution survives remount and only retries the identical stored operation after missing receipt',async()=>{
 api.executeDeliveryTask.mockRejectedValueOnce(new TypeError('lost response'));let w=await render();await prepare(w,'execute');await w.get('form').trigger('submit');await idle(w);const original=api.executeDeliveryTask.mock.calls[0]
 expect(button(w,'重试原修订或执行')).toBeUndefined();expect(w.emitted('blocked')?.at(-1)).toEqual([true]);w.unmount();w=await render();expect(w.text()).toContain('操作结果尚未确认')
 api.getDeliveryReceipt.mockResolvedValueOnce({task_id:'task',request_id:original[2].request_id,found:false,receipt:null});await button(w,'查询修订或执行结果').trigger('click');await idle(w);await button(w,'重试原修订或执行').trigger('click');await button(w,'确认重试原修订或执行').trigger('click');await idle(w)
 expect(api.executeDeliveryTask.mock.calls[1]).toEqual(original);expect(w.emitted('changed')).toHaveLength(1)
})
test('unknown revision resolves its receipt without dispatch or a second revision',async()=>{
 api.reviseDeliverySpec.mockRejectedValueOnce(new TypeError('timeout'));const w=await render();await prepare(w);await w.get('form').trigger('submit');await idle(w);api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:api.reviseDeliverySpec.mock.calls[0][1].request_id,found:true,receipt:{operation:'revise_spec',response:{revision:6,spec_revision:3}}});await button(w,'查询修订或执行结果').trigger('click');await idle(w);expect(api.reviseDeliverySpec).toHaveBeenCalledTimes(1);expect(api.executeDeliveryTask).not.toHaveBeenCalled();expect(w.emitted('changed')).toHaveLength(1)
})
test('409 discards stale confirmation and refreshes instead of issuing a new request',async()=>{
 api.executeDeliveryTask.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'context_revision_conflict',message:'changed'}}));const w=await render();await prepare(w,'execute');await w.get('form').trigger('submit');await idle(w);expect(w.text()).toContain('版本已变化');expect(w.find('form').exists()).toBe(false);expect(w.emitted('changed')).toHaveLength(1);expect(api.executeDeliveryTask).toHaveBeenCalledTimes(1)
})
test('permission loss clears private draft and emits revoke to clear parent content',async()=>{
 api.reviseDeliverySpec.mockRejectedValueOnce(new TeamApiError(403,{error:{code:'team_access_denied',message:'denied'}}));const w=await render();await prepare(w);await w.get('form').trigger('submit');await idle(w);expect(w.emitted('revoked')).toHaveLength(1);expect(w.find('textarea').exists()).toBe(false);expect(sessionStorage.length).toBe(0)
})
test('stale options, read-only membership, parent mutation, and offline data cannot mutate',async()=>{
 api.getDeliveryManagement.mockResolvedValue({...options(),revision:4});const w=await render();expect(button(w,'修订验收要求').attributes('disabled')).toBeDefined()
 api.getDeliveryManagement.mockResolvedValue({...options(),revision:6});await w.setProps({delivery:{...delivery,revision:6},locked:true});await flushPromises();expect(button(w,'修订验收要求').attributes('disabled')).toBeDefined()
 await w.setProps({locked:false,verified:false});expect(button(w,'修订验收要求')).toBeUndefined()
 await w.setProps({verified:true});await flushPromises()
 api.getDeliveryManagement.mockResolvedValue({...options(),can_manage:false});await w.setProps({delivery:{...delivery,revision:7}});await flushPromises();expect(button(w,'修订验收要求')).toBeUndefined()
})
test('late response after switching tasks cannot report success or erase the old operation',async()=>{
 let resolve!:(value:unknown)=>void;api.executeDeliveryTask.mockReturnValueOnce(new Promise(r=>resolve=r));const w=await render();await prepare(w,'execute');await w.get('form').trigger('submit');await vi.waitFor(()=>expect(api.executeDeliveryTask).toHaveBeenCalledTimes(1));await w.setProps({delivery:{...delivery,task_id:'other'}});await flushPromises();resolve({revision:6});await flushPromises();expect(w.emitted('changed')).toBeUndefined();expect((await saved('task')).length).toBe(1)
})

test('an older Relay without management keeps readable delivery content',async()=>{
 api.getDeliveryManagement.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'request_failed',message:'Not Found'}}));const w=await render();expect(w.emitted('revoked')).toBeUndefined();expect(w.text()).toContain('暂不支持规格管理');expect(api.executeDeliveryTask).not.toHaveBeenCalled()
})
test('a corrupt saved operation blocks other mutations instead of silently losing unknown status',async()=>{
 const w=await render();api.executeDeliveryTask.mockRejectedValueOnce(new TypeError('timeout'));await prepare(w,'execute');await w.get('form').trigger('submit');await idle(w);w.unmount();sessionStorage.setItem('team-delivery-management::1:task','{broken');const restored=await render();expect(restored.text()).toContain('原操作记录损坏');expect(restored.emitted('blocked')?.at(-1)).toEqual([true]);expect(button(restored,'重新执行').attributes('disabled')).toBeDefined()
})

test('an options response arriving after offline transition cannot restore management',async()=>{
 const w=await render();let resolve!:(value:DeliveryManagement)=>void
 api.getDeliveryManagement.mockReturnValueOnce(new Promise(r=>resolve=r))
 await w.setProps({delivery:{...delivery,revision:6}});await flushPromises()
 await w.setProps({verified:false});resolve({...options(),revision:6});await flushPromises()
 expect(button(w,'修订验收要求')).toBeUndefined();expect(button(w,'重新执行')).toBeUndefined()
 expect(api.reviseDeliverySpec).not.toHaveBeenCalled();expect(api.executeDeliveryTask).not.toHaveBeenCalled()
})

test('missing version support blocks new execution without blocking spec editing',async()=>{
 const old=options();delete old.task_revision;delete old.requirements_revision;api.getDeliveryManagement.mockResolvedValue(old)
 const w=await render();expect(button(w,'重新执行').attributes('disabled')).toBeDefined()
 expect(w.text()).toContain('此 Relay 未提供执行确认版本')
 expect(button(w,'修订验收要求').attributes('disabled')).toBeUndefined()
})
test('unknown execution persists the confirmed task revision',async()=>{
 api.executeDeliveryTask.mockRejectedValue(new Error('response lost'))
 const w=await render();await prepare(w,'execute');expect(w.text()).toContain('需求 v3');expect(w.text()).toContain('任务版本 12')
 await w.get('form').trigger('submit');await idle(w)
 const [record]=await saved();expect(record.operation.kind).toBe('execute_task')
 expect(record.operation.input).toMatchObject({expected_task_revision:12})
})
