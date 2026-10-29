import { IDBFactory } from 'fake-indexeddb'
import { ref } from 'vue'
import { TeamDeliveryOperationJournal } from '../../services/teamDeliveryOperationJournal'
import { webcrypto, createHash } from 'node:crypto'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import TeamTaskDeliveryPanel from './TeamTaskDeliveryPanel.vue'
import { TeamApiError } from '../../services/teamClient'
import type { TaskDelivery } from '../../types/teamDelivery'
const testUser=ref({id:2})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user:testUser})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
const journal=()=>new TeamDeliveryOperationJournal()
const saved=(task='task')=>journal().load(JSON.stringify(['',2]),task)
const api=vi.hoisted(()=>({getTaskDelivery:vi.fn(),decideTaskDelivery:vi.fn(),getDeliveryReceipt:vi.fn(),getDeliveryHistory:vi.fn(),readDeliveryArtifact:vi.fn()}))
vi.mock('../../services/teamDeliveryClient',()=>api)
const cache=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),purge:vi.fn(),ticket:()=>1}))
vi.mock('../../services/teamDeliveryCache',()=>({teamDeliveryCache:cache,deliveryCacheScope:(user:number,origin:string)=>JSON.stringify([origin,user])}))
const spec={task_id:'task',revision:1,goal:'Fix reconnect',acceptance:'连续重连不重复',reviewer_user_id:2,primary_offer_id:'offer',required_checks:['unit']}
function data():TaskDelivery{return {task_id:'task',task_state:'in_progress',revision:2,spec,specs:[spec],latest_submission_id:'s1',writes_enabled:true,submissions:[{
 submission_id:'s1',spec_revision:1,version:1,state:'published',summary:'重连修复与验证',delivery_role:'primary',submitted_by_user_id:1,source_call_id:'call',source_offer_id:'offer',source_run_id:null,context_version:3,code_revision:'abc',contribution_ids:[],published_at:'2026-10-23T01:00:00Z',decision:null,decision_reason:null,
 manifest:[{id:'proof',name:'report.md',mime_type:'text/markdown',byte_size:3,sha256:'abc',required:true}],revoked_artifact_ids:[],evidence:[{check_id:'unit',artifact_id:'proof',result:'passed',source_kind:'agent_claim',code_revision:'abc'}]
}]}}
const wrappers:Array<ReturnType<typeof mount>>=[]
async function render(user=2,attemptId?:string){testUser.value={id:user};const w=mount(TeamTaskDeliveryPanel,{props:{taskId:'task',currentUserId:user,...(attemptId?{attemptId}:{})},global:{stubs:{TeamTaskExecutionPanel:true}}});wrappers.push(w);await flushPromises();await vi.waitFor(()=>expect(w.text()).not.toContain('正在读取操作记录'));return w}
async function idle(w:ReturnType<typeof mount>){await vi.waitFor(()=>expect((w.vm as any).$.setupState.operations.busy.value).toBe(false));await vi.waitFor(()=>expect(w.text()).not.toContain('正在读取操作记录'));await flushPromises()}
function button(w:ReturnType<typeof mount>,name:string){return w.findAll('button').find(b=>b.text()===name)!}
beforeEach(()=>{vi.resetAllMocks();testUser.value={id:2};vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto);cache.read.mockResolvedValue(null);cache.write.mockResolvedValue(undefined);cache.purge.mockResolvedValue(undefined);sessionStorage.clear();api.getTaskDelivery.mockResolvedValue(data());api.decideTaskDelivery.mockImplementation(async(_task,input)=>({decision_id:'decision',revision:input.expected_revision+1,submission_id:input.submission_id,decision:input.decision}));api.getDeliveryHistory.mockResolvedValue({executions:[],has_more:false})})
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.unstubAllGlobals()})
describe('Task delivery authority UI',()=>{
 test.each(['accepted','changes_requested'] as const)('labels the %s decision reason without changing its meaning',async(decision)=>{
  const value=data();value.submissions[0].decision=decision;value.submissions[0].decision_reason='原始审核说明'
  api.getTaskDelivery.mockResolvedValue(value)
  const w=await render()
  expect(w.text()).toContain(`${decision==='accepted'?'验收说明':'修改意见'}：原始审核说明`)
  expect(w.text()).not.toContain(`${decision==='accepted'?'修改意见':'验收说明'}：原始审核说明`)
 })
 test.each([403,404,409])('unknown decision retry %s retains original journal even after content purge',async(status)=>{
  api.decideTaskDelivery.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}))
  const w=await render();await button(w,'要求修改').trigger('click');await w.get('textarea').setValue('补充证据');await button(w,'确认提交').trigger('click');await idle(w)
  const original=api.decideTaskDelivery.mock.calls[0][1]
  api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:original.request_id,found:false,receipt:null});await button(w,'查询原操作').trigger('click');await flushPromises()
  api.decideTaskDelivery.mockRejectedValueOnce(new TeamApiError(status,{error:{code:status===403?'team_access_denied':status===404?'team_not_found':'revision_conflict'}}));await button(w,'重试原操作').trigger('click');await button(w,'确认重试原操作').trigger('click');await idle(w)
  window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail:{task:'task'}}));await flushPromises()
  expect((await saved()).some(v=>v.operation.input.request_id===original.request_id)).toBe(true)
  expect(button(w,'重试原操作')).toBeUndefined();expect(api.decideTaskDelivery).toHaveBeenCalledTimes(2)
  w.unmount();const reopened=await render()
  expect(reopened.text()).toContain('验收结果尚未确认');expect(button(reopened,'验收通过').attributes('disabled')).toBeDefined()
 })
 test.each(['request_failed','team_not_found'])('receipt lookup 404 %s never unlocks decision retry',async(code)=>{
  api.decideTaskDelivery.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}))
  const w=await render();await button(w,'要求修改').trigger('click');await w.get('textarea').setValue('补充证据');await button(w,'确认提交').trigger('click');await idle(w)
  const original=api.decideTaskDelivery.mock.calls[0][1]
  api.getDeliveryReceipt.mockRejectedValueOnce(new TeamApiError(404,{error:{code}}));await button(w,'查询原操作').trigger('click');await flushPromises()
  expect(button(w,'重试原操作')).toBeUndefined();expect((await saved()).some(v=>v.operation.input.request_id===original.request_id)).toBe(true)
  expect(api.decideTaskDelivery).toHaveBeenCalledTimes(1)
 })
 test('execution history separates export failures from native completion and suppresses stale failures after publication',async()=>{
  const execution={call_id:'call',state:'completed',spec_revision:1,deliveries:[],export_status:{phase:'waiting_for_files',error_code:'manifest_unavailable',updated_at:'2026-10-23T01:00:00Z',revision:1}}
  api.getDeliveryHistory.mockResolvedValue({executions:[execution],has_more:false})
  const w=await render();await button(w,'执行记录').trigger('click');await flushPromises()
  expect(w.text()).toContain('等待交付文件');expect(w.text()).toContain('执行结束不代表文件已保存')
  api.getDeliveryHistory.mockResolvedValue({executions:[{...execution,deliveries:[{submission_id:'s1',version:1,published_at:'2026-10-23T01:01:00Z'}]}],has_more:false})
  await button(w,'执行记录').trigger('click');await flushPromises()
  expect(w.text()).not.toContain('等待交付文件');expect(w.text()).toContain('交付 v1')
 })
 test('requires explicit check confirmation and a second human confirmation before accepting',async()=>{
  const w=await render();expect(button(w,'验收通过').attributes('disabled')).toBeDefined()
  await w.get('input[type=checkbox]').setValue(true);await button(w,'验收通过').trigger('click')
  expect(api.decideTaskDelivery).not.toHaveBeenCalled();await button(w,'确认提交').trigger('click');await idle(w)
  expect(api.decideTaskDelivery).toHaveBeenCalledWith('task',expect.objectContaining({submission_id:'s1',spec_revision:1,expected_revision:2,decision:'accepted',verified_checks:['unit']}),{userId:2,origin:''})
 })
 test('missing evidence blocks acceptance but allows returning with a reason',async()=>{
  const d=data();d.submissions[0].evidence=[];api.getTaskDelivery.mockResolvedValue(d)
  const w=await render();expect(button(w,'验收通过').attributes('disabled')).toBeDefined();await button(w,'要求修改').trigger('click')
  expect(button(w,'确认提交').attributes('disabled')).toBeDefined();await w.get('textarea').setValue('补充真实测试记录');await button(w,'确认提交').trigger('click');await idle(w)
  expect(api.decideTaskDelivery).toHaveBeenCalledWith('task',expect.objectContaining({decision:'changes_requested',reason:'补充真实测试记录',verified_checks:[]}),{userId:2,origin:''})
 })
 test('the latest published file is marked historical after a spec revision',async()=>{
  const d=data();d.spec={...d.spec,revision:2,acceptance:'新标准'};d.specs.push(d.spec);api.getTaskDelivery.mockResolvedValue(d);const w=await render();expect(w.get('option').text()).toContain('历史规格');expect(w.get('option').text()).not.toContain('当前');expect(button(w,'验收通过')).toBeUndefined()
 })
 test('another member and historical contributions remain read-only',async()=>{
  const w=await render(1);expect(button(w,'验收通过')).toBeUndefined();expect(w.text()).toContain('只读状态')
  testUser.value={id:2};await w.setProps({currentUserId:2});await flushPromises();const d=data();d.latest_submission_id='other';api.getTaskDelivery.mockResolvedValue(d)
  await button(w,'刷新').trigger('click');await flushPromises();expect(w.text()).toContain('历史提交或贡献版本');expect(button(w,'验收通过')).toBeUndefined()
 })
 test('unknown result survives remount and retry uses the original request ID and immutable payload',async()=>{
  api.decideTaskDelivery.mockRejectedValue(new TeamApiError(0,{error:{code:'network_error'}}))
  const w=await render();await button(w,'要求修改').trigger('click');await w.get('textarea').setValue('补充证据');await button(w,'确认提交').trigger('click');await idle(w)
  const original=api.decideTaskDelivery.mock.calls[0][1];expect(w.text()).toContain('结果尚未确认');w.unmount()
  const restored=await render();expect(restored.text()).toContain('查询原操作')
  api.getDeliveryReceipt.mockResolvedValue({task_id:'task',request_id:original.request_id,found:false,receipt:null});await button(restored,'查询原操作').trigger('click');await flushPromises()
  api.decideTaskDelivery.mockResolvedValue({decision_id:'d',revision:original.expected_revision+1,submission_id:original.submission_id,decision:original.decision});await button(restored,'重试原操作').trigger('click');await button(restored,'确认重试原操作').trigger('click');await idle(restored)
  expect(api.decideTaskDelivery.mock.calls[1][1]).toEqual(original);expect(sessionStorage.length).toBe(0)
 })
 test('409 forces fresh authority and 403 removes cached protected content',async()=>{
  const w=await render();await w.get('input[type=checkbox]').setValue(true);await button(w,'验收通过').trigger('click')
  api.decideTaskDelivery.mockRejectedValue(new TeamApiError(409,{error:{code:'revision_conflict'}}));const fresh=data();fresh.spec={...spec,reviewer_user_id:3};api.getTaskDelivery.mockResolvedValue(fresh)
  await button(w,'确认提交').trigger('click');await idle(w);expect(w.text()).toContain('版本已变化');expect(button(w,'验收通过')).toBeUndefined()
  api.getTaskDelivery.mockRejectedValue(new TeamApiError(403,{error:{code:'team_access_denied'}}));await button(w,'刷新').trigger('click');await flushPromises()
  expect(w.text()).not.toContain('重连修复与验证');expect(w.text()).not.toContain('report.md')
 })
 test('refresh invalidates the human check even when the selected submission ID is unchanged',async()=>{
  const w=await render();await w.get('input[type=checkbox]').setValue(true)
  expect(button(w,'验收通过').attributes('disabled')).toBeUndefined()
  await button(w,'刷新').trigger('click');await flushPromises()
  expect(button(w,'验收通过').attributes('disabled')).toBeDefined()
 })
 test('a late decision cannot unlock a different task operation',async()=>{
  let finish!:(v:unknown)=>void
  api.decideTaskDelivery.mockImplementationOnce(()=>new Promise(r=>{finish=r})).mockImplementationOnce(()=>new Promise(()=>{}))
  const w=await render();await button(w,'要求修改').trigger('click');await w.get('textarea').setValue('first');await button(w,'确认提交').trigger('click');await vi.waitFor(()=>expect(api.decideTaskDelivery).toHaveBeenCalledTimes(1))
  api.getTaskDelivery.mockResolvedValue({...data(),task_id:'other'});await w.setProps({taskId:'other'});await idle(w)
  await button(w,'要求修改').trigger('click');await w.get('textarea').setValue('second');await button(w,'确认提交').trigger('click');await vi.waitFor(()=>expect(api.decideTaskDelivery).toHaveBeenCalledTimes(2))
  finish({decision_id:'old'});await flushPromises()
  expect(button(w,'查询原操作').attributes('disabled')).toBeDefined()
  expect(w.emitted('changed')).toBeUndefined()
 })
 test('a late old-task read cannot overwrite a new task',async()=>{
  let complete!:(d:TaskDelivery)=>void;api.getTaskDelivery.mockImplementationOnce(()=>new Promise(r=>{complete=r}))
  const w=await render();await w.setProps({taskId:'other'});await flushPromises();complete({...data(),submissions:[{...data().submissions[0],summary:'PRIVATE OLD RESULT'}]});await flushPromises()
  expect(w.text()).not.toContain('PRIVATE OLD RESULT')
 })
})

