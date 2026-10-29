import {mount,flushPromises} from '@vue/test-utils'
import {beforeEach,afterEach,expect,test,vi} from 'vitest'
import {IDBFactory} from 'fake-indexeddb'
import {webcrypto} from 'node:crypto'
import TeamTemplateTaskPanel from './TeamTemplateTaskPanel.vue'
import {TeamApiError} from '../../services/teamClient'
import {useAuth} from '../../composables/useAuth'
import {getRelayOrigin} from '../../composables/useEnv'
import {deliveryCacheScope} from '../../services/teamDeliveryCache'
import {TeamTaskAssignmentJournal,teamTaskAssignmentJournal} from '../../services/teamTaskAssignmentJournal'
import {template,result,operation} from '../../services/__tests__/fixtures/teamTemplate'
import type {TeamSession} from '../../types/team'
const api=vi.hoisted(()=>({getTeamSession:vi.fn(),listTeamMembers:vi.fn(),listTeamTemplates:vi.fn(),getTeamTemplate:vi.fn(),createTemplateTask:vi.fn(),findTemplateTask:vi.fn()}))
vi.mock('../../services/teamClient',async original=>({...await original<any>(),getTeamSession:api.getTeamSession,listTeamMembers:api.listTeamMembers}))
vi.mock('../../services/teamTemplateClient',()=>api)
const session={id:'session',team_id:'team',state:'active',current_user_role:'member',current_context_version:4,agent_bindings:[{id:'b',state:'active',offer_id:'offer',provider:'codex',daemon_id:'host',availability:'online'}]} as TeamSession
let wrapper:ReturnType<typeof mount>,journal:TeamTaskAssignmentJournal
const scope=()=>deliveryCacheScope(2,getRelayOrigin())
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto);localStorage.clear();useAuth().user.value={id:2,email:'fixture@example.test',phone:null,display_name:'Reviewer'}
 journal=new TeamTaskAssignmentJournal();for(const method of ['loadCreation','reserve','remove'] as const)vi.spyOn(teamTaskAssignmentJournal,method).mockImplementation(journal[method].bind(journal) as any)
 api.getTeamSession.mockResolvedValue(session);api.listTeamMembers.mockResolvedValue([{user_id:2,display_label:'Reviewer',state:'active',role:'member'}])
 api.listTeamTemplates.mockResolvedValue({team_id:'team',writes_enabled:true,can_create:true,can_manage:false,items:[{template_id:'template',revision:2,name:'Repair',content_hash:'c'.repeat(64)}],next_cursor:null})
 api.getTeamTemplate.mockImplementation(async(_team,_id,revision)=>({...template,revision}));api.createTemplateTask.mockResolvedValue(result)
 api.findTemplateTask.mockImplementation(async(_team,request_id)=>({team_id:'team',actor_user_id:2,request_id,operation:'create_template_task',found:false,response:null}))
})
afterEach(()=>{wrapper?.unmount();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function settle(){await flushPromises();await vi.waitFor(()=>expect(wrapper.text()).not.toContain('正在读取模板与会话设置…'));await flushPromises()}
async function render(){wrapper=mount(TeamTemplateTaskPanel,{props:{session,currentUserId:2},global:{stubs:{ActionList:{template:'<section><slot/><slot name="footer"/></section>'},ActionSelect:{template:'<div><slot/></div>'}}}});await settle()}
async function click(label:string){const b=wrapper.findAll('button').find(b=>b.text()===label)!;expect(b).toBeTruthy();await b.trigger('click');await settle()}
async function fill(){await wrapper.get('select[aria-label="协作模板"]').setValue('template');await wrapper.get('select[aria-label="模板版本"]').setValue('1');await click('读取所选版本');await wrapper.get('select[aria-label="执行者 执行 Agent"]').setValue('offer');await wrapper.get('select[aria-label="审查人 验收人"]').setValue('2')}
async function submit(){await wrapper.get('form').trigger('submit');await click('确认创建草稿');await vi.waitFor(()=>expect(api.createTemplateTask).toHaveBeenCalled());await flushPromises()}
async function unknown(){await render();await fill();api.createTemplateTask.mockRejectedValueOnce(new TeamApiError(0,{error:{code:'network_error'}}));await submit();return (await journal.loadCreation(scope(),'session'))!}
test('explicit version and all roles required; cancel makes no request and confirmation creates only draft',async()=>{
 await render();expect(api.getTeamTemplate).not.toHaveBeenCalled();await fill();expect(api.getTeamTemplate).toHaveBeenCalledWith('team','template',1,expect.objectContaining({userId:2,origin:getRelayOrigin(),isCurrent:expect.any(Function)}))
 await wrapper.get('form').trigger('submit');await click('取消');expect(api.createTemplateTask).not.toHaveBeenCalled();await submit()
 expect(api.createTemplateTask).toHaveBeenCalledWith('team',expect.objectContaining({template_revision:1,context_version:4,role_bindings:{worker:'offer',reviewer:2}}),expect.objectContaining({userId:2,origin:getRelayOrigin(),isCurrent:expect.any(Function)}));await vi.waitFor(()=>expect(wrapper.emitted('created')).toEqual([['task']]));expect(await journal.loadCreation(scope(),'session')).toBeNull()
})
test('reopening unknown creation queries original receipt without sending again',async()=>{
 const op=await unknown();wrapper.unmount();api.findTemplateTask.mockResolvedValue({team_id:'team',actor_user_id:2,request_id:op.input.request_id,operation:'create_template_task',found:true,response:result});await render();expect(wrapper.text()).toContain('创建结果尚未确认');await click('查询原创建结果');expect(api.createTemplateTask).toHaveBeenCalledTimes(1);await vi.waitFor(()=>expect(wrapper.emitted('created')).toEqual([['task']]));expect(await journal.loadCreation(scope(),'session')).toBeNull()
})
test('explicit absence permits only confirmed original request despite newer Context and template head',async()=>{
 const op=await unknown();wrapper.unmount();api.getTeamSession.mockResolvedValue({...session,current_context_version:9});await render();await click('查询原创建结果');await click('重试原创建');await click('取消重试');expect(api.createTemplateTask).toHaveBeenCalledTimes(1);await click('重试原创建');await click('确认重试原创建');expect(api.createTemplateTask.mock.calls[1][1]).toEqual(op.input)
})
test('404 receipt lookup never unlocks retry or loses original intent',async()=>{
 const op=await unknown();api.findTemplateTask.mockRejectedValue(new TeamApiError(404,{error:{code:'request_failed'}}));await click('查询原创建结果');expect(wrapper.text()).not.toContain('重试原创建');expect(await journal.loadCreation(scope(),'session')).toEqual(op)
})
test('wrong actor or snapshot receipt is retained and never emits success',async()=>{
 const op=await unknown();for(const receipt of [{team_id:'team',actor_user_id:3,request_id:op.input.request_id,operation:'create_template_task',found:false,response:null},{team_id:'team',actor_user_id:2,request_id:op.input.request_id,operation:'create_template_task',found:true,response:{...result,call_ids:['unexpected']}}]){api.findTemplateTask.mockResolvedValue(receipt);await click('查询原创建结果');expect(wrapper.emitted('created')).toBeUndefined();expect(await journal.loadCreation(scope(),'session')).toEqual(op)}
})
test('revocation removes protected visible snapshot but retains unresolved original',async()=>{
 const op=await unknown();api.findTemplateTask.mockRejectedValue(new TeamApiError(403,{error:{code:'team_access_denied'}}));await click('查询原创建结果');expect(wrapper.find('form').exists()).toBe(false);expect(await journal.loadCreation(scope(),'session')).toEqual(op)
})
test('ordinary assignment in same session prevents a template creation',async()=>{
 await journal.reserve(scope(),{team:'team',session:'session',actor:2,input:{request_id:'regular',instruction:'Goal',acceptance:'Criteria',context_version:4,target_offer_ids:['offer']}});await render();expect(wrapper.text()).toContain('此会话有未确认分派');expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined();expect(api.createTemplateTask).not.toHaveBeenCalled()
})
test('offline Agent and unavailable reviewer do not become implicit defaults',async()=>{
 api.getTeamSession.mockResolvedValue({...session,agent_bindings:[{...session.agent_bindings[0],availability:'offline'}]});api.listTeamMembers.mockResolvedValue([{user_id:2,display_label:'Viewer',state:'active',role:'viewer'}]);await render();await wrapper.get('select[aria-label="协作模板"]').setValue('template');await wrapper.get('select[aria-label="模板版本"]').setValue('1');await click('读取所选版本');expect(wrapper.get('option[value="offer"]').attributes('disabled')).toBeDefined();expect(wrapper.find('select[aria-label="审查人 验收人"] option[value="2"]').exists()).toBe(false);expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
})
test('closed rollout still allows original receipt recovery',async()=>{
 await journal.reserve(scope(),operation);api.listTeamTemplates.mockResolvedValue({team_id:'team',writes_enabled:false,can_create:false,can_manage:false,items:[],next_cursor:null});await render();api.findTemplateTask.mockResolvedValue({team_id:'team',actor_user_id:2,request_id:'original',operation:'create_template_task',found:true,response:result});await click('查询原创建结果');await vi.waitFor(()=>expect(wrapper.emitted('created')).toEqual([['task']]));expect(api.createTemplateTask).not.toHaveBeenCalled()
})
test('late selection after account change cannot restore private template contents',async()=>{
 let release!:(value:any)=>void;api.getTeamTemplate.mockImplementation(()=>new Promise(r=>{release=r}));await render();await wrapper.get('select[aria-label="协作模板"]').setValue('template');await wrapper.findAll('button').find(b=>b.text()==='读取所选版本')!.trigger('click');await flushPromises();useAuth().user.value={id:3,email:'other@example.test',phone:null,display_name:'Other'};await flushPromises();release(template);await flushPromises();expect(wrapper.text()).not.toContain('Change files');expect(wrapper.find('textarea').exists()).toBe(false)
})

test('storage reservation failure prevents a network mutation',async()=>{
 await render();await fill();vi.mocked(teamTaskAssignmentJournal.reserve).mockRejectedValueOnce(Error('storage unavailable'));await wrapper.get('form').trigger('submit');await click('确认创建草稿');expect(api.createTemplateTask).not.toHaveBeenCalled();expect(wrapper.text()).toContain('storage unavailable')
})
test('initial authoritative conflict releases intent and requires refreshed settings',async()=>{
 await render();await fill();api.createTemplateTask.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'context_version_conflict'}}));await submit();await vi.waitFor(async()=>expect(await journal.loadCreation(scope(),'session')).toBeNull());expect(wrapper.text()).toContain('请重新读取并核对');expect(wrapper.emitted('created')).toBeUndefined()
})
test('conflict during original retry retains intent; it cannot prove earlier request did not commit',async()=>{
 const op=await unknown();await click('查询原创建结果');await click('重试原创建');api.createTemplateTask.mockRejectedValueOnce(new TeamApiError(409,{error:{code:'context_version_conflict'}}));await click('确认重试原创建');expect(await journal.loadCreation(scope(),'session')).toEqual(op);expect(wrapper.text()).not.toContain('确认重试原创建')
})
test('unexpected execution in a direct create response never releases the original',async()=>{
 await render();await fill();api.createTemplateTask.mockResolvedValueOnce({...result,execution_enabled:true,call_ids:['call']});await submit();expect(await journal.loadCreation(scope(),'session')).not.toBeNull();expect(wrapper.emitted('created')).toBeUndefined();expect(wrapper.text()).toContain('创建结果尚未确认')
})
test('ActionSelect sources remain explicitly disabled throughout unknown recovery',async()=>{
 await unknown();for(const select of wrapper.findAll('select'))expect(select.attributes('disabled')).toBeDefined()
})

