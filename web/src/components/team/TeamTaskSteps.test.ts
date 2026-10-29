import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import TeamTaskSteps from './TeamTaskSteps.vue'
import { TeamApiError } from '../../services/teamClient'
const api=vi.hoisted(()=>({getTaskPlan:vi.fn(),getTaskPlanExecution:vi.fn(),getTaskContext:vi.fn(),getDeliveryManagement:vi.fn()}))
vi.mock('../../services/teamPlanClient',()=>api)
vi.mock('../../services/teamDeliveryClient',async(importOriginal)=>({...await importOriginal<any>(),getDeliveryManagement:api.getDeliveryManagement}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
const step={step_id:'first',title:'修复重连',instruction:'精确目标',acceptance:'连续三次重连',required:true,depends_on:[],review_policy:{reviewer_user_id:2,primary_offer_id:'agent',required_checks:[]}}
const context=(attempt?:string)=>({task:{task_id:'task',title:'修复'},scope:attempt?'attempt':'task',spec:{revision:2,goal:'精确目标',acceptance:'连续三次重连'},attempt:attempt?{attempt_id:attempt,attempt_no:1,context_version:7}:null,inputs:[],decisions:[],diagnostics:attempt?[{code:'original_call_unknown',action:'reconcile_original_call'}]:[]})
const execution=()=>({task_id:'task',runtime:{plan_revision:1,state:'paused'},attempts:[{attempt_id:'attempt',step_id:'first',attempt_no:1,state:'unknown'}],execution_enabled:false,scheduler:{pending:false,last_error_code:null},budget:{policy:{max_concurrent_calls:1},invocation_limit:3,invocation_count:1,in_flight:1,started_at:null,duration_exhausted:false,usage:{observed_tokens:null,coverage:'unavailable',token_warning_exceeded:false}}})
const wrappers:Array<ReturnType<typeof mount>>=[]
async function render(){const w=mount(TeamTaskSteps,{props:{taskId:'task',currentUserId:1,available:true},global:{stubs:{TeamTaskPlanControls:true,TeamTaskPlanEditor:true}}});wrappers.push(w);await flushPromises();return w}
beforeEach(()=>{vi.resetAllMocks();api.getTaskPlanExecution.mockResolvedValue(execution());api.getTaskPlan.mockResolvedValue({task_id:'task',revision:2,plan:{revision:1,steps:[step]}});api.getTaskContext.mockImplementation(async(_task,attempt)=>context(attempt))})
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
test('reads the active revision instead of silently adopting a newer draft; unknown tokens remain unknown',async()=>{
 const w=await render();expect(api.getTaskPlan).toHaveBeenCalledWith('task',1);expect(w.text()).toContain('生效计划 v1');expect(w.text()).toContain('已暂停')
 await w.findAll('button').find(b=>b.text()==='查看执行预算')!.trigger('click')
 const budget=w.get('[aria-label="执行预算"]');expect(budget.text()).toContain('Token 用量未知');expect(budget.text()).toContain('在途调用1 / 1');expect(budget.text()).toContain('不支持 Token 或费用硬上限')
})
test('reads an exact unknown attempt without creating a retry or native probe',async()=>{
 const w=await render();await w.findAll('button').find(b=>b.text().includes('查看上下文'))!.trigger('click');await flushPromises()
 expect(api.getTaskContext).toHaveBeenLastCalledWith('task','attempt');expect(w.text()).toContain('不能直接重试');expect(w.text()).toContain('Context v7');expect(w.findAll('button').some(b=>b.text()==='重试')).toBe(false)
})
test('offline transition clears protected content and ignores a late context response',async()=>{
 const w=await render();let finish!:(value:unknown)=>void;api.getTaskContext.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
 await w.findAll('button').find(b=>b.text().includes('查看上下文'))!.trigger('click');await w.setProps({available:false});finish(context('attempt'));await flushPromises()
 expect(w.text()).not.toContain('精确目标');expect(w.text()).not.toContain('修复重连');expect(w.text()).toContain('恢复连接')
})
test('membership revocation clears all plan data and prevents fresh reads',async()=>{
 const w=await render();api.getTaskContext.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'team_not_found'}}))
 await w.findAll('button').find(b=>b.text().includes('查看上下文'))!.trigger('click');await flushPromises()
 expect(w.emitted('revoked')).toHaveLength(1);expect(w.text()).not.toContain('精确目标');expect(w.text()).toContain('无权访问');expect(w.get('button').attributes('disabled')).toBeDefined()
})
test('a stale account response cannot refill the new account view',async()=>{
 let finish!:(value:unknown)=>void;api.getTaskPlanExecution.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
 const w=await render();await w.setProps({currentUserId:2});await flushPromises();finish({...execution(),task_id:'stale'});await flushPromises()
 expect(w.text()).toContain('生效计划 v1');expect(w.text()).not.toContain('发生变化')
})
test('old Relay route absence is distinguished from lost membership',async()=>{
 api.getTaskPlanExecution.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'request_failed'}}));const w=await render()
 expect(w.text()).toContain('暂不支持步骤读取');expect(w.emitted('revoked')).toBeUndefined()
})
test('mismatched exact attempt cannot expose another context',async()=>{
 const w=await render();api.getTaskContext.mockResolvedValueOnce({...context('other'),spec:{revision:2,goal:'wrong secret',acceptance:'wrong'}})
 await w.findAll('button').find(b=>b.text().includes('查看上下文'))!.trigger('click');await flushPromises();expect(w.text()).toContain('上下文身份不匹配');expect(w.text()).not.toContain('wrong secret')
})

test('late candidate directory cannot restore an offline plan',async()=>{
 api.getTaskPlanExecution.mockResolvedValue({...execution(),can_control:true,execution_enabled:true})
 api.getTaskPlan.mockImplementation(async(_task,revision)=>({task_id:'task',revision:2,plan:{revision:revision??2,steps:[step]}}))
 let finish!:(value:unknown)=>void;api.getDeliveryManagement.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
 const w=await render();expect(api.getTaskPlan).toHaveBeenLastCalledWith('task');await w.setProps({available:false});finish({offers:[]});await flushPromises()
 expect(w.findComponent({name:'TeamTaskPlanControls'}).exists()).toBe(false)
})
test('revoked candidate directory clears both current and proposed revisions',async()=>{
 api.getTaskPlanExecution.mockResolvedValue({...execution(),can_control:true,execution_enabled:true})
 api.getTaskPlan.mockImplementation(async(_task,revision)=>({task_id:'task',revision:2,plan:{revision:revision??2,steps:[step]}}))
 api.getDeliveryManagement.mockRejectedValueOnce(new TeamApiError(403,{error:{code:'team_access_denied'}}))
 const w=await render();expect(w.emitted('revoked')).toHaveLength(1);expect(w.findComponent({name:'TeamTaskPlanControls'}).exists()).toBe(false)
})
