import { test, expect, vi } from 'vitest'
import { createWorkerMetricsServer, observeWorkerStage, workerStageSeconds } from '../worker-observability.js'
test('records bounded stage and outcome labels while preserving results and errors', async()=>{
  workerStageSeconds.reset()
  expect(await observeWorkerStage('materialize', async()=>42)).toBe(42)
  const failure=new Error('private diagnostic')
  await expect(observeWorkerStage('complete',async()=>{throw failure})).rejects.toBe(failure)
  const values=(await workerStageSeconds.get()).values.filter(v=>v.metricName?.endsWith('_count'))
  expect(values).toEqual(expect.arrayContaining([
    expect.objectContaining({value:1,labels:{stage:'materialize',outcome:'success'}}),
    expect.objectContaining({value:1,labels:{stage:'complete',outcome:'error'}}),
  ]))
  expect(JSON.stringify(values)).not.toContain('private diagnostic')
})

test('loopback exporter samples read-only state and fails closed without exposing diagnostics', async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('GROUP BY 1')?[{state:'retry_delayed',count:3,age:120}]:[]}))
  const release=vi.fn()
  const service=createWorkerMetricsServer({connect:async()=>({query,release})} as never,0)
  await service.start()
  try {
    const address=service.address() as {address:string;port:number}
    expect(address.address).toBe('127.0.0.1')
    const url=`http://127.0.0.1:${address.port}`
    const response=await fetch(url+'/metrics')
    expect(response.status).toBe(200)
    const body=await response.text()
    expect(body).toContain('pocketctl_inbox_unresolved_rows{state="retry_delayed"} 3')
    expect(body).toContain('pocketctl_inbox_unresolved_rows{state="pending"} 0')
    expect(query.mock.calls.some(([sql])=>sql==='BEGIN READ ONLY')).toBe(true)
    expect(query.mock.calls.some(([sql])=>sql.includes("statement_timeout='4s'"))).toBe(true)
    expect((await fetch(url+'/elsewhere')).status).toBe(404)
    query.mockRejectedValueOnce(new Error('private database connection'))
    const failed=await fetch(url+'/metrics')
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('private')
  } finally {await service.stop()}
  expect(release).toHaveBeenCalledTimes(2)
})
