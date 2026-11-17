import Fastify from 'fastify'
import {describe,test,expect,vi} from 'vitest'
import {createHealthSnapshot,registerReadiness} from '../reporting/readiness.js'

describe('readiness independent from business aggregation',()=>{
 test('reports unknown business health rather than unavailable when aggregation fails',async()=>{
  const load=vi.fn(async()=>{throw Error('private database detail')})
  const health=createHealthSnapshot({load,now:()=>1000})
  await health.refresh()
  const app=Fastify();registerReadiness(app,{probe:async()=>{},health,compatibility:{}})
  const response=await app.inject('/ready')
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({readiness:'ready',operational:{status:'unknown'},health_snapshot:{state:'unavailable'}})
  expect(response.body).not.toContain('private database detail')
  expect(load).toHaveBeenCalledTimes(1)
  await app.close()
 })
 test('does not serve a stale green status or hide a failing dependency',async()=>{
  let now=1000
  const health=createHealthSnapshot({load:async()=>({status:'ready',operational:{status:'healthy'}}),now:()=>now,maxAgeMs:100})
  await health.refresh();now=1200
  expect(health.read()).toMatchObject({operational:{status:'unknown'},health_snapshot:{state:'stale'}})
  const app=Fastify();registerReadiness(app,{probe:async()=>{throw Error('db unavailable')},health,compatibility:{}})
  expect((await app.inject('/ready')).statusCode).toBe(503)
  await app.close()
 })
 test('coalesces refreshes and preserves degraded health on successful samples',async()=>{
  let resolve!:(v:any)=>void
  const load=vi.fn(()=>new Promise<any>(r=>{resolve=r}))
  const health=createHealthSnapshot({load,now:()=>1000})
  const a=health.refresh(),b=health.refresh()
  resolve({status:'degraded',operational:{status:'degraded',reasons:['source_processing_failed']}})
  await Promise.all([a,b]);expect(load).toHaveBeenCalledTimes(1)
  expect(health.read()).toMatchObject({operational:{status:'degraded'},health_snapshot:{state:'fresh'}})
 })
})
