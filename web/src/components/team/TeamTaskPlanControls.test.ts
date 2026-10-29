import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import TeamTaskPlanControls from './TeamTaskPlanControls.vue'
import {canRetryTaskAttempt} from '../../types/teamPlan'
const operations=vi.hoisted(()=>({submit:vi.fn(),resolve:vi.fn(),retry:vi.fn(),refresh:vi.fn()}))
vi.mock('../../composables/useTeamDeliveryOperation',()=>({useTeamDeliveryOperation:()=>({...operations,blocked:ref(false),pending:saved,busy:ref(false),ready:ref(true),receiptMissing:ref(false),confirmRetry:ref(false),error:ref(''),storageError:ref('')})}))
const saved=ref<any>(null)
const snapshot=(state='active',enabled=true,control=true)=>({task_id:'task',revision:7,runtime:{plan_revision:2,revision:7,state,invocation_limit:8},can_control:control,execution_enabled:enabled,attempts:[],scheduler:{pending:false,last_error_code:null}} as any)
const wrappers:Array<ReturnType<typeof mount>>=[]
function render(state='active',enabled=true,control=true){const w=mount(TeamTaskPlanControls,{props:{taskId:'task',currentUserId:1,available:true,execution:snapshot(state,enabled,control)}});wrappers.push(w);return w}
beforeEach(()=>{vi.clearAllMocks();saved.value=null});afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
const click=async(w:ReturnType<typeof mount>,label:string)=>{await w.findAll('button').find(b=>b.text()===label)!.trigger('click');await flushPromises()}
test('pause requires confirmation and sends the displayed immutable revision even with execution disabled',async()=>{
 const w=render('active',false);await click(w,'暂停后续调度');expect(operations.submit).not.toHaveBeenCalled();expect(w.text()).toContain('已发出的调用继续运行')
 await click(w,'确认暂停');expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',input:{request_id:expect.any(String),expected_revision:7,plan_revision:2,action:'pause'}})
})
test('a changed runtime revision or lost connection invalidates confirmation',async()=>{
 const w=render();await click(w,'暂停后续调度');await w.setProps({execution:{...snapshot(),revision:8}});expect(w.text()).not.toContain('确认暂停')
 await click(w,'暂停后续调度');await w.setProps({available:false});expect(w.text()).not.toContain('确认暂停');expect(operations.submit).not.toHaveBeenCalled()
})
test('resume respects the execution gate and viewers get no controls',async()=>{
 const w=render('paused',false);expect(w.get('button').attributes('disabled')).toBeDefined()
 await w.setProps({execution:snapshot('paused',true)});await click(w,'恢复后续调度');expect(w.text()).toContain('预算不会重置');await click(w,'取消');expect(operations.submit).not.toHaveBeenCalled()
 await w.setProps({execution:snapshot('paused',true,false)});expect(w.findAll('button')).toHaveLength(0)
})

test('losing controller permission still exposes recovery for the original pending operation',async()=>{
 saved.value={operation:{kind:'plan_control',input:{request_id:'old'}}};const w=render('paused',false,false)
 expect(w.text()).toContain('查询原计划操作');expect(w.text()).not.toContain('恢复后续调度')
 await click(w,'查询原计划操作');expect(operations.resolve).toHaveBeenCalledOnce()
})

test('cancel requires explicit confirmation even when new execution is disabled',async()=>{
 const w=render('paused',false);await click(w,'取消后续调度');expect(w.text()).toContain('不能恢复');await click(w,'取消');expect(operations.submit).not.toHaveBeenCalled()
 await click(w,'取消后续调度');await click(w,'确认取消后续调度')
 expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',input:{request_id:expect.any(String),expected_revision:7,plan_revision:2,action:'cancel'}})
 await w.setProps({execution:snapshot('cancelled')});expect(w.findAll('button')).toHaveLength(0)
})

