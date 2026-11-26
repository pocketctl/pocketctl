import {it,expect} from 'vitest'
import {mount} from '@vue/test-utils'
import UsageTrend from '../../components/usage/UsageTrend.vue'
import UsageHeatmap from '../../components/usage/UsageHeatmap.vue'
it('draws isolated invocation points and starts a new path after missing collection',()=>{
 const series=[1,null,3].map((tools,i)=>({bucket_start:`2026-11-${10+i}`,end_exclusive:`2026-11-${11+i}`,tools,mcp:tools,skills:tools}))
 const w=mount(UsageTrend,{props:{mode:'calls',series}})
 expect(w.findAll('ellipse')).toHaveLength(6)
 expect(w.find('path').attributes('d')?.match(/M/g)).toHaveLength(2)
 expect(w.find('path').attributes('d')).not.toContain('L')
 expect(w.findAll('.pu-legend svg')).toHaveLength(3)
})
it('labels the padded opening month once and paints unknown days with stripes',()=>{
 const days=Array.from({length:14},(_,i)=>({date:`2026-08-${String(18+i).padStart(2,'0')}`,total:null}))
 const w=mount(UsageHeatmap,{props:{data:{days,requested_from:'2026-08-18',to_exclusive:'2026-08-31',active_days:0}}})
 expect(w.findAll('.heat-months span').map(e=>e.text()).filter(Boolean)).toEqual(['2026-08'])
 expect(w.find('.calendar button').attributes('style')).toContain('repeating-linear-gradient')
})

it('renders a total-only trend bar for partial components, separate from missing totals and confirmed zeros', () => {
  const series = [
    { total: '100', input: '20', output: null, cache_read: '0', cache_create: null },
    { total: null, input: null, output: null, cache_read: null, cache_create: null },
    { total: '0', input: '0', output: '0', cache_read: '0', cache_create: '0' },
  ].map((amounts, i) => ({ ...amounts, bucket_start: '2026-11-' + (10+i), end_exclusive: '2026-11-' + (11+i) }))
  const w = mount(UsageTrend, { props: { series } })
  const days = w.findAll('.pu-day')
  expect(days[0]!.findAll('.pu-bar')).toHaveLength(1)
  expect(days[0]!.find('.pu-bar').attributes('style')).toContain('height: 100%')
  expect(days[1]!.text()).toBe('—')
  expect(days[2]!.find('.pu-bar').exists()).toBe(false)
  expect(days[2]!.attributes('aria-label')).toContain(': 0')
})
