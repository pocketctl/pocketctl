import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import TeamTasksPanel from './TeamTasksPanel.vue'
import { TeamApiError } from '../../services/teamClient'
const api=vi.hoisted(()=>({listTeamTasks:vi.fn(),createTeamTask:vi.fn(),deleteTeamTask:vi.fn(),restoreTeamTask:vi.fn(),setTeamTaskHolder:vi.fn(),updateTeamTask:vi.fn()}))
vi.mock('../../services/teamClient',async original=>({...await original<typeof import('../../services/teamClient')>(),...api}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
const task={id:'task',team_id:'team',creator_user_id:1,title:'protected task',background:'protected background',state:'in_progress',holder_user_ids:[1],session_ids:[],revision:1,has_delivery_contract:true}
const wrappers:Array<ReturnType<typeof mount>>=[]
const denied=()=>new TeamApiError(404,{error:{code:'team_not_found',message:'denied'}})
async function render(){const w=mount(TeamTasksPanel,{props:{teamId:'team',teamCreatorId:1,currentUserId:1,writesEnabled:true,initialTaskId:'task'},global:{stubs:{TeamTaskRequirementsPanel:{name:'TeamTaskRequirementsPanel',template:'<div>requirements</div>'},TeamTaskHolderPanel:{name:'TeamTaskHolderPanel',emits:['revoked','changed'],template:'<button data-testid="holder-revoke" @click="$emit(\'revoked\')">holder revoke</button>'},TeamOverlay:{template:'<section><slot/><slot name="footer"/></section>'},TeamTaskDeliveryPanel:{name:'TeamTaskDeliveryPanel',emits:['revoked','changed'],template:'<button data-testid="revoke" @click="$emit(\'revoked\')">revoke</button>'},ActionSelect:{template:'<span><slot/></span>'},ActionList:true,WorkspaceIcon:true}}});wrappers.push(w);await flushPromises();return w}
beforeEach(()=>{vi.resetAllMocks();api.listTeamTasks.mockResolvedValue([task])})
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
test('delivery denial clears the surrounding task and ignores an older list response',async()=>{
 const w=await render();expect(w.text()).toContain('protected background')
 let finish!:(value:unknown)=>void;api.listTeamTasks.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
 w.findComponent({name:'TeamTaskDeliveryPanel'}).vm.$emit('changed');await flushPromises()
 api.listTeamTasks.mockRejectedValueOnce(denied());await w.get('[data-testid="revoke"]').trigger('click');await flushPromises()
 finish([task]);await flushPromises();expect(w.text()).not.toContain('protected');expect(w.text()).toContain('denied');expect(w.find('[data-testid="revoke"]').exists()).toBe(false)
})
test('late mutation cannot restore task content after its delivery permission is revoked',async()=>{
 const w=await render();let finish!:(value:unknown)=>void;api.updateTeamTask.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
 await w.get('[aria-label="team.task_state_label"]').setValue('open')
 expect(api.updateTeamTask).toHaveBeenCalledTimes(1)
 api.listTeamTasks.mockRejectedValueOnce(denied());await w.get('[data-testid="revoke"]').trigger('click');await flushPromises()
 finish({...task,title:'late secret'});await flushPromises();expect(w.text()).not.toContain('late secret');expect(w.text()).not.toContain('protected')
})
test('readiness pool selection requests authenticated server filter and preserves all default',async()=>{
 const w=await render();expect(w.find('[aria-label="team.requirements.pool"]').exists()).toBe(false)
 await w.setProps({readinessEnabled:true});await w.get('[aria-label="team.requirements.pool"]').setValue('mine');await flushPromises()
 expect(api.listTeamTasks).toHaveBeenLastCalledWith('team',false,'mine')
 await w.get('[aria-label="team.requirements.pool"]').setValue('all');await flushPromises()
 expect(api.listTeamTasks).toHaveBeenLastCalledWith('team',true,'all')
})

test('holder permission denial clears parent protected content',async()=>{
 const w=await render();api.listTeamTasks.mockRejectedValueOnce(denied());await w.get('[data-testid="holder-revoke"]').trigger('click');await flushPromises();expect(w.text()).not.toContain('protected');expect(w.text()).toContain('denied')
})

test('plain task deep link keeps task content and opens requirements without probing delivery',async()=>{
 api.listTeamTasks.mockResolvedValue([{...task,has_delivery_contract:false}])
 const w=await render()
 await w.setProps({readinessEnabled:true});await flushPromises()
 expect(w.text()).toContain('protected background')
 expect(w.findComponent({name:'TeamTaskDeliveryPanel'}).exists()).toBe(false)
 expect(w.find('[data-testid="task-delivery-open"]').exists()).toBe(false)
 expect(w.findComponent({name:'TeamTaskRequirementsPanel'}).exists()).toBe(true)
})