test('server-valid __proto__ role is explicitly bound as an own property',async()=>{
 api.getTeamTemplate.mockResolvedValue({...template,definition:{...template.definition,roles:template.definition.roles.map(r=>r.role_id==='worker'?{...r,role_id:'__proto__'}:r),steps:template.definition.steps.map(s=>({...s,agent_role:'__proto__'}))}})
 await render();await fill();await submit();expect(api.createTemplateTask.mock.calls[0][1].role_bindings).toEqual(JSON.parse('{"__proto__":"offer","reviewer":2}'))
})
test('mutation identity lifetime expires on same-user logout-login and preserves journal on late success',async()=>{
 let release!:(value:any)=>void;api.createTemplateTask.mockImplementation(()=>new Promise(r=>{release=r}));await render();await fill();await submit()
 const identity=api.createTemplateTask.mock.calls[0][2];expect(identity.isCurrent()).toBe(true)
 useAuth().user.value=null;await flushPromises();useAuth().user.value={id:2,email:'fixture@example.test',phone:null,display_name:'Reviewer'};await settle();expect(identity.isCurrent()).toBe(false)
 release(result);await flushPromises();expect(wrapper.emitted('created')).toBeUndefined();expect(await journal.loadCreation(scope(),'session')).not.toBeNull()
})
