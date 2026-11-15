import {expect,test,vi} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {ref} from 'vue'
const token=ref('expired'),user=ref({id:7}),refresh=vi.fn(async()=>{token.value='renewed';return true})
vi.mock('../composables/useAuth',()=>({useAuth:()=>({accessToken:token,user,doRefreshToken:refresh})}))
vi.mock('../composables/useEnv',()=>({getRelayOrigin:()=>''}))
vi.mock('../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import PlatformStatisticsView from './PlatformStatisticsView.vue'
const m=(value:number)=>({value,status:'complete',coverageStart:'2026-01-01T00:00:00Z'})
const metrics={newUsers:m(0),activeUsers:m(6),sessions:m(4),memory:m(0),memoryUsers:m(0),readRequests:m(0)}
test('summary401 renews token and automatically reloads live access and data without getting stuck',async()=>{
 const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
  if(url.endsWith('/access'))return Response.json({allowed:true})
  const bearer=(init.headers as Record<string,string>).Authorization
  if(bearer==='Bearer expired')return new Response('',{status:401})
  return Response.json({definitionVersion:'v1',timezone:'Asia/Shanghai',dataThrough:'2026-11-07T00:00:00Z',range:{from:'2026-11-01',to:'2026-11-02'},previousRange:{from:'2026-10-30',to:'2026-10-31'},comparisonAvailable:true,metrics,previous:metrics,daily:[],previousDaily:[],memorySources:{automatic:m(0),manual:m(0),unclassified:m(0)},actualUse:{value:null,status:'unconfirmed'},exclusions:[],warnings:[]})
 });vi.stubGlobal('fetch',fetcher)
 const wrapper=mount(PlatformStatisticsView);await flushPromises();await flushPromises()
 expect(refresh).toHaveBeenCalledTimes(1)
 expect(wrapper.get('[data-metric="activeUsers"] .ps-value').text()).toBe('6')
 expect(wrapper.get('[data-refresh]').attributes('disabled')).toBeUndefined()
 wrapper.unmount();vi.unstubAllGlobals()
})