test('reconcile keeps the exact original attempt and Call even for a cancelled plan',async()=>{
 const w=render('cancelled',false),attempt='aaaaaaaa-1111-4111-8111-111111111111'
 await w.setProps({execution:{...snapshot('cancelled',false),attempts:[{attempt_id:attempt,step_id:'repair',attempt_no:2,call_id:'original-call'}]}})
 await w.get('select').setValue(attempt);await click(w,'核对原步骤状态');expect(w.text()).toContain('不创建新调用');await click(w,'确认核对原步骤')
 expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',expectedState:'cancelled',expectedCallId:'original-call',input:{request_id:expect.any(String),expected_revision:7,plan_revision:2,action:'reconcile',attempt_id:attempt}})
})

const retryAttempt={attempt_id:'aaaaaaaa-1111-4111-8111-111111111111',step_id:'repair',attempt_no:1,call_id:'original',call_state:'failed',state:'failed',delivery_revision:4}
test('new step retry requires explicit confirmation and pins both plan and delivery revisions',async()=>{
 const w=render();await w.setProps({execution:{...snapshot(),attempts:[retryAttempt]}})
 await w.get('select').setValue(retryAttempt.attempt_id);await click(w,'重新尝试此步骤');expect(w.text()).toContain('新的步骤尝试和一次调用');await click(w,'取消');expect(operations.submit).not.toHaveBeenCalled()
 await click(w,'重新尝试此步骤');await click(w,'确认新建尝试')
 expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',expectedState:'active',expectedCallId:'original',input:{request_id:expect.any(String),expected_revision:7,plan_revision:2,action:'retry',attempt_id:retryAttempt.attempt_id,expected_delivery_revision:4}})
})
test.each([
 ['uncertain','unknown',null,false],['failed','unknown',null,false],['failed','awaiting_review',null,true],['blocked','awaiting_review',null,true],['cancelled','awaiting_review',null,true],['cancelled','failed',null,true],['failed','accepted','accepted',false],['failed','failed',null,true],['blocked','failed',null,true],['cancelled','cancelled',null,true],['completed','awaiting_review',null,false],['completed','awaiting_review','changes_requested',true],['completed','accepted','accepted',false],
])('retry eligibility preserves %s/%s/%s', (call_state,state,latest_decision,allowed)=>{
 const execution={...snapshot(),attempts:[{...retryAttempt,call_state,state,latest_decision}]}
 expect(canRetryTaskAttempt(execution,retryAttempt.attempt_id)).toBe(allowed)
 expect(canRetryTaskAttempt({...execution,execution_enabled:false},retryAttempt.attempt_id)).toBe(false)
 expect(canRetryTaskAttempt({...execution,attempts:[...execution.attempts,{...retryAttempt,attempt_id:'new',attempt_no:2}]},retryAttempt.attempt_id)).toBe(false)
})

const draft={task_id:'task',revision:2,state:'draft',writes_enabled:true,plan:{revision:2,context_version:1,spec_revision:1,steps:[{step_id:'one'},{step_id:'two'}]}} as any
test('adoption pins the new draft while preserving pause and budget',async()=>{
 const w=render('paused');await w.setProps({draft:{...draft,revision:3,plan:{...draft.plan,revision:3,steps:[]}}})
 await click(w,'采用草稿 v3');expect(w.text()).toContain('仍保持暂停');await click(w,'取消');expect(operations.submit).not.toHaveBeenCalled()
 await click(w,'采用草稿 v3');await click(w,'确认采用修订')
 expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',input:{request_id:expect.any(String),expected_revision:7,plan_revision:3,action:'adopt_revision'}})
 await w.setProps({execution:snapshot('active')});expect(w.text()).not.toContain('采用草稿 v3')
})
test('activation requires explicit covering budget and confirmation, then pins draft revision',async()=>{
 const w=render();await w.setProps({execution:{...snapshot(),revision:0,runtime:null},plan:draft});await w.get('input').setValue('1')
 expect(w.findAll('button').find(b=>b.text()==='激活此计划')!.attributes('disabled')).toBeDefined()
 await w.get('input').setValue('3');await click(w,'激活此计划');await click(w,'取消');expect(operations.submit).not.toHaveBeenCalled()
 await click(w,'激活此计划');await click(w,'确认激活计划');expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',input:{request_id:expect.any(String),expected_revision:0,plan_revision:2,action:'activate',invocation_limit:3}})
})
test('changed draft or budget cancels activation confirmation; gate off blocks activation',async()=>{
 const w=render();await w.setProps({execution:{...snapshot(),revision:0,runtime:null},plan:draft});await w.get('input').setValue('3');await click(w,'激活此计划')
 await w.get('input').setValue('4');expect(w.text()).not.toContain('确认激活计划');await click(w,'激活此计划')
 await w.setProps({plan:{...draft,revision:3,plan:{...draft.plan,revision:3}}});expect(w.text()).not.toContain('确认激活计划')
 await w.setProps({execution:{...snapshot(),revision:0,runtime:null,execution_enabled:false}});expect(w.findAll('button').find(b=>b.text()==='激活此计划')!.attributes('disabled')).toBeDefined()
})

