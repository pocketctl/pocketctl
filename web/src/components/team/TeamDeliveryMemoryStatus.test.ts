import {flushPromises,mount} from '@vue/test-utils'
import {beforeEach,expect,test,vi} from 'vitest'
import {ref} from 'vue'
const client=vi.hoisted(()=>({read:vi.fn()}))
const user=ref({id:1})
vi.mock('../../services/teamDeliveryMemoryClient',()=>({readDeliveryMemoryStatus:client.read}))
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'local'}))
vi.mock('../../services/teamDeliveryCache',()=>({deliveryCacheScope:()=> 'scope'}))
import Component from './TeamDeliveryMemoryStatus.vue'
const submission={submission_id:'sub',decision_id:'decision',decision:'accepted',personal_memory_capture:'captured'} as any
const props={taskId:'task',teamId:'team',currentUserId:1,available:true,submission}
const status={source:{task_id:'task',submission_id:'sub',decision_id:'decision',spec_revision:4,submission_version:2,state:'available'},candidates:{pending:1,stale:0,rejected:0},personal_claims:{confirmed:0,current:0},extraction_state:'succeeded'}
const options={global:{stubs:{RouterLink:{props:['to'],template:'<a :data-target="JSON.stringify(to)"><slot/></a>'}}}}
beforeEach(()=>{client.read.mockReset().mockResolvedValue(status);user.value={id:1}})
test('links exact submission and decision into the existing personal review flow',async()=>{
 const w=mount(Component,{props,...options});await flushPromises()
 expect(w.text()).toContain('待个人确认 1 条');expect(w.text()).toContain('不会自动发布到团队')
 expect(JSON.parse(w.get('a').attributes('data-target')!)).toEqual({path:'/memory',query:{tab:'review',submission:'sub',decision:'decision'}})
 w.unmount()
})
test('never queries Memory for uncaptured or withdrawn deliveries',async()=>{
 const w=mount(Component,{props:{...props,submission:{...submission,personal_memory_capture:'not_captured'}},...options});await flushPromises()
 expect(w.text()).toContain('未向你的个人 Memory 提供来源');expect(client.read).not.toHaveBeenCalled()
 await w.setProps({submission:{...submission,personal_memory_capture:'withdrawn'}})
 expect(w.text()).toContain('来源已失效');expect(w.find('a').exists()).toBe(false);expect(client.read).not.toHaveBeenCalled();w.unmount()
})
test('does not treat empty Memory records as extracted candidates',async()=>{
 client.read.mockResolvedValue({source:null});const w=mount(Component,{props,...options});await flushPromises()
 expect(w.text()).toContain('不代表候选已生成');expect(w.text()).not.toContain('候选已生成，等待');w.unmount()
})
test('drops a late source read after task revocation',async()=>{
 let resolve!:(r:unknown)=>void;client.read.mockImplementation(()=>new Promise(r=>{resolve=r}))
 const w=mount(Component,{props,...options});await flushPromises()
 window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail:{scope:'scope',task:'task'}}))
 resolve(status);await flushPromises()
 expect(w.find('a').exists()).toBe(false);expect(w.text()).not.toContain('待个人确认 1 条');expect(w.text()).toContain('重新核对任务访问权限');w.unmount()
})
