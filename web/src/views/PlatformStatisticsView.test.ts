import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {ref} from 'vue'
const api=vi.hoisted(()=>({read:vi.fn(),export:vi.fn(),access:vi.fn(),invalidate:vi.fn(),sync:vi.fn()}))
const token=ref('one'),user=ref({id:1})
vi.mock('../composables/useAuth',()=>({useAuth:()=>({accessToken:token,user})}))
vi.mock('../composables/useEnv',()=>({getRelayOrigin:()=>''}))
vi.mock('../services/platformStatistics',async(importOriginal)=>({...await importOriginal<object>(),getPlatformStatistics:(...a:unknown[])=>api.read(...a),exportPlatformStatistics:(...a:unknown[])=>api.export(...a)}))
const allowed=ref(true),status=ref('allowed')
vi.mock('../composables/usePlatformStatisticsAccess',()=>({usePlatformStatisticsAccess:()=>({allowed,status,refresh:()=>api.access(),invalidate:()=>{allowed.value=false;status.value='denied';api.invalidate()},syncIdentity:()=>api.sync()})}))
vi.mock('../composables/useLocale',()=>({useLocale:()=>({t:(k:string,p?:Record<string,unknown>)=>k+(p?JSON.stringify(p):'')})}))
import PlatformStatisticsView from './PlatformStatisticsView.vue'
import {PlatformStatisticsError} from '../services/platformStatistics'
const metric=(value:number|null)=>({value,status:value===null?'unavailable':'complete',coverageStart:null})
const snapshot=()=>({definitionVersion:'platform-statistics-v1',timezone:'Asia/Shanghai',dataThrough:'2026-11-07T02:00:00Z',range:{from:'2026-11-01',to:'2026-11-02'},previousRange:{from:'2026-10-30',to:'2026-10-31'},comparisonAvailable:true,metrics:{newUsers:metric(0),activeUsers:metric(3),sessions:metric(5),memory:metric(null),memoryUsers:metric(null),readRequests:metric(null)},previous:{newUsers:metric(0),activeUsers:metric(2),sessions:metric(4),memory:metric(null),memoryUsers:metric(null),readRequests:metric(null)},daily:[{date:'2026-11-01',newUsers:metric(0),activeUsers:metric(2),sessions:metric(3),memory:metric(null)},{date:'2026-11-02',newUsers:metric(0),activeUsers:metric(2),sessions:metric(3),memory:metric(null)}],previousDaily:[],memorySources:{automatic:metric(null),manual:metric(null),unclassified:metric(null)},actualUse:{value:null,status:'unconfirmed'},exclusions:[],warnings:[]})
let wrapper:ReturnType<typeof mount>|undefined
beforeEach(()=>{token.value='one';user.value={id:1};api.read.mockReset().mockResolvedValue(snapshot());api.access.mockResolvedValue(true);api.export.mockReset();allowed.value=true;status.value='allowed'})
afterEach(()=>wrapper?.unmount())
test('renders server period distinct value without summing daily activity and preserves real zero vs unknown',async()=>{
 wrapper=mount(PlatformStatisticsView);await flushPromises()
 expect(wrapper.get('[data-metric="activeUsers"] .ps-value').text()).toBe('3')
 expect(wrapper.get('[data-metric="newUsers"] .ps-value').text()).toBe('0')
 expect(wrapper.get('[data-metric="memory"] .ps-value').text()).toBe('—')
})
test('failed same-account refresh retains dated stale result, then403 clears all data',async()=>{
 wrapper=mount(PlatformStatisticsView);await flushPromises();api.read.mockRejectedValueOnce(new Error('offline'))
 await wrapper.get('[data-refresh]').trigger('click');await flushPromises();expect(wrapper.find('[data-stale]').exists()).toBe(true);expect(wrapper.find('[data-metric="activeUsers"]').exists()).toBe(true)
 api.read.mockRejectedValueOnce(new PlatformStatisticsError(403,'forbidden'));await wrapper.get('[data-refresh]').trigger('click');await flushPromises()
 expect(wrapper.find('[data-metric]').exists()).toBe(false);expect(wrapper.text()).toContain('stats.denied')
})
test('export rechecks server with exactly displayed applied range',async()=>{
 api.export.mockRejectedValue(new Error('offline'));wrapper=mount(PlatformStatisticsView);await flushPromises();await wrapper.get('[data-export]').trigger('click');await flushPromises()
 expect(api.export.mock.calls[0][0]).toEqual({from:'2026-11-01',to:'2026-11-02'})
})

test('latest query wins when earlier transport ignores cancellation',async()=>{
 let old!:(value:unknown)=>void,newer!:(value:unknown)=>void
 api.read.mockImplementationOnce(()=>new Promise(r=>{old=r})).mockImplementationOnce(()=>new Promise(r=>{newer=r}))
 wrapper=mount(PlatformStatisticsView);await flushPromises()
 await wrapper.findAll('.ps-segments button')[2]!.trigger('click');await flushPromises()
 const current=snapshot();current.metrics.activeUsers=metric(9);newer(current);await flushPromises()
 old(snapshot());await flushPromises();expect(wrapper.get('[data-metric="activeUsers"] .ps-value').text()).toBe('9')
})
test('switching token clears protected data before a new request settles',async()=>{
 wrapper=mount(PlatformStatisticsView);await flushPromises();api.read.mockImplementation(()=>new Promise(()=>{}))
 token.value='replacement';await flushPromises();expect(wrapper.find('[data-metric]').exists()).toBe(false)
})
test('partial period observation never masquerades as a full period total',async()=>{
 const result=snapshot();result.metrics.memory={value:4,status:'partial',coverageStart:null};api.read.mockResolvedValue(result)
 wrapper=mount(PlatformStatisticsView);await flushPromises()
 expect(wrapper.get('[data-metric="memory"] .ps-value').text()).toBe('4')
 expect(wrapper.get('[data-metric="memory"] .ps-change').text()).toContain('stats.observedPartial')
})