test('optional budgets are bounded, confirmed and frozen; editing a limit cancels confirmation',async()=>{
 const w=render();await w.setProps({execution:{...snapshot(),revision:0,runtime:null},plan:draft})
 await w.get('[aria-label="调用总上限"]').setValue('3')
 await w.get('[aria-label="并发调用上限"]').setValue('33')
 expect(w.findAll('button').find(b=>b.text()==='激活此计划')!.attributes('disabled')).toBeDefined()
 await w.get('[aria-label="并发调用上限"]').setValue('2')
 await w.get('[aria-label="停止新派发时限"]').setValue('3600')
 await w.get('[aria-label="Token 提醒阈值"]').setValue('12000')
 await click(w,'激活此计划');expect(w.text()).toContain('3600 秒');expect(w.text()).toContain('Token 仅提醒')
 await w.get('[aria-label="停止新派发时限"]').setValue('7200');expect(w.text()).not.toContain('确认激活计划')
 await click(w,'激活此计划');await click(w,'确认激活计划')
 expect(operations.submit.mock.calls[0][0].input.budget).toEqual({max_concurrent_calls:2,max_duration_seconds:7200,token_warning_limit:12000})
})

test('accepted successor requires capability, explanation and explicit confirmation; cancel preserves the draft',async()=>{
 const w=render(),a={...retryAttempt,call_state:'completed',state:'accepted',latest_decision:'accepted'}
 await w.setProps({execution:{...snapshot(),attempts:[a]}});await w.get('select').setValue(a.attempt_id)
 expect(w.text()).not.toContain('生成新版本')
 await w.setProps({execution:{...snapshot(),new_version_enabled:true,attempts:[a]}})
 await click(w,'生成新版本');await w.get('textarea').setValue('补充边界证明')
 await click(w,'核对新版本');await click(w,'返回修改');expect(w.get('textarea').element.value).toBe('补充边界证明');expect(operations.submit).not.toHaveBeenCalled()
 await click(w,'核对新版本');await w.get('textarea').setValue('补充失败边界证明');expect(w.text()).not.toContain('确认生成新版本？')
 await click(w,'核对新版本');await click(w,'确认生成新版本')
 expect(operations.submit).toHaveBeenCalledWith({kind:'plan_control',expectedState:'active',expectedCallId:'original',input:{request_id:expect.any(String),expected_revision:7,plan_revision:2,action:'new_version',attempt_id:a.attempt_id,expected_delivery_revision:4,reason:'补充失败边界证明'}})
})
test('accepted successor confirmation expires when the displayed delivery changes',async()=>{
 const w=render(),a={...retryAttempt,call_state:'completed',state:'accepted',latest_decision:'accepted'}
 await w.setProps({execution:{...snapshot(),new_version_enabled:true,attempts:[a]}});await w.get('select').setValue(a.attempt_id)
 await click(w,'生成新版本');await w.get('textarea').setValue('补充证明');await click(w,'核对新版本')
 await w.setProps({execution:{...snapshot(),new_version_enabled:true,attempts:[{...a,delivery_revision:5}]}})
 expect(w.text()).not.toContain('确认生成新版本？');expect(operations.submit).not.toHaveBeenCalled()
})
