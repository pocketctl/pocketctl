import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import {ref} from 'vue'
const api=vi.hoisted(()=>({read:vi.fn(),send:vi.fn()}))
vi.mock('../../services/teamExternalRecoveryClient',()=>({readExternalRecovery:api.read,requestExternalRecovery:api.send}))
const user=ref<{id:number}|null>({id:2})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'local'}))
import TeamExternalRecovery from './TeamExternalRecovery.vue'
const response=(state='absent')=>({call_id:'call',team_session_id:'session',provider:'agentteams',call_state:'uncertain',can_query:true,can_retry_original:state==='absent',operation:{request_id:'query-1',action:'query',state:'done',result:{state,remote_task_id:null},updated_at:'2026-10-29T00:00:00Z'}})
const wrappers:ReturnType<typeof mount>[]=[]
async function render(){const w=mount(TeamExternalRecovery,{props:{sessionId:'session',callId:'call',currentUserId:2,available:true}});wrappers.push(w);await flushPromises();return w}
async function click(w:ReturnType<typeof mount>,text:string){await w.findAll('button').find(b=>b.text()===text)!.trigger('click');await flushPromises()}
beforeEach(()=>{vi.resetAllMocks();user.value={id:2};api.read.mockResolvedValue(response());api.send.mockResolvedValue({...response(),can_query:false,can_retry_original:false,operation:{...response().operation,state:'pending'}})})
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
test('query does not retry and retry requires explicit confirmation bound to original query',async()=>{const w=await render();expect(api.send).not.toHaveBeenCalled();await click(w,'重试原请求…');await click(w,'取消');expect(api.send).not.toHaveBeenCalled();await click(w,'重试原请求…');await click(w,'确认重试原请求');expect(api.send).toHaveBeenCalledTimes(1);expect(api.send.mock.calls[0].slice(0,2)).toEqual(['session','call']);expect(api.send.mock.calls[0][2]).toMatchObject({action:'retry_original',expected_query_id:'query-1'});expect(w.text()).toContain('等待原执行器响应')})
test('unknown outcome never enables retry',async()=>{api.read.mockResolvedValue(response('unknown'));const w=await render();expect(w.text()).not.toContain('重试原请求…');await click(w,'查询原执行');expect(api.send.mock.calls[0][2].action).toBe('query');expect(api.send.mock.calls[0][2].expected_query_id).toBeUndefined()})
test('lost POST reply requires read-only refresh before any further operation',async()=>{api.send.mockRejectedValue(new Error('lost reply'));const w=await render();await click(w,'查询原执行');expect(w.text()).toContain('不会自动重发');expect(w.text()).not.toContain('重试原请求…');expect(api.send).toHaveBeenCalledTimes(1);await click(w,'刷新恢复记录');expect(api.read).toHaveBeenCalledTimes(2);expect(api.send).toHaveBeenCalledTimes(1)})
test('offline clears confirmation and rejects late responses',async()=>{const w=await render();await click(w,'重试原请求…');await w.setProps({available:false});expect(w.find('[aria-label="确认重试原请求"]').exists()).toBe(false);expect(api.send).not.toHaveBeenCalled()})
test('wrong identity response and switched account cannot restore recovery authority',async()=>{api.read.mockResolvedValue({...response(),call_id:'other'});const w=await render();expect(w.text()).not.toContain('重试原请求…');user.value={id:3};await flushPromises();expect(w.text()).not.toContain('已明确查无');expect(api.read).toHaveBeenCalledTimes(1)})
