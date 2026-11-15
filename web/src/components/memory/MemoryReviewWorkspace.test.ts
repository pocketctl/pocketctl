import { mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import MemoryReviewWorkspace from './MemoryReviewWorkspace.vue'
test('review tabs keep automatic mode discovery and all slot drafts mounted',async()=>{
 const wrapper=mount(MemoryReviewWorkspace,{attachTo:document.body,props:{lifecycleMode:'enabled'},slots:{automatic:'<input data-testid="automatic-state" value="pending">',personal:'<input data-testid="personal-draft">',shared:'<span>shared controls</span>'}})
 expect(wrapper.text()).toContain('memory.ui.review.legacy')
 const tabs=wrapper.findAll('[role="tab"]')
 await tabs[1]!.trigger('click')
 expect(wrapper.find('[data-testid="automatic-state"]').exists()).toBe(true)
 expect(wrapper.get('[data-testid="automatic-state"]').isVisible()).toBe(false)
 await wrapper.get('[data-testid="personal-draft"]').setValue('draft')
 await tabs[2]!.trigger('click');await tabs[1]!.trigger('click')
 expect(wrapper.get<HTMLInputElement>('[data-testid="personal-draft"]').element.value).toBe('draft')
 await wrapper.setProps({lifecycleMode:'shadow'})
 expect(wrapper.text()).toContain('memory.ui.review.observation')
})
test('delivery deep link selects personal while automatic stays mounted',()=>{
 const wrapper=mount(MemoryReviewWorkspace,{attachTo:document.body,props:{initialSection:'personal',lifecycleMode:'unknown'},slots:{automatic:'<span data-testid="mode-read">mode</span>',personal:'personal'}})
 expect(wrapper.findAll('[role="tab"]')[1]!.attributes('aria-selected')).toBe('true')
 expect(wrapper.find('[data-testid="mode-read"]').exists()).toBe(true)
})