test('offline remount restores a readable snapshot and verified cached bytes but disables all decisions',async()=>{
 const d=data(),bytes=new TextEncoder().encode('proof').buffer;d.submissions[0].manifest[0].byte_size=5;d.submissions[0].manifest[0].sha256=createHash('sha256').update('proof').digest('hex')
 cache.read.mockImplementation(async(_owner,kind)=>({data:kind==='file'?bytes:d,at:1}));api.getTaskDelivery.mockRejectedValueOnce(new TeamApiError(0,{error:{message:'offline'}}));vi.stubGlobal('crypto',webcrypto)
 const w=await render();expect(w.text()).toContain('上次同步的只读内容');expect(button(w,'验收通过')).toBeUndefined();
 const file=w.findAll('button').find(b=>b.text().includes('report.md'))!;await file.trigger('click');await vi.waitFor(()=>expect(w.find('pre').text()).toBe('proof'));expect(api.readDeliveryArtifact).not.toHaveBeenCalled();vi.unstubAllGlobals()
})
test('authoritative task revocation clears cached content, while a network error does not purge',async()=>{
 const w=await render();api.getTaskDelivery.mockRejectedValueOnce(new TeamApiError(0,{error:{message:'offline'}}));await button(w,'刷新').trigger('click');await flushPromises();expect(w.text()).toContain('重连修复与验证');expect(cache.purge).not.toHaveBeenCalled()
 api.getTaskDelivery.mockRejectedValueOnce(new TeamApiError(403,{error:{code:'team_access_denied',message:'revoked'}}));await button(w,'刷新').trigger('click');await flushPromises();expect(w.text()).not.toContain('重连修复与验证');expect(cache.purge).toHaveBeenCalledWith(expect.any(String),{task:'task'})
})

