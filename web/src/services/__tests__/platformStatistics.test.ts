import { beforeEach, afterEach, expect, test, vi } from 'vitest'
const state=vi.hoisted(()=>({token:'one',user:1,origin:'https://relay.test',refresh:vi.fn()}))
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({accessToken:{get value(){return state.token}},user:{get value(){return {id:state.user}}},doRefreshToken:state.refresh})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>state.origin}))
import {getPlatformStatistics,exportPlatformStatistics} from '../platformStatistics'
beforeEach(()=>{state.token='one';state.user=1;state.origin='https://relay.test';state.refresh.mockReset()})
afterEach(()=>vi.unstubAllGlobals())
test('summary refreshes auth once and passes abort, no-store and exact dates',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(Response.json({metrics:{}}));vi.stubGlobal('fetch',fetcher)
 state.refresh.mockImplementation(async()=>{state.token='two';return true})
 const signal=new AbortController().signal
 await getPlatformStatistics({from:'2026-11-01',to:'2026-11-07'},signal)
 expect(fetcher.mock.calls[1][0]).toBe('https://relay.test/api/admin/statistics?from=2026-11-01&to=2026-11-07')
 expect(fetcher.mock.calls[1][1]).toMatchObject({cache:'no-store',credentials:'include',signal,headers:{Authorization:'Bearer two'}})
})
test('export requests fresh server CSV and rejects denied response',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response('server csv')).mockResolvedValueOnce(new Response('',{status:403}));vi.stubGlobal('fetch',fetcher)
 expect(await (await exportPlatformStatistics({from:'2026-11-01',to:'2026-11-02'})).text()).toBe('server csv')
 expect(fetcher.mock.calls[0][0]).toContain('/export.csv?from=2026-11-01&to=2026-11-02')
 await expect(exportPlatformStatistics({from:'2026-11-01',to:'2026-11-02'})).rejects.toMatchObject({status:403})
})
test('identity or Relay change during request prevents returned body and auth retry',async()=>{
 let resolve!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r})))
 const result=getPlatformStatistics();state.user=2;resolve(new Response('',{status:401}))
 await expect(result).rejects.toMatchObject({code:'identity_changed'});expect(state.refresh).not.toHaveBeenCalled()
})
test('a failed auth refresh cannot downgrade an explicit401 to a stale network result',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:401})))
 state.refresh.mockRejectedValue(new Error('refresh unavailable'))
 await expect(getPlatformStatistics()).rejects.toMatchObject({status:401})
})
