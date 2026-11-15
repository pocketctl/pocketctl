import {describe,expect,test,vi} from 'vitest'
import {createPlatformStatisticsMemoryReader} from '../platform-statistics-upstream.js'
const env={PLATFORM_STATS_ENABLED:'true',PLATFORM_STATS_MEMORY_BASE_URL:'http://memory:8081',PLATFORM_STATS_INTERNAL_TOKEN:'x'.repeat(40)}
const bounds={from:'2026-11-01T00:00:00.000Z',to:'2026-11-02T00:00:00.000Z',previousFrom:'2026-10-31T00:00:00.000Z',previousTo:'2026-11-01T00:00:00.000Z',excludeInstallationIds:['11111111-1111-4111-8111-111111111111']}
const period={memory:0,automatic:0,manual:0,unclassified:0,daily:[],actors:[],dailyActors:[]}
const snapshot={coverageStart:'2026-10-01T00:00:00.000Z',dataThrough:'2026-11-02T00:00:00.000Z',gaps:[],actorLimitExceeded:false,periods:{current:period,previous:period}}
describe('Memory statistics backend-only upstream',()=>{
 test('unconfigured/disabled/weak token/unsafe URL fail closed',()=>{
  for(const patch of [{PLATFORM_STATS_ENABLED:'false'},{PLATFORM_STATS_MEMORY_BASE_URL:''},{PLATFORM_STATS_INTERNAL_TOKEN:'short'},{PLATFORM_STATS_MEMORY_BASE_URL:'file:///tmp/stats'},{PLATFORM_STATS_MEMORY_BASE_URL:'http://user:password@memory:8081'},{PLATFORM_STATS_MEMORY_BASE_URL:'http://memory:8081?token=x'}])expect(createPlatformStatisticsMemoryReader({...env,...patch})).toBeUndefined()
 })
 test('uses fixed internal path, token only in header, bounded request and no redirect',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(snapshot),{headers:{'Content-Type':'application/json'}}))
  const reader=createPlatformStatisticsMemoryReader(env,fetcher as typeof fetch)!
  expect(await reader(bounds)).toEqual(snapshot)
  const [input,init]=fetcher.mock.calls[0] as unknown as [URL,RequestInit]
  const url=new URL(String(input));expect(url.pathname).toBe('/internal/platform-statistics');expect(url.searchParams.get('excludeInstallationIds')).toBe(bounds.excludeInstallationIds.join(','));expect(url.search).not.toContain(env.PLATFORM_STATS_INTERNAL_TOKEN)
  expect(init.headers).toMatchObject({Authorization:`Bearer ${env.PLATFORM_STATS_INTERNAL_TOKEN}`});expect(init.redirect).toBe('error');expect(init.signal).toBeTruthy()
 })
 test('rejects non-200, malformed schema and oversized source without leaking credentials',async()=>{
  for(const response of [new Response('denied',{status:403}),new Response('{}'),new Response(JSON.stringify({...snapshot,periods:{current:{...period,memory:-1},previous:period}})),new Response('{}',{headers:{'Content-Length':'99999999'}})]){
   const reader=createPlatformStatisticsMemoryReader(env,vi.fn(async()=>response) as typeof fetch)!
   await expect(reader(bounds)).rejects.toThrow('memory_statistics_unavailable')
  }
 })
})