test('an unavailable or revoked server artifact never falls back to a previously cached file',async()=>{
 cache.purge.mockImplementation(async(scope,filter)=>{window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail:{scope,...filter}}))})
 const accepted=data();accepted.submissions[0].decision='accepted';accepted.submissions[0].decision_reason='Original accepted decision';api.getTaskDelivery.mockResolvedValue(accepted)
 const w=await render();api.readDeliveryArtifact.mockRejectedValueOnce(new TeamApiError(503,{error:{code:'artifact_unavailable',message:'revoked'}}));await w.findAll('button').find(b=>b.text().includes('report.md'))!.trigger('click');await flushPromises()
 expect(cache.read.mock.calls.some(c=>c[1]==='file')).toBe(false);expect(cache.purge).toHaveBeenCalledWith(expect.any(String),{task:'task',filesOnly:true});expect(w.find('pre').exists()).toBe(false)
 expect(w.text()).toContain('重连修复与验证');expect(w.text()).toContain('Original accepted decision');expect(w.text()).toContain('文件不可用，请刷新后重新读取。');expect(w.text()).not.toContain('交付暂时无法刷新');expect(w.emitted('revoked')).toBeUndefined()
})

const attemptId='aaaaaaaa-1111-4111-8111-111111111111'
test('step delivery uses exact scope and separate cache without task management or recursive plans',async()=>{
 api.getTaskDelivery.mockResolvedValue({...data(),attempt_id:attemptId});const w=await render(2,attemptId)
 expect(api.getTaskDelivery).toHaveBeenCalledWith('task',attemptId);expect(button(w,'执行步骤')).toBeUndefined();expect(w.findComponent({name:'TeamTaskExecutionPanel'}).exists()).toBe(false)
 expect(cache.write).toHaveBeenCalledWith(expect.any(String),'detail',JSON.stringify(['task',attemptId]),'', ['task'],expect.objectContaining({attempt_id:attemptId}),1)
 api.decideTaskDelivery.mockImplementation(async(_task,input,_identity,attempt)=>({decision_id:'step-decision',revision:input.expected_revision+1,submission_id:input.submission_id,decision:input.decision,attempt_id:attempt}))
 await w.get('input[type=checkbox]').setValue(true);await button(w,'验收通过').trigger('click');await button(w,'确认提交').trigger('click');await idle(w)
 expect(api.decideTaskDelivery).toHaveBeenCalledWith('task',expect.objectContaining({submission_id:'s1'}),{userId:2,origin:''},attemptId);expect(await saved()).toEqual([])
})
test('step view never accepts a root response and an unknown step decision resolves its original attempt after reopening the task',async()=>{
 const wrong=await render(2,attemptId);expect(wrong.text()).toContain('交付范围不匹配');expect(wrong.text()).not.toContain('重连修复与验证');wrong.unmount()
 api.getTaskDelivery.mockResolvedValue({...data(),attempt_id:attemptId});api.decideTaskDelivery.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}))
 const step=await render(2,attemptId);await button(step,'要求修改').trigger('click');await step.get('textarea').setValue('step proof');await button(step,'确认提交').trigger('click');await idle(step)
 const original=(await saved())[0]!;expect(original.operation).toMatchObject({attemptId});step.unmount()
 api.getTaskDelivery.mockResolvedValue(data());const root=await render();api.getDeliveryReceipt.mockResolvedValue({task_id:'task',attempt_id:attemptId,request_id:original.operation.input.request_id,found:false,receipt:null})
 await button(root,'查询原操作').trigger('click');await flushPromises();expect(api.getDeliveryReceipt).toHaveBeenLastCalledWith('task',original.operation.input.request_id,{userId:2,origin:''},attemptId)
 expect(root.text()).toContain('未查到原操作回执')
})
