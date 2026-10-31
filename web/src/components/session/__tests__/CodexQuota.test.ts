import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import { beforeEach, test, expect, vi } from 'vitest'
import CodexQuota from '../CodexQuota.vue'
import { useLocale } from '../../../composables/useLocale'
const fixture=vi.hoisted(()=>({snapshot:null as any,refresh:vi.fn()}))
vi.mock('../../../composables/useCodexQuota',()=>({useCodexQuota:()=>({snapshot:fixture.snapshot,loading:ref(false),failed:ref(false),online:ref(true),stale:ref(false),refresh:fixture.refresh})}))
vi.mock('../../../composables/useWebSocket',()=>({useWebSocket:()=>({send:vi.fn(),onEvent:()=>()=>{}})}))
vi.mock('../../../composables/useAuth',()=>({useAuth:()=>({user:ref({id:7})})}))
vi.mock('../../../composables/useEnv',()=>({getRelayWs:()=> 'ws://fixture'}))
const window=(duration:number,remaining=8)=>({remaining_percent:remaining,duration_minutes:duration,resets_at:null})
const snapshot=(plan='pro',count:number|null=0,windows=[window(10080)])=>({kind:'codex_rate_limits',scope_id:'account',status:'ok',plan_type:plan,exhausted:false,observed_at:'2026-10-31T01:00:00Z',buckets:[{id:'codex',name:'Codex',exhausted:false,windows}],reset_credits:count===null?null:{available_count:count,credits:null}})
beforeEach(()=>{useLocale().setLocale('en');fixture.snapshot=ref(snapshot());fixture.refresh.mockClear()})
function start(variant:'agent'|'session'='agent'){return mount(CodexQuota,{attachTo:document.body,props:{sessionId:'s',daemonId:'d',hostname:'Mac',variant}})}
test('opens real duration windows and restores focus on close',async()=>{
 fixture.snapshot.value=snapshot('plus',0,[window(300)])
 const wrapper=start();const button=wrapper.get('.codex-quota-entry');(button.element as HTMLElement).focus();await button.trigger('click');await nextTick()
 const dialog=document.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('5-hour limit');expect(dialog.textContent).toContain('8%')
 ;(dialog.querySelector('header button') as HTMLElement).click();await nextTick();expect(document.activeElement).toBe(button.element);wrapper.unmount()
})
test('Pro weekly-only data never invents a five-hour limit and zero cards disappear completely',async()=>{
 const wrapper=start();expect(wrapper.text()).toContain('Pro');expect(wrapper.text()).not.toContain('Reset credits')
 await wrapper.get('button').trigger('click');const dialog=document.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('Weekly limit');expect(dialog.textContent).not.toMatch(/5-hour|reset credit/i);expect(dialog.querySelector('h2')?.textContent).toBe('Codex usage limits');wrapper.unmount()
})
test('unknown cards remain unknown, while a capped detail list does not replace the authoritative count',async()=>{
 fixture.snapshot.value=snapshot('pro',null);const wrapper=start();await wrapper.get('button').trigger('click')
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Reset credit information is unavailable')
 fixture.snapshot.value={...snapshot('pro',3),reset_credits:{available_count:3,credits:[{expires_at:null}]}};await nextTick()
 const dialog=document.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('3 credits');expect(dialog.textContent).toContain('details for 1 credits');expect(dialog.querySelector('summary')).not.toBeNull();wrapper.unmount()
})
test('session mode takes no conversation space and exposes only menu metadata and presentation',async()=>{
 const wrapper=start('session');expect(wrapper.find('.codex-quota-entry').exists()).toBe(false);expect(wrapper.text()).toBe('')
 const api=wrapper.vm as unknown as {show():void;title:string;summary:string};expect(api.title).toBe('Codex usage limits');expect(api.summary).not.toMatch(/reset/i);api.show();await nextTick();expect(document.querySelector('[role="dialog"]')).not.toBeNull();wrapper.unmount()
})
test('a missing Plus five-hour window stays unknown instead of being treated as unrestricted',async()=>{
 fixture.snapshot.value=snapshot('plus',0);const wrapper=start();await wrapper.get('button').trigger('click')
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('5-hour limit');expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Unknown');wrapper.unmount()
})
