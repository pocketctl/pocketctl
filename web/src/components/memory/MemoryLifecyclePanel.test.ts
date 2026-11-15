import {flushPromises,mount} from '@vue/test-utils'
import {beforeEach,expect,test,vi} from 'vitest'
const read=vi.hoisted(()=>vi.fn())
vi.mock('../../services/memoryClient',()=>({getMemoryLifecycleStatus:read}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import MemoryLifecyclePanel from './MemoryLifecyclePanel.vue'
const snapshot=(mode='enabled')=>({mode,personal:true,consume_mode:'off',cold_mode:'off',reclaim_mode:'off',bundles:{failed:2,blocked:1},runs:{provider_result_unknown:1},receipts:{provenance_unknown:3},usage:{input_tokens:25,output_tokens:10},oldest_pending_seconds:null,records:[],has_more:false})
beforeEach(()=>read.mockReset())
test('AC-41 enabled personal offers processing and explicitly expandable legacy review',async()=>{
 read.mockResolvedValue(snapshot())
 const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'},slots:{default:'legacy candidates'}});await flushPromises()
 expect(wrapper.text()).toContain('memory.lifecycle.enabled_copy')
 expect(wrapper.get('[data-testid="lifecycle-legacy-review"]').attributes('open')).toBeUndefined()
 expect(wrapper.get('[data-testid="lifecycle-legacy-review"]').text()).toContain('legacy candidates')
 expect(wrapper.emitted('mode')?.at(-1)).toEqual(['enabled'])
 expect(wrapper.text()).toContain('memory.lifecycle.provenance_unknown');wrapper.unmount()
})
test('AC-41 off and shadow retain legacy review without pretending automatic writing',async()=>{
 for(const mode of ['off','shadow']){read.mockResolvedValue(snapshot(mode));const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'},slots:{default:'legacy candidates'}});await flushPromises();expect(wrapper.find('details').exists()).toBe(false);expect(wrapper.text()).toContain('legacy candidates');expect(wrapper.text()).toContain('memory.lifecycle.legacy_copy');wrapper.unmount()}
})
test('AC-44 load failure is unknown not empty success and refresh recovers',async()=>{
 read.mockRejectedValueOnce(Error('credential-canary')).mockResolvedValueOnce(snapshot())
 const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'}});await flushPromises()
 expect(wrapper.find('[role="alert"]').exists()).toBe(true);expect(wrapper.text()).not.toContain('credential-canary');expect(wrapper.find('[data-testid="lifecycle-empty"]').exists()).toBe(false)
 await wrapper.get('button').trigger('click');await flushPromises();expect(wrapper.find('[data-testid="lifecycle-empty"]').exists()).toBe(true);wrapper.unmount()
})
test('AC-44 late response after scope change cannot replace current data',async()=>{
 let resolve!:(value:unknown)=>void;read.mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce(snapshot('off'))
 const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'}});await wrapper.setProps({installationId:'two'});await flushPromises();resolve(snapshot());await flushPromises();expect(wrapper.text()).toContain('memory.lifecycle.legacy_copy');expect(wrapper.emitted('mode')?.at(-1)).toEqual(['off']);wrapper.unmount()
})
test('AC-46 assessment unknown outcome remains distinct from a completed low-value result',async()=>{
 read.mockResolvedValue({...snapshot(),assessments:{provider_result_unknown:2,completed:0},assessment_usage:{input_tokens:8,output_tokens:2}})
 const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'}});await flushPromises()
 expect(wrapper.get('[data-testid="lifecycle-assessments"]').text()).toContain('memory.lifecycle.assessments')
 expect(wrapper.get('[data-testid="lifecycle-assessments"]').text()).toContain('8 / 2');wrapper.unmount()
})

test('processing records select full result and source without hiding unknown notices',async()=>{
 read.mockResolvedValue({...snapshot(),records:[{bundle_id:'source-1',state:'failed',reason:'failed',updated_at:'2026-11-06T00:00:00Z',run_state:'failed',run_reason:'failed',action:null,decision_state:null,decision_reason:''},{bundle_id:'source-2',state:'completed',reason:'completed',updated_at:'2026-11-06T00:01:00Z',run_state:null,run_reason:'',action:'accepted',decision_state:'completed',decision_reason:'completed'}]})
 const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'}});await flushPromises()
 await wrapper.get('[data-testid="lifecycle-record-source-2"]').trigger('click')
 expect(wrapper.get('[data-testid="lifecycle-record-detail"]').text()).toContain('source-2')
 expect(wrapper.get('[data-testid="lifecycle-provenance-unknown"]').isVisible()).toBe(true)
 wrapper.unmount()
})

test('assessment provider unknown remains immediately visible beside actual configuration fences',async()=>{
 read.mockResolvedValue({...snapshot(),configured_mode:'enabled',policy_mode:'shadow',revision:8,assessments:{provider_result_unknown:2},assessment_usage:{input_tokens:4,output_tokens:1}})
 const wrapper=mount(MemoryLifecyclePanel,{props:{installationId:'one'}});await flushPromises()
 expect(wrapper.get('[data-testid="lifecycle-assessment-unknown"]').element.closest('details')).toBeNull()
 expect(wrapper.get('[data-testid="lifecycle-mode-fences"]').text()).toContain('enabled')
 expect(wrapper.get('[data-testid="lifecycle-mode-fences"]').text()).toContain('shadow')
 wrapper.unmount()
})
