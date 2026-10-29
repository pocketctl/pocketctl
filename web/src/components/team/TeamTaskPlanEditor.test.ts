import {ref} from 'vue'
import {mount,flushPromises} from '@vue/test-utils'
import {beforeEach,afterEach,expect,test,vi} from 'vitest'
import TeamTaskPlanEditor from './TeamTaskPlanEditor.vue'
const api=vi.hoisted(()=>({getTaskPlan:vi.fn(),getTaskPlanEditingOptions:vi.fn()}))
const commands=vi.hoisted(()=>({submit:vi.fn(),resolve:vi.fn(),retry:vi.fn(),refresh:vi.fn()}))
const saved=ref<any>(null)
vi.mock('../../services/teamPlanClient',()=>api)
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
vi.mock('../../composables/useTeamDeliveryOperation',()=>({useTeamDeliveryOperation:()=>({...commands,pending:saved,blocked:ref(false),busy:ref(false),ready:ref(true),receiptMissing:ref(false),confirmRetry:ref(false),error:ref(''),storageError:ref('')})}))
const step={step_id:'one',title:'One',instruction:'Do',acceptance:'Check',required:true,depends_on:[],review_policy:{reviewer_user_id:1,primary_offer_id:'offer',required_checks:['unit']}}
const choices={task_id:'task',can_edit:true,revision:1,spec_revision:2,started_step_ids:[],locked_session_id:null,reviewers:[{user_id:1}],offers:[{offer_id:'offer',provider:'codex',owner_user_id:1}],sessions:[{team_session_id:'session',title:'Shared',current_context_version:4,offer_ids:['offer']}]}
const execution={task_id:'task',revision:3,can_control:true,attempts:[]} as any
const wrappers:Array<ReturnType<typeof mount>>=[]
const click=async(w:ReturnType<typeof mount>,text:string)=>{await w.findAll('button').find(b=>b.text()===text)!.trigger('click');await flushPromises()}
async function render(){const w=mount(TeamTaskPlanEditor,{props:{taskId:'task',currentUserId:1,available:true,execution}});wrappers.push(w);await flushPromises();return w}
beforeEach(()=>{vi.resetAllMocks();saved.value=null;api.getTaskPlan.mockResolvedValue({task_id:'task',revision:1,writes_enabled:true,plan:{revision:1,team_session_id:'session',steps:[step]}});api.getTaskPlanEditingOptions.mockResolvedValue(choices)})
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
test('saving a draft requires review and preserves exact CAS and current Context without activation',async()=>{
 const w=await render();await click(w,'编辑计划草稿');await w.get('[aria-label="步骤 1 标题"]').setValue('Revised')
 await w.get('form').trigger('submit');await flushPromises();expect(commands.submit).not.toHaveBeenCalled();expect(w.text()).toContain('不会激活')
 await click(w,'返回修改');expect(commands.submit).not.toHaveBeenCalled();await w.get('form').trigger('submit');await w.get('form').trigger('submit');await flushPromises()
 expect(commands.submit).toHaveBeenCalledWith({kind:'plan_draft',input:{request_id:expect.any(String),expected_revision:1,team_session_id:'session',context_version:4,spec_revision:2,steps:[{...step,title:'Revised'}]}})
})
test('started steps are disabled and cannot be removed or changed',async()=>{
 api.getTaskPlanEditingOptions.mockResolvedValue({...choices,started_step_ids:['one'],locked_session_id:'session'})
 const w=await render();await click(w,'编辑计划草稿');expect(w.get('fieldset fieldset').attributes('disabled')).toBeDefined();expect(w.get('[aria-label="计划共享会话"]').attributes('disabled')).toBeDefined()
 await click(w,'添加步骤');expect(w.findAll('legend')).toHaveLength(2)
})
test('unknown save recovery remains available after loss of controller authority',async()=>{
 saved.value={operation:{kind:'plan_draft'}};const w=await render();await w.setProps({execution:{...execution,can_control:false}})
 await click(w,'查询原草稿保存');expect(commands.resolve).toHaveBeenCalledOnce();expect(w.find('form').exists()).toBe(false)
})
test('late reads cannot restore an offline form, and inconsistent revisions fail closed',async()=>{
 let finish!:(v:unknown)=>void;api.getTaskPlanEditingOptions.mockImplementationOnce(()=>new Promise(r=>finish=r))
 const w=await render();await click(w,'编辑计划草稿');await w.setProps({available:false});finish(choices);await flushPromises();expect(w.find('form').exists()).toBe(false)
 await w.setProps({available:true});api.getTaskPlanEditingOptions.mockResolvedValue({...choices,revision:2});await click(w,'编辑计划草稿');expect(w.find('form').exists()).toBe(false);expect(w.text()).toContain('草稿版本已变化')
})

test('locked check IDs preserve whitespace exactly while editing another step',async()=>{
 const locked={...step,review_policy:{...step.review_policy,required_checks:[' unit ']}}
 api.getTaskPlan.mockResolvedValue({task_id:'task',revision:1,writes_enabled:true,plan:{revision:1,team_session_id:'session',steps:[locked,{...step,step_id:'two'}]}})
 api.getTaskPlanEditingOptions.mockResolvedValue({...choices,started_step_ids:['one'],locked_session_id:'session'})
 const w=await render();await click(w,'编辑计划草稿');await w.get('[aria-label="步骤 2 标题"]').setValue('Updated')
 expect(w.findAll('button').find(b=>b.text()==='核对草稿')!.attributes('disabled')).toBeUndefined()
 await w.get('form').trigger('submit');await w.get('form').trigger('submit');await flushPromises()
 expect(commands.submit.mock.calls[0][0].input.steps[0]).toEqual(locked)
})
