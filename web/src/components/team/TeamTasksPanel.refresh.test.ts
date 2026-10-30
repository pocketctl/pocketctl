import {mount,flushPromises} from '@vue/test-utils'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {ref} from 'vue'
import TeamTasksPanel from './TeamTasksPanel.vue'
const api=vi.hoisted(()=>({listTeamTasks:vi.fn(),getTeamTask:vi.fn()}))
vi.mock('../../services/teamClient',async original=>({...await original<typeof import('../../services/teamClient')>(),...api}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
vi.mock('../../services/teamTaskHolderJournal',()=>({teamTaskHolderJournal:{load:async()=>null}}))
const user=ref({id:1})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
const task={id:'task',team_id:'team',creator_user_id:1,title:'acceptance',background:'',state:'open',holder_user_ids:[2],session_ids:['shared'],revision:1,has_delivery_contract:false}
const wrappers:ReturnType<typeof mount>[]=[]
async function render(){const w=mount(TeamTasksPanel,{props:{teamId:'team',teamCreatorId:1,currentUserId:1,writesEnabled:true,initialTaskId:'task',members:[{id:'member',user_id:2,display_label:'Reviewer'}] as any,sessions:[{id:'shared',task_id:'older-task',title:'Shared execution',participants:[],agent_bindings:[]}] as any},global:{stubs:{TeamOverlay:{template:'<section><slot/><slot name="footer"/></section>'},RouterLink:{template:'<a><slot/></a>'},ActionSelect:{template:'<span><slot/></span>'},ActionList:true,WorkspaceIcon:true}}});wrappers.push(w);await flushPromises();return w}
beforeEach(()=>{vi.resetAllMocks();api.listTeamTasks.mockResolvedValue([task]);api.getTeamTask.mockResolvedValue(task);vi.spyOn(navigator,'onLine','get').mockReturnValue(true)})
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.restoreAllMocks()})
test('explicit holder refresh updates surrounding names and administrator checkbox after another member releases',async()=>{
 const w=await render();expect(w.get('.holder-row').text()).toContain('Reviewer');expect((w.get('.holder-editor input').element as HTMLInputElement).checked).toBe(true)
 api.getTeamTask.mockResolvedValue({...task,revision:2,holder_user_ids:[]})
 const reload=w.findAll('button').find(b=>b.text()==='team.holder.reload')!
 await reload.trigger('click');await flushPromises()
 expect(w.get('.holder-row').text()).toContain('team.unclaimed')
 expect((w.get('.holder-editor input').element as HTMLInputElement).checked).toBe(false)
})
test('call-linked sessions appear in task details even when session belongs to an older root task',async()=>{
 const w=await render();expect(w.find('.linked-session').exists()).toBe(true);expect(w.get('.linked-session').text()).toContain('Shared execution');expect(w.text()).not.toContain('replica.no_linked_sessions')
})
