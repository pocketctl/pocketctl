import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import TeamTaskAssignPanel from './TeamTaskAssignPanel.vue'
import { TeamApiError } from '../../services/teamClient'
import { useAuth } from '../../composables/useAuth'
import { TeamTaskAssignmentJournal, teamTaskAssignmentJournal, type TaskAssignment, type TaskAssignmentInput } from '../../services/teamTaskAssignmentJournal'
import { deliveryCacheScope } from '../../services/teamDeliveryCache'
import { getRelayOrigin } from '../../composables/useEnv'
import type { TeamSession,TeamMember } from '../../types/team'
const api=vi.hoisted(()=>({assignTeamTask:vi.fn(),getDeliveryCapabilities:vi.fn(),findTeamTaskAssignment:vi.fn(),getTeamSession:vi.fn(),listTeamMembers:vi.fn(),getTeamCapabilities:vi.fn()}))
vi.mock('../../services/teamClient',async original=>({...await original<any>(),assignTeamTask:api.assignTeamTask,findTeamTaskAssignment:api.findTeamTaskAssignment,getTeamSession:api.getTeamSession,listTeamMembers:api.listTeamMembers,getTeamCapabilities:api.getTeamCapabilities}))
vi.mock('../../services/teamDeliveryClient',()=>({getDeliveryCapabilities:api.getDeliveryCapabilities}))
const session={id:'session',team_id:'team',state:'active',current_user_role:'member',current_context_version:4,agent_bindings:[{id:'b',state:'active',offer_id:'offer',provider:'codex',daemon_id:'fixture',availability:'online'}]} as TeamSession
const members=[{id:'m',user_id:2,display_label:'Reviewer',role:'member',state:'active'}] as TeamMember[]
const result=(input:TaskAssignmentInput)=>({task_id:'task',event:{id:'event',team_session_id:'session',author_user_id:2,content:input.instruction+'\n\n交付与验收：\n'+input.acceptance,context_version:input.context_version,target_offer_ids:input.target_offer_ids},call_ids:['call']})
let wrapper:ReturnType<typeof mount>,journal:TeamTaskAssignmentJournal
const scope=()=>deliveryCacheScope(2,getRelayOrigin())
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto);localStorage.clear()
 useAuth().user.value={id:2,email:'test@example.test',phone:null,display_name:'Reviewer'}
 journal=new TeamTaskAssignmentJournal()
 for(const method of ['load','reserve','remove'] as const)vi.spyOn(teamTaskAssignmentJournal,method).mockImplementation(journal[method].bind(journal) as any)
 api.getDeliveryCapabilities.mockResolvedValue({writes_enabled:true});api.getTeamCapabilities.mockResolvedValue({writes_enabled:true});api.getTeamSession.mockResolvedValue(session);api.listTeamMembers.mockResolvedValue(members)
 api.assignTeamTask.mockImplementation(async(_s,input)=>result(input));api.findTeamTaskAssignment.mockImplementation(async(s,key)=>({operation:'assign_task',team_session_id:s,request_id:key,found:false,response:null}))
})
afterEach(()=>{wrapper?.unmount();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function settled(){await flushPromises();await vi.waitFor(()=>{expect(wrapper.text()).not.toContain('正在读取分派设置…');expect(wrapper.text()).not.toContain('正在派发…')})}
async function render(){wrapper=mount(TeamTaskAssignPanel,{props:{session,members,currentUserId:2},global:{stubs:{ActionList:{template:'<section><slot/><slot name="footer"/></section>'},ActionSelect:{template:'<div><slot/></div>'}}}});await settled()}
async function fill(){await wrapper.get('textarea[placeholder="说明目标、范围和约束"]').setValue('Goal');await wrapper.get('textarea[placeholder="例如：提交修改文件，并说明验证命令和结果"]').setValue('Criteria');await wrapper.get('input[value="offer"]').setValue(true)}
async function click(text:string){await wrapper.findAll('button').find(b=>b.text()===text)!.trigger('click');await settled()}
async function submit(){await wrapper.get('form').trigger('submit');await settled()}
async function unknown(){await render();await fill();api.assignTeamTask.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}));await submit();return (await journal.load(scope(),'session'))!}
test('enabled rollout follows baseline review and sends frozen reviewer, primary and normalized checks',async()=>{
 await render();await fill();expect((wrapper.get('.task-review-settings input[type=checkbox]').element as HTMLInputElement).checked).toBe(true)
 await wrapper.get('textarea[aria-label="必需检查项"]').setValue('unit\nunit\nreconnect');await submit()
 expect(api.assignTeamTask).toHaveBeenCalledWith('session',expect.objectContaining({context_version:4,review_policy:{reviewer_user_id:2,primary_offer_id:'offer',required_checks:['unit','reconnect']}}),{userId:2,origin:getRelayOrigin()})
 expect(wrapper.emitted('assigned')).toEqual([['task']]);expect(await journal.load(scope(),'session')).toBeNull()
})
test('writes disabled keeps legacy assignment without fabricating a review contract',async()=>{
 api.getDeliveryCapabilities.mockResolvedValue({writes_enabled:false});await render();await fill();await submit();expect(api.assignTeamTask.mock.calls[0][1]).not.toHaveProperty('review_policy')
})
test('network failure cannot silently downgrade review and reload restores capability',async()=>{
 api.getDeliveryCapabilities.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}));await render();await wrapper.get('form').trigger('submit');expect(api.assignTeamTask).not.toHaveBeenCalled()
 await click('重新读取分派设置');await fill();expect(wrapper.text()).toContain('主交付 Agent')
})
test('committed response loss survives remount and resolves without resending',async()=>{
 const op=await unknown();wrapper.unmount();api.findTeamTaskAssignment.mockResolvedValue({operation:'assign_task',team_session_id:'session',request_id:op.input.request_id,found:true,response:result(op.input)})
 await render();expect(wrapper.text()).toContain('分派结果尚未确认');expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();expect(api.assignTeamTask).toHaveBeenCalledTimes(1)
 await click('查询原分派结果');expect(wrapper.emitted('assigned')).toEqual([['task']]);expect(api.assignTeamTask).toHaveBeenCalledTimes(1);expect(await journal.load(scope(),'session')).toBeNull()
})
test('explicit absence permits confirmed exact retry with original Context after reload',async()=>{
 const op=await unknown();wrapper.unmount();api.getTeamSession.mockResolvedValue({...session,current_context_version:9});await render()
 expect(wrapper.text()).not.toContain('确认重试原分派');await click('查询原分派结果');await click('重试原分派');await click('确认重试原分派')
 expect(api.assignTeamTask).toHaveBeenCalledTimes(2);expect(api.assignTeamTask.mock.calls[1][1]).toEqual(op.input);expect(wrapper.emitted('assigned')).toEqual([['task']])
})
test('old Relay missing receipt route never enables retry or clears unknown intent',async()=>{
 const op=await unknown();api.findTeamTaskAssignment.mockRejectedValue(new TeamApiError(404,{error:{code:'request_failed'}}));await click('查询原分派结果')
 expect(wrapper.text()).toContain('暂不支持查询分派回执');expect(wrapper.text()).not.toContain('确认重试原分派');expect(await journal.load(scope(),'session')).toEqual(op)
})
test('authoritative denial clears visible content and preserves the scoped unknown intent',async()=>{
 const op=await unknown();api.findTeamTaskAssignment.mockRejectedValue(new TeamApiError(404,{error:{code:'team_not_found'}}));await click('查询原分派结果')
 expect(wrapper.find('form').exists()).toBe(false);expect(await journal.load(scope(),'session')).toEqual(op)
})
test('wrong response identity cannot confirm or clear the original request',async()=>{
 const op=await unknown();api.findTeamTaskAssignment.mockResolvedValue({operation:'assign_task',team_session_id:'session',request_id:op.input.request_id,found:true,response:{...result(op.input),event:{...result(op.input).event,author_user_id:9}}});await click('查询原分派结果')
 expect(wrapper.emitted('assigned')).toBeUndefined();expect(await journal.load(scope(),'session')).toEqual(op)
})
test('disk failure blocks RPC and explicit reload restores operation recording',async()=>{
 vi.spyOn(teamTaskAssignmentJournal,'reserve').mockRejectedValueOnce(new Error('disk full'));await render();await fill();await submit();expect(api.assignTeamTask).not.toHaveBeenCalled();expect(wrapper.text()).toContain('disk full')
 await click('重新读取分派设置');await submit();expect(wrapper.emitted('assigned')).toEqual([['task']])
})
test('initial definitive conflict refreshes current Context and never automatically retries',async()=>{
 await render();await fill();api.getTeamSession.mockResolvedValue({...session,current_context_version:8});api.assignTeamTask.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'context_revision_conflict'}}));await submit()
 expect(wrapper.text()).toContain('Context v8');expect(wrapper.text()).toContain('重新核对');expect(api.assignTeamTask).toHaveBeenCalledTimes(1);expect(await journal.load(scope(),'session')).toBeNull()
})
test('rejected retry preserves unknown journal and requires another receipt lookup',async()=>{
 const op=await unknown();await click('查询原分派结果');await click('重试原分派');api.assignTeamTask.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'context_revision_conflict'}}));await click('确认重试原分派')
 expect(await journal.load(scope(),'session')).toEqual(op);expect(wrapper.findAll('button').some(b=>b.text()==='重试原分派')).toBe(false)
})
test('capability drift does not switch off an already selected human review policy',async()=>{
 await render();await fill();api.getDeliveryCapabilities.mockResolvedValue({writes_enabled:false});await click('重新读取分派设置');await submit();expect(api.assignTeamTask).not.toHaveBeenCalled();expect((wrapper.get('.task-review-settings input').element as HTMLInputElement).checked).toBe(true)
})
test('unmount and account change ignore late response while retaining original intent',async()=>{
 let finish!:(v:unknown)=>void;api.assignTeamTask.mockImplementationOnce(()=>new Promise(r=>finish=r));await render();await fill();await wrapper.get('form').trigger('submit');await vi.waitFor(()=>expect(api.assignTeamTask).toHaveBeenCalledTimes(1))
 const op=(await journal.load(scope(),'session'))!;useAuth().user.value={id:3,email:null,phone:null,display_name:'other'};await flushPromises();finish(result(op.input));await flushPromises()
 expect(wrapper.emitted('assigned')).toBeUndefined();expect(wrapper.find('form').exists()).toBe(false);expect(await journal.load(scope(),'session')).toEqual(op)
})
test('offline disables submission and recovery sends',async()=>{
 await render();await fill();vi.spyOn(navigator,'onLine','get').mockReturnValue(false);window.dispatchEvent(new Event('offline'));await submit();expect(api.assignTeamTask).not.toHaveBeenCalled()
})
test('ordinary parent session and same-account refresh preserve the unsent draft',async()=>{
 await render();await fill();await wrapper.get('textarea[aria-label="必需检查项"]').setValue('unit')
 await wrapper.setProps({session:{...session,current_context_version:9,agent_bindings:[...session.agent_bindings]}})
 useAuth().user.value={id:2,email:'updated@example.test',phone:null,display_name:'Updated'};await settled()
 expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Goal')
 expect((wrapper.get('input[value="offer"]').element as HTMLInputElement).checked).toBe(true)
 expect(api.getTeamSession).toHaveBeenCalledTimes(1)
 await submit();expect(api.assignTeamTask.mock.calls[0][1]).toMatchObject({instruction:'Goal',context_version:4,review_policy:{required_checks:['unit']}})
})
test('parent polling during an in-flight assignment cannot unlock a second dispatch',async()=>{
 let finish!:(v:unknown)=>void;api.assignTeamTask.mockImplementationOnce(()=>new Promise(r=>finish=r));await render();await fill()
 await wrapper.get('form').trigger('submit');await vi.waitFor(()=>expect(api.assignTeamTask).toHaveBeenCalledTimes(1))
 const op=(await journal.load(scope(),'session'))!
 await wrapper.setProps({session:{...session,revision:99}});await flushPromises()
 expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();expect(api.getTeamSession).toHaveBeenCalledTimes(1)
 await wrapper.get('form').trigger('submit');expect(api.assignTeamTask).toHaveBeenCalledTimes(1)
 finish(result(op.input));await settled();expect(wrapper.emitted('assigned')).toEqual([['task']])
})
