import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
const api=vi.hoisted(()=>({listContextPacks:vi.fn(),submitContextFeedback:vi.fn()}))
vi.mock('../../services/memoryClient',()=>api)
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import ContextPackList from './ContextPackList.vue'
const pack={pack_id:'pack-one',state:'ready',client_request_id:'request-one',created_at:'2026-11-06T00:00:00Z',delivery:{state:'delivered'}}
beforeEach(()=>{vi.resetAllMocks();api.listContextPacks.mockResolvedValue({packs:[pack]});api.submitContextFeedback.mockResolvedValue({})})
test('changing query clears old results and late responses cannot restore them',async()=>{
 let resolve!:(value:unknown)=>void
 api.listContextPacks.mockImplementationOnce(()=>new Promise(r=>resolve=r))
 const wrapper=mount(ContextPackList)
 await wrapper.get('input').setValue('old');await wrapper.get('[data-testid="pack-refresh"]').trigger('click')
 await wrapper.get('input').setValue('new');resolve({packs:[pack]});await flushPromises()
 expect(wrapper.find('[data-testid="pack-rows"]').exists()).toBe(false)
 await wrapper.get('[data-testid="pack-refresh"]').trigger('click');await flushPromises()
 expect(api.listContextPacks).toHaveBeenLastCalledWith('new')
 expect(wrapper.get('[data-testid="pack-query"]').text()).toContain('new')
})
test('load and feedback failures remain visible and feedback never reports Agent use',async()=>{
 api.listContextPacks.mockRejectedValueOnce({status:403})
 const wrapper=mount(ContextPackList);await wrapper.get('input').setValue('session');await wrapper.get('[data-testid="pack-refresh"]').trigger('click');await flushPromises()
 expect(wrapper.get('[data-testid="pack-load-error"]').text()).toContain('memory.ui.context.forbidden')
 await wrapper.get('[data-testid="pack-refresh"]').trigger('click');await flushPromises()
 api.submitContextFeedback.mockRejectedValueOnce(Error('offline'))
 await wrapper.get('[data-testid="feedback-used"]').trigger('click');await flushPromises()
 expect(wrapper.get('[data-testid="pack-feedback-status"]').text()).toContain('memory.ui.context.feedbackFailed')
 await wrapper.get('[data-testid="feedback-used"]').trigger('click');await flushPromises()
 expect(wrapper.get('[data-testid="pack-feedback-status"]').text()).toContain('memory.ui.context.feedbackRecorded')
 expect(wrapper.text()).toContain('memory.ui.context.feedbackHint')
})
