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

it('keeps the range control, overview and folded heatmap mounted while a new range loads or fails', async () => {
  let finish!: (response: unknown) => void
  const request = vi.fn(async (path: string) => {
    if (path.includes('range=today')) return new Promise(resolve => { finish = resolve })
    return { ok: true, json: async () => structuredClone(fixture.dashboard) }
  })
  vi.stubGlobal('fetch', request)
  const w = mount(TokenUsage, { attachTo: document.body })
  await flushPromises()
  const range = w.get('select[aria-label="分析时间范围"]')
  const overview = w.get('.pu-overview').element
  const heatmap = w.get('button[aria-expanded]')
  await heatmap.trigger('click')
  ;(range.element as HTMLSelectElement).focus()
  await range.setValue('today')
  await flushPromises()

  expect(w.get('.pu-overview').element).toBe(overview)
  expect(w.get('button[aria-expanded]').element).toBe(heatmap.element)
  expect(heatmap.attributes('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(range.element)
  expect(w.get('[role="status"]').text()).toContain('正在加载用量')
  expect(w.find('.pu-statline').exists()).toBe(false)

  finish({ ok: false, status: 503, json: async () => ({ error: 'usage_query_timeout' }) })
  await flushPromises()
  expect(w.get('[role="alert"]').text()).toContain('usage_query_timeout')
  expect(w.get('.pu-overview').element).toBe(overview)
  await w.get('[role="alert"] button').trigger('click')
  await flushPromises()
  expect(request.mock.calls.filter(([path]) => path.includes('range=today'))).toHaveLength(2)
  finish({ ok: true, json: async () => fixture.dashboard })
  await flushPromises()
  expect(w.text()).toContain('今日用量构成')
  expect(heatmap.attributes('aria-expanded')).toBe('false')
  w.unmount()
})

it.each([
  { input: null, output: null, total: '10800', label: '未确认构成', amount: '11K' },
  { input: '4950', output: null, total: '10800', label: '未确认构成', amount: '11K' },
  { input: null, output: null, total: null, label: '未确认构成', amount: '—' },
])('keeps the total and explains unavailable composition without assigning shares ($input / $output / $total)', async scenario => {
  const data = structuredClone(fixture.dashboard)
  Object.assign(data.analysis, { input: scenario.input, output: scenario.output, total: scenario.total })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
  const w = mount(TokenUsage)
  await flushPromises()
  expect(w.get('.pu-unconfirmed-composition small').text()).toBe(scenario.label)
  expect(w.get('.pu-unconfirmed-composition strong').text()).toBe(scenario.amount)
  expect(w.find('.pu-donut').exists()).toBe(false)
  w.unmount()
})

it('uses each confirmed component in the donut including cache creation', async () => {
  const w = mount(TokenUsage)
  await flushPromises()
  expect(w.get('.pu-donut').attributes('style')).toMatch(/#7caa8c 95\.8[0-9]*% 100%/)
  w.unmount()
})

it.each(['today', '7d'])('shows one missing-data message and no empty composition graphic for %s', async range => {
  const data = structuredClone(fixture.dashboard)
  Object.assign(data.analysis, { input: null, output: null, cache_read: null, cache_create: null, total: '10800' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
  const w = mount(TokenUsage)
  await flushPromises()
  await w.get('select[aria-label="分析时间范围"]').setValue(range)
  await flushPromises()
  const composition = w.get('.pu-two > section:last-child')
  expect(composition.get('.pu-unconfirmed-composition strong').text()).toBe('11K')
  expect(composition.get('small').text()).toBe('未确认构成')
  expect(composition.findAll('.pu-kv')).toHaveLength(0)
  expect(w.find('.pu-composition-bar').exists()).toBe(false)
  expect(w.text()).not.toContain('— · —')
  expect(w.get('.pu-statline').text()).toContain('总量11K')
  w.unmount()
})

it.each(['today', '7d'])('keeps a single dash for a missing component and a valid share for a confirmed zero on %s', async range => {
  const data = structuredClone(fixture.dashboard)
  Object.assign(data.analysis, { input: '900', output: null, cache_read: '0', cache_create: null, total: '1000' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
  const w = mount(TokenUsage)
  await flushPromises()
  await w.get('select[aria-label="分析时间范围"]').setValue(range)
  await flushPromises()
  expect(w.findAll('.pu-two > section:last-child .pu-kv b').map(row => row.text())).toEqual([
    '900 · 90.0%', '—', '0 · 0.0%', '—',
  ])
  expect(w.find('.pu-donut').exists()).toBe(false)
  w.unmount()
})

it.each(['today', '7d'])('reconciles the four confirmed subtotals and a separately labelled remainder for %s', async range => {
  const data = structuredClone(fixture.dashboard)
  Object.assign(data.analysis, { input: null, output: null, cache_read: null, cache_create: null, total: '100000' })
  Object.assign(data, { composition: { input: '30000', output: '10000', cache_read: '30000', cache_create: '3437',
    known_total: '73437', unknown_total: '26563' } })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
  const w = mount(TokenUsage)
  await flushPromises()
  await w.get('select[aria-label="分析时间范围"]').setValue(range)
  await flushPromises()
  const rows = w.findAll('.pu-two > section:last-child .pu-kv')
  expect(rows.map(row => [row.get('span').text(), row.get('b').text()])).toEqual([
    ['输入', '30K · 30.0%'], ['输出', '10K · 10.0%'], ['缓存读取', '30K · 30.0%'],
    ['缓存写入', '3K · 3.4%'], ['未确认构成', '27K · 26.6%'],
  ])
  expect(rows.at(-1)?.get('b').attributes('title')).toBe('26,563')
  expect(w.get('.pu-donut').attributes('style')).toContain('var(--muted)')
  expect(w.get('.pu-statline').text()).toContain('未确认构成27K · 26.6%')
  if (range === 'today') expect(w.findAll('.pu-composition-bar i')).toHaveLength(5)
  w.unmount()
})

it('shows an entirely unconfirmed subtotal once without creating four zero values or an empty chart', async () => {
  const data = structuredClone(fixture.dashboard)
  Object.assign(data.analysis, { input: null, output: null, cache_read: null, cache_create: null, total: '26563' })
  Object.assign(data, { composition: { input: null, output: null, cache_read: null, cache_create: null,
    known_total: '0', unknown_total: '26563' } })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
  const w = mount(TokenUsage)
  await flushPromises()
  const rows = w.findAll('.pu-two > section:last-child .pu-kv')
  expect(rows.map(row => row.text())).toEqual(['未确认构成27K · 100.0%'])
  expect(w.find('.pu-donut').exists()).toBe(false)
  w.unmount()
})

it('keeps legacy unknowns if reported component subtotals disagree with the selected range total', async () => {
  const data = structuredClone(fixture.dashboard)
  Object.assign(data.analysis, { input: null, output: null, cache_read: null, cache_create: null, total: '26563' })
  Object.assign(data, { composition: { input: '100', output: '0', cache_read: '0', cache_create: '0',
    known_total: '100', unknown_total: '26563' } })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
  const w = mount(TokenUsage)
  await flushPromises()
  expect(w.get('.pu-unconfirmed-composition small').text()).toBe('未确认构成')
  expect(w.find('.pu-donut').exists()).toBe(false)
  expect(w.findAll('.pu-two > section:last-child .pu-kv')).toHaveLength(0)
  w.unmount()
})
