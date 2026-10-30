import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import { test, expect, vi } from 'vitest'
import CodexQuota from '../CodexQuota.vue'
import { useLocale } from '../../../composables/useLocale'
vi.mock('../../../composables/useCodexQuota',()=>({useCodexQuota:()=>({snapshot:ref({exhausted:false,observed_at:'2026-10-29T07:30:00Z',buckets:[{id:'codex',name:'Codex',exhausted:false,windows:[{remaining_percent:8,duration_minutes:300,resets_at:null}]}]}),loading:ref(false),failed:ref(false),online:ref(true),stale:ref(false),refresh:vi.fn()})}))
test('opens a modal with a dynamic window label and restores focus on close',async()=>{
 useLocale().setLocale('en')
 const wrapper=mount(CodexQuota,{attachTo:document.body,props:{sessionId:'s',daemonId:'d',hostname:'Mac'}})
 const button=wrapper.get('.codex-quota-strip');(button.element as HTMLElement).focus();await button.trigger('click');await nextTick()
 const dialog=document.querySelector('[role="dialog"]')
 expect(dialog).not.toBeNull();expect(dialog?.textContent).toContain('5-hour limit');expect(dialog?.textContent).toContain('8%')
 const close=dialog!.querySelector('button')!;close.click();await nextTick();expect(document.activeElement).toBe(button.element)
 wrapper.unmount()
})
