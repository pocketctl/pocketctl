import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actorInstallationId, isSuccessfulMcpRead, parseSnapshotQuery, recordFirstClaim, recordUsage } from './service.js'
import { registerPlatformStatisticsRoutes } from './routes.js'

afterEach(() => {vi.unstubAllEnvs();vi.restoreAllMocks()})
describe('private statistics boundaries', () => {
 it('is entirely inert without opt in', async () => {
  vi.stubEnv('PLATFORM_STATS_ENABLED','false')
  const query=vi.fn()
  await recordFirstClaim({query} as any,{installationId:'i',claimId:'c',source:'manual'})
  await recordUsage({query} as any,{installationId:'i',requestId:'r',kind:'read',operation:'search'})
  expect(query).not.toHaveBeenCalled()
 })
 it('attributes v2 usage to caller primary installation, never target scope', () => {
  expect(actorInstallationId({installationId:'target',primaryInstallationId:'caller',version:'v2'})).toBe('caller')
  expect(actorInstallationId({installationId:'caller'})).toBe('caller')
  expect(actorInstallationId(undefined)).toBeUndefined()
 })
 it('counts successful business tools once and excludes protocol traffic and errors', () => {
  expect(isSuccessfulMcpRead({method:'tools/call',params:{name:'memory_search'}},{result:{content:[]}})).toBe(true)
  for(const request of [{method:'initialize'},{method:'tools/list'},{method:'tools/call',params:{name:'other'}}])expect(isSuccessfulMcpRead(request,{result:{}})).toBe(false)
  expect(isSuccessfulMcpRead({method:'tools/call',params:{name:'memory_recall'}},{error:{code:-1}})).toBe(false)
  expect(isSuccessfulMcpRead({method:'tools/call',params:{name:'memory_search'}},{result:{isError:true}})).toBe(false)
  expect(isSuccessfulMcpRead({method:'tools/call',params:{name:'memory_get_claim'}},{result:{content:[{type:'text',text:JSON.stringify({error:{code:'not_found'}})}]}})).toBe(false)
 })
 it('accepts exact UTC windows only, bounded to 90 days and equal prior duration', () => {
  vi.spyOn(Date,'now').mockReturnValue(new Date('2026-11-09T00:00:00Z').getTime())
  const q={from:'2026-11-01T16:00:00.000Z',to:'2026-11-08T16:00:00.000Z',previousFrom:'2026-10-25T16:00:00.000Z',previousTo:'2026-11-01T16:00:00.000Z'}
  expect(parseSnapshotQuery(q).from.toISOString()).toBe(q.from)
  for(const bad of [{...q,from:'2026-11-01'},{...q,to:q.from},{...q,previousFrom:q.previousTo},{...q,to:'2027-12-08T16:00:00.000Z'},{...q,from:'2026-11-01T16:00:00+08:00'},{...q,unknown:'x'}])expect(()=>parseSnapshotQuery(bad)).toThrow()
 })
 it('requires opt in and a strong separate internal secret, never grants',async()=>{
  vi.stubEnv('PLATFORM_STATS_ENABLED','true')
  const pool={query:vi.fn()}
  const app=Fastify()
  registerPlatformStatisticsRoutes(app,{pool:pool as any,internalToken:'s'.repeat(32)})
  for(const authorization of [undefined,'Bearer browser-grant','Bearer '+ 't'.repeat(32)]){
   const response=await app.inject({url:'/internal/platform-statistics',headers:authorization?{authorization}:{}})
   expect(response.statusCode).toBe(401)
   expect(response.headers['cache-control']).toBe('no-store')
  }
  expect(pool.query).not.toHaveBeenCalled()
  const bad=await app.inject({url:'/internal/platform-statistics',headers:{authorization:'Bearer '+ 's'.repeat(32)}})
  expect(bad.statusCode).toBe(400)
  await app.close()
  expect(()=>registerPlatformStatisticsRoutes(Fastify(),{pool:pool as any,internalToken:'short'})).toThrow()
  expect(()=>registerPlatformStatisticsRoutes(Fastify(),{pool:pool as any,internalToken:'秘'.repeat(16)})).toThrow()
 })
})
