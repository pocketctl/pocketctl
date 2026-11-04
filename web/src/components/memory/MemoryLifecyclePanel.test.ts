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
