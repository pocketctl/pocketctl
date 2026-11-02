import {mount,flushPromises} from '@vue/test-utils'
import {afterEach,test,expect} from 'vitest'
import MemoryPromotionDialog from './MemoryPromotionDialog.vue'
const claim={claim:{claim_id:'one',current_version_id:'v1',revision:'1'},versions:[{version_id:'v1',statement:'A retained assertion'}]} as any
const props={claim,evidence:[{evidence_id:'proof',excerpt:'Original evidence'}],targets:[{installation_id:'target',owner_scope_kind:'team'}]}
let wrapper:ReturnType<typeof mount>|undefined
afterEach(()=>{wrapper?.unmount();document.body.replaceChildren()})
test('promotion confirms the exact target, selected evidence and explicit consent, then resets for a new claim',async()=>{
 wrapper=mount(MemoryPromotionDialog,{props,attachTo:document.body});await flushPromises()
 const select=document.querySelector<HTMLSelectElement>('.memory-promotion-target select')!;select.value='target';select.dispatchEvent(new Event('change',{bubbles:true}))
 const evidence=document.querySelector<HTMLInputElement>('.memory-promotion-evidence input')!;evidence.click()
 const consent=document.querySelector<HTMLInputElement>('[data-testid=memory-promotion-confirm]')!;consent.click();await flushPromises()
 document.querySelector<HTMLButtonElement>('[data-testid=memory-promotion-submit]')!.click();await flushPromises()
 expect(wrapper.emitted('confirm')).toEqual([[{targetInstallationId:'target',evidenceIds:['proof']}]])
 await wrapper.setProps({claim:{...claim,claim:{...claim.claim,claim_id:'two'}}});await flushPromises()
 expect(document.querySelector<HTMLButtonElement>('[data-testid=memory-promotion-submit]')!.disabled).toBe(true)
})
test('errors remain inside the dialog and ambiguous results lock the original selection',async()=>{
 wrapper=mount(MemoryPromotionDialog,{props:{...props,error:'Connection lost',uncertain:true},attachTo:document.body});await flushPromises()
 expect(document.querySelector('[role=alert]')!.textContent).toBe('Connection lost')
 expect(document.querySelector('fieldset')!.disabled).toBe(true)
 await wrapper.setProps({uncertain:false});document.querySelector<HTMLButtonElement>('.action-select-trigger')!.click();await flushPromises()
 expect(document.querySelector('dialog .action-select-content')).not.toBeNull()
})
test('no eligible target cannot submit a proposal',async()=>{
 wrapper=mount(MemoryPromotionDialog,{props:{...props,targets:[]},attachTo:document.body});await flushPromises()
 expect(document.querySelector<HTMLButtonElement>('[data-testid=memory-promotion-submit]')!.disabled).toBe(true)
})
