import {describe,it,expect,vi,beforeEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {useLocale} from '../../composables/useLocale'
import TokenUsage from '../TokenUsage.vue'
import fixture from '../../../../tests/fixtures/usage-analytics/personal-v1.json'
vi.mock('vue-router',()=>({useRoute:()=>({query:{daemon:'usage-fixture-mac'}})}))
vi.mock('../../composables/useAuth',async()=>{const {ref}=await import('vue');return {useAuth:()=>({accessToken:ref('fixture'),user:ref({id:1}),apiGetAuth:async(url:string,options?:RequestInit)=>{const r=await fetch(url,options);return {ok:r.ok,status:r.status,data:await r.json()}}})}})
beforeEach(()=>{useLocale().setLocale('zh');vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.startsWith('/api/tokens/sessions')?structuredClone(fixture.sessions):url.startsWith('/api/usage/calls')?structuredClone(fixture.calls):structuredClone(fixture.dashboard)})));HTMLDialogElement.prototype.showModal=function(){this.open=true};HTMLDialogElement.prototype.close=function(){this.open=false}})
describe('personal-v1 TokenUsage',()=>{
 it('formats Token totals while keeping request counts exact',async()=>{
  const data=structuredClone(fixture.dashboard)
  data.overview.all.total='62103174781';data.analysis.total='1500000';data.analysis.requests='1500'
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})))
  const w=mount(TokenUsage);await flushPromises()
  expect(w.find('.pu-summary b').text()).toBe('62G')
  expect(w.text()).toContain('2M');expect(w.text()).toContain('1,500')
  w.unmount()
 })

 it('retains host deep link, explicit contract and fixed365 overview',async()=>{const w=mount(TokenUsage);await flushPromises();expect(fetch).toHaveBeenCalledWith('/api/tokens/dashboard?contract=personal-v1&daemon=usage-fixture-mac&range=30d',expect.objectContaining({signal:expect.anything()}));expect(w.text()).toContain('近365天');expect(w.text()).toContain('11K');expect(w.findAll('.calendar button')).toHaveLength(90);w.unmount()})
 it('shows unknown as dash, keeps all distribution categories and read-only overview',async()=>{const data=structuredClone(fixture.dashboard);data.analysis.requests=null as any;vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));const w=mount(TokenUsage);await flushPromises();expect(w.text()).toContain('—');expect(w.findAll('.pu-summary button')).toHaveLength(0);await w.findAll('.pu-segment button')[2]!.trigger('click');expect(w.text()).toContain('fixture-model-a');expect(w.text()).toContain('fixture-model-b');w.unmount()})
 it('loads sessions by server paging and snapshot, never per daemon fanout',async()=>{const w=mount(TokenUsage);await flushPromises();await w.get('[role="tablist"]').findAll('button')[2]!.trigger('click');await flushPromises();expect(w.text()).toContain('Personal usage synthetic fixture');const requests=(fetch as any).mock.calls.map((r:any)=>r[0]);expect(requests.some((r:string)=>r.includes('snapshot_token=synthetic-fixture-snapshot')&&r.includes('limit=20'))).toBe(true);expect(requests.some((r:string)=>r.includes('by-daemon'))).toBe(false);w.unmount()})
 it('I11 opens a nearby-scope dialog and closes it when host changes',async()=>{const original=HTMLElement.prototype.matches;vi.spyOn(HTMLElement.prototype,'matches').mockImplementation(function(this:HTMLElement,selector){return selector===':popover-open'?false:original.call(this,selector)});const w=mount(TokenUsage);await flushPromises();await w.findAll('button').find(b=>b.text()==='统计说明')!.trigger('click');await flushPromises();expect((w.get('dialog').element as HTMLDialogElement).open).toBe(true);await w.get('select[aria-label="统计主机"]').setValue('all');await flushPromises();expect((w.get('dialog').element as HTMLDialogElement).open).toBe(false);w.unmount();vi.restoreAllMocks()})
 it('rejects old success response as upgrade required',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({summary:{total:0}})})));const w=mount(TokenUsage);await flushPromises();expect(w.text()).toContain('服务需升级');expect(w.findAll('.pu-summary')).toHaveLength(0);w.unmount()})
})

it('closes the open usage dialog and removes protected detail on snapshot authorization failure', async () => {
  const original = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function(this: HTMLElement, selector) {
    return selector === ':popover-open' ? false : original.call(this, selector)
  })
  let coverageReads = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (!path.startsWith('/api/usage/coverage?')) return { ok: true, status: 200, json: async () => fixture.dashboard }
    if (++coverageReads === 1) return { ok: true, status: 200, json: async () => fixture.coverage }
    return { ok: false, status: 409, json: async () => ({ error: 'snapshot_authorization_changed' }) }
  }))
  const w = mount(TokenUsage)
  await flushPromises()
  const coverage = w.findAll('button').find(button => button.text() === '数据覆盖')!
  await coverage.trigger('click')
  await flushPromises()
  expect((w.get('dialog').element as HTMLDialogElement).open).toBe(true)
  await coverage.trigger('click')
  await flushPromises()
  expect((w.get('dialog').element as HTMLDialogElement).open).toBe(false)
  expect(w.get('#usage-detail-title').text()).toBe('')
  expect(w.find('.pu-overview').exists()).toBe(false)
  expect(w.get('[role="alert"]').text()).toContain('snapshot_authorization_changed')
  w.unmount()
  vi.restoreAllMocks()
})
