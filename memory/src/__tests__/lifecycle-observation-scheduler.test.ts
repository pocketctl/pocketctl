import {describe,it,expect} from 'vitest'
import {createObservationScheduler} from '../claims/lifecycle-observation-scheduler.js'
describe('lifecycle observation scheduler',()=>{
 it('AC-48 bounded passes resume beyond first page and wrap',async()=>{
  const owners=['a','b','c'],seen:string[]=[]
  const service={async listActivePersonalOwners(limit:number,after?:string){return owners.filter(id=>!after||id>after).slice(0,limit)},async recordObservationHeartbeat({installationId}:{installationId:string}){seen.push(installationId)}}
  const scheduler=createObservationScheduler(service,{pageSize:2,maxPages:1}),signal=new AbortController().signal
  await scheduler.runOnce(signal);await scheduler.runOnce(signal);await scheduler.runOnce(signal)
  expect(seen).toEqual(['a','b','c','a','b'])
 })
 it('AC-48 overlapping ticks share one observation pass',async()=>{
  let release!:()=>void,calls=0
  const blocked=new Promise<void>(r=>release=r)
  const scheduler=createObservationScheduler({async listActivePersonalOwners(){return ['a']},async recordObservationHeartbeat(){calls++;await blocked}},{pageSize:2,maxPages:1})
  const signal=new AbortController().signal,a=scheduler.runOnce(signal),b=scheduler.runOnce(signal)
  expect(a).toBe(b);release();await a;expect(calls).toBe(1)
 })
 it('AC-48 one failing owner does not starve later owners',async()=>{
  const seen:string[]=[],failures:unknown[]=[]
  const scheduler=createObservationScheduler({async listActivePersonalOwners(){return ['a','b']},async recordObservationHeartbeat({installationId}){seen.push(installationId);if(installationId==='a')throw new Error('owner_unavailable')}},{pageSize:3,maxPages:1,onError:e=>failures.push(e)})
  await scheduler.runOnce(new AbortController().signal);expect(seen).toEqual(['a','b']);expect(failures).toHaveLength(1)
 })

})
