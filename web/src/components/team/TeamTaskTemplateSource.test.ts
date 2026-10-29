import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {flushPromises,mount} from '@vue/test-utils'
import {ref} from 'vue'
const api=vi.hoisted(()=>({read:vi.fn()}))
vi.mock('../../services/teamTemplateClient',()=>({getTaskTemplateSource:api.read}))
const user=ref<{id:number}|null>({id:2})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'local'}))
import TeamTaskTemplateSource from './TeamTaskTemplateSource.vue'
import {template,operation} from '../../services/__tests__/fixtures/teamTemplate'
import {TeamApiError} from '../../services/teamClient'
import {validTaskTemplateSource} from '../../types/teamTemplate'
const response=()=>({task_id:'task',source:{template_id:template.template_id,template_revision:1,content_hash:template.content_hash,snapshot:structuredClone(template.definition),role_bindings:{...operation.input.role_bindings}}})
const wrappers:ReturnType<typeof mount>[]=[]
async function render(){const w=mount(TeamTaskTemplateSource,{props:{teamId:'team',taskId:'task',currentUserId:2,available:true}});wrappers.push(w);await flushPromises();return w}
beforeEach(()=>{vi.resetAllMocks();user.value={id:2};api.read.mockResolvedValue(response())})
afterEach(()=>wrappers.splice(0).forEach(w=>w.unmount()))
test('shows immutable version and original bindings; budget remains advice',async()=>{const w=await render();expect(w.text()).toContain('Repair v1');expect(w.text()).toContain('Agent · offer');expect(w.text()).toContain('成员 2');expect(w.text()).toContain('实际限制以执行预算为准');expect(api.read).toHaveBeenCalledTimes(1);expect(api.read.mock.calls[0].slice(0,2)).toEqual(['team','task']);expect(w.find('button').exists()).toBe(false)})
test('ordinary task hides template section',async()=>{api.read.mockResolvedValue({task_id:'task',source:null});const w=await render();expect(w.find('[aria-label="模板来源"]').exists()).toBe(false)})
test('wrong task or malformed role mapping never displays snapshot',async()=>{api.read.mockResolvedValue({...response(),task_id:'other'});const w=await render();expect(w.text()).not.toContain('Repair');expect(w.text()).toContain('无法核对');const r=response();r.source.role_bindings.reviewer='2';expect(validTaskTemplateSource(r,'task')).toBe(false)})
test('offline cancels response lifetime and cannot restore private content',async()=>{let finish!:(v:unknown)=>void;api.read.mockImplementationOnce(()=>new Promise(r=>finish=r));const w=await render(),id=api.read.mock.calls[0][2];await w.setProps({available:false});expect(id.isCurrent()).toBe(false);finish(response());await flushPromises();expect(w.text()).not.toContain('Repair')})
test('account switch clears source before reread',async()=>{const w=await render();user.value={id:3};await flushPromises();expect(w.text()).not.toContain('Repair');expect(api.read).toHaveBeenCalledTimes(1)})
test('revocation clears source and invalidates in-flight HTTP identity',async()=>{const w=await render(),id=api.read.mock.calls[0][2];window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail:{team:'team'}}));await flushPromises();expect(w.text()).not.toContain('Repair');expect(id.isCurrent()).toBe(false);expect(w.emitted('revoked')).toHaveLength(1)})
test('route absence differs from permission loss, retry can recover',async()=>{api.read.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'request_failed'}}));const w=await render();expect(w.text()).toContain('暂不支持');expect(w.emitted('revoked')).toBeUndefined();await w.get('button').trigger('click');await flushPromises();expect(w.text()).toContain('Repair v1')})
test('permission error revokes parent task',async()=>{api.read.mockRejectedValueOnce(new TeamApiError(403,{error:{code:'team_access_denied'}}));const w=await render();expect(w.emitted('revoked')).toHaveLength(1);expect(w.text()).not.toContain('Repair')})
test('file-only or another team invalidation does not discard source',async()=>{const w=await render();for(const detail of [{filesOnly:true},{team:'other'}])window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail}));await flushPromises();expect(w.text()).toContain('Repair v1');expect(w.emitted('revoked')).toBeUndefined()})
