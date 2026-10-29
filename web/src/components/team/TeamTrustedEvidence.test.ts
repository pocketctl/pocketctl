import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, test, vi } from 'vitest'
import TeamTrustedEvidence from './TeamTrustedEvidence.vue'
import { TeamApiError } from '../../services/teamClient'
const api=vi.hoisted(()=>({readTrustedEvidence:vi.fn()}))
vi.mock('../../services/teamDeliveryClient',()=>api)
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
const report={evidence_id:'e',submission_id:'s',connector_id:'ci-unit',principal_user_id:1,connector_kind:'ci' as const,repository:'org/repo',run_id:'run-1',check_id:'unit',spec_revision:2,code_revision:'abc',result:'passed' as const,report_sha256:'hash',received_at:'2026-10-24'}
const wrappers:Array<ReturnType<typeof mount>>=[]
function render(){const w=mount(TeamTrustedEvidence,{props:{taskId:'task',currentUserId:1,submission:{submission_id:'s',spec_revision:2,code_revision:'abc'} as any,evidence:[report,{...report,evidence_id:'other',submission_id:'old',check_id:'wrong-check'}],available:true}});wrappers.push(w);return w}
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.resetAllMocks()})
test('shows only exact submission/spec/code reports and renders report text without HTML',async()=>{
 api.readTrustedEvidence.mockResolvedValue('<script>do not execute</script>');const w=render();expect(w.text()).not.toContain('wrong-check');expect(w.text()).toContain('不代替人工验收')
 await w.get('button').trigger('click');await flushPromises();expect(w.get('pre').text()).toContain('<script>');expect(w.find('script').exists()).toBe(false)
 await w.setProps({submission:{submission_id:'s',spec_revision:2,code_revision:'changed'} as any});expect(w.find('pre').exists()).toBe(false);expect(w.text()).toContain('尚无独立验证报告')
})
test('late report after account change or offline cannot refill preview',async()=>{
 let finish!:(value:string)=>void;api.readTrustedEvidence.mockImplementation(()=>new Promise(r=>finish=r));const w=render();await w.get('button').trigger('click');await w.setProps({currentUserId:2});finish('private');await flushPromises();expect(w.text()).not.toContain('private')
 await w.get('button').trigger('click');await w.setProps({available:false});finish('offline private');await flushPromises();expect(w.find('pre').exists()).toBe(false)
})
test('revocation propagates to the protected task, integrity failure remains closed',async()=>{
 api.readTrustedEvidence.mockRejectedValueOnce(new Error('校验失败'));const w=render();await w.get('button').trigger('click');await flushPromises();expect(w.find('pre').exists()).toBe(false);expect(w.text()).toContain('校验失败')
 api.readTrustedEvidence.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'team_not_found'}}));await w.get('button').trigger('click');await flushPromises();expect(w.emitted('revoked')).toHaveLength(1)
})
