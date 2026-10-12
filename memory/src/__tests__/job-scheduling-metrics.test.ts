import {describe,expect,test} from 'vitest'
import {createMemoryMetrics,updateJobSchedulingGauges} from '../metrics.js'
import {retryDelayMs,retryDelayWithJitterMs} from '../jobs/repository.js'
describe('bounded job scheduling observability',()=>{
 test('queue age, waits and starvation are refreshed with bounded type labels',async()=>{
  const metrics=createMemoryMetrics()
  await updateJobSchedulingGauges({query:async()=>({rows:[{job_type:'compile_episode',age:'12',starved:'2',budget_wait:'3',source_wait:'1'}]})} as never,metrics)
  metrics.jobRuntime.observe({type:'compile_episode',result:'lost'},.1)
  metrics.jobRepeatClaims.inc({type:'compile_episode'})
  const output=await metrics.registry.metrics()
  expect(output).toContain('pocketctl_memory_job_queue_oldest_seconds{type="compile_episode"} 12')
  expect(output).toContain('pocketctl_memory_job_waiting{type="compile_episode",reason="budget"} 3')
  expect(output).toContain('pocketctl_memory_job_starved{type="compile_episode"} 2')
  expect(output).toContain('pocketctl_memory_job_repeat_claims_total{type="compile_episode"} 1')
  expect(output).not.toContain('installation_id')
 })
 test('retry jitter is bounded and preserves the maximum backoff',()=>{
  expect(retryDelayWithJitterMs(1,0)).toBe(800)
  expect(retryDelayWithJitterMs(1,1)).toBe(1200)
  expect(retryDelayWithJitterMs(7,1)).toBe(300000)
  expect(retryDelayMs(1)).toBe(1000)
 })
})
