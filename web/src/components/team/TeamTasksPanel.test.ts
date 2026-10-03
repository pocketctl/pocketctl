import {DOMWrapper,flushPromises,mount} from '@vue/test-utils'
import {afterEach,beforeEach,describe,expect,test,vi} from 'vitest'
import TeamTasksPanel from './TeamTasksPanel.vue'
import type {TeamTask} from '../../types/team'
vi.mock('../../composables/useLocale',async()=>{const table=(await import('../../i18n/zh.json')).default as Record<string,string>;return {useLocale:()=>({t:(key:string,params?:Record<string,string|number>)=>Object.entries(params||{}).reduce((value,[key,replacement])=>value.split('{{'+key+'}}').join(String(replacement)),table[key]||key)})}})
const api=vi.hoisted(()=>({createTeamTask:vi.fn(),deleteTeamTask:vi.fn(),listTeamTasks:vi.fn(),restoreTeamTask:vi.fn(),setTeamTaskSelfHolder:vi.fn(),setTeamTaskHolder:vi.fn(),updateTeamTask:vi.fn()}))
vi.mock('../../services/teamClient',()=>api)
const task=(id:string,state:TeamTask['state']='open'):TeamTask=>({id,team_id:'team',creator_user_id:7,title:'Task '+id,background:'Background',state,previous_state:null,revision:1,holder_user_ids:[7],session_ids:[],created_at:'',updated_at:'',deleted_at:null})
const tasks=[task('open'),task('progress','in_progress'),task('completed','completed'),task('archived','archived'),task('deleted','deleted')]
const wrappers:Array<ReturnType<typeof mount>>=[]
async function render(writesEnabled=true){const wrapper=mount(TeamTasksPanel,{attachTo:document.body,props:{teamId:'team',teamCreatorId:7,currentUserId:7,writesEnabled,members:[],sessions:[]},global:{stubs:{RouterLink:{template:'<a><slot /></a>'}}}});wrappers.push(wrapper);await flushPromises();return wrapper}
beforeEach(()=>{vi.clearAllMocks();api.listTeamTasks.mockImplementation(async()=>tasks.map(task=>({...task})));api.createTeamTask.mockResolvedValue(task('new'));api.updateTeamTask.mockImplementation(async(task:TeamTask,patch:Partial<TeamTask>)=>({...task,...patch}))})
afterEach(()=>wrappers.splice(0).forEach(wrapper=>wrapper.unmount()))
describe('Team task board',()=>{
 test('keeps state columns separate and archived tasks accessible from the action list',async()=>{
  const wrapper=await render()
  expect(wrapper.findAll('.task-column').map(column=>column.findAll('.task-card').length)).toEqual([1,1,1])
  expect(wrapper.find('[data-task-id="archived"]').exists()).toBe(false)
  await wrapper.get('.task-filter-title').trigger('click');await flushPromises()
  const list=new DOMWrapper(document.querySelector('.workspace-action-list') as HTMLElement)
  await list.findAll('.action-item')[1].trigger('click');await flushPromises()
  expect(wrapper.findAll('.task-column')).toHaveLength(1)
  expect(wrapper.get('[data-task-id="archived"]').text()).toContain('Task archived')
  expect(wrapper.find('[data-task-id="open"]').exists()).toBe(false)
 })
 test('retains creation, editing and state changes through the restored form controls',async()=>{
  const wrapper=await render()
  await wrapper.get('[data-testid="team-new-task"]').trigger('click');await flushPromises()
  await wrapper.get('#team-task-create-form input').setValue('New title');await wrapper.get('#team-task-create-form textarea').setValue('New background')
  expect(wrapper.get('button[form="team-task-create-form"]').attributes('type')).toBe('submit')
  await wrapper.get('#team-task-create-form').trigger('submit');await flushPromises()
  expect(api.createTeamTask).toHaveBeenCalledWith('team','New title','New background')
  await wrapper.get('[data-task-id="open"] .icon-btn').trigger('click');await flushPromises()
  await wrapper.get('.team-overlay-panel>footer .primary').trigger('click');await flushPromises()
  await wrapper.get('#team-task-edit-form input').setValue('Updated title');await wrapper.get('#team-task-edit-form').trigger('submit');await flushPromises()
  expect(api.updateTeamTask).toHaveBeenCalledWith(tasks[0],{title:'Updated title',background:'Background'})
  await wrapper.get('select[aria-label="任务状态"]').setValue('in_progress');await flushPromises()
  expect(api.updateTeamTask).toHaveBeenLastCalledWith(expect.objectContaining({id:'open',title:'Updated title'}),{state:'in_progress'})
  expect(wrapper.findAll('.task-column')[1].findAll('.task-card')).toHaveLength(2)
 })
 test('keeps task details readable without exposing mutations in readonly mode',async()=>{
  const wrapper=await render(false)
  expect(wrapper.find('[data-testid="team-new-task"]').exists()).toBe(false)
  await wrapper.get('[data-task-id="open"]').trigger('keydown',{key:'Enter'});await flushPromises()
  expect(wrapper.get('.team-overlay-panel').text()).toContain('Task open')
  expect(wrapper.find('.task-actions').exists()).toBe(false)
  expect(wrapper.find('.team-overlay-panel>footer .primary').exists()).toBe(false)
  expect(api.updateTeamTask).not.toHaveBeenCalled()
 })
})
