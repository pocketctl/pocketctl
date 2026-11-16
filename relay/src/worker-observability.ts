import { createServer } from 'node:http'
import type pg from 'pg'
import { Gauge, Histogram } from 'prom-client'
import { registry } from './metrics.js'

export const workerStageSeconds = new Histogram({
  name:'pocketctl_inbox_worker_stage_seconds', help:'Worker operation latency, excluding queue wait',
  labelNames:['stage','outcome'], buckets:[.001,.005,.01,.025,.05,.1,.25,.5,1,2,5,15,30], registers:[registry],
})
export async function observeWorkerStage<T>(stage:'materialize'|'complete'|'replay_batch', work:()=>Promise<T>):Promise<T>{
  const started=performance.now()
  let outcome='error'
  try { const result=await work(); outcome='success'; return result }
  finally {workerStageSeconds.observe({stage,outcome},(performance.now()-started)/1000)}
}
const queueRows=new Gauge({name:'pocketctl_inbox_unresolved_rows',help:'Database unresolved rows by scheduling state',labelNames:['state'],registers:[registry]})
const queueAge=new Gauge({name:'pocketctl_inbox_unresolved_oldest_seconds',help:'Oldest database unresolved row including retry-delayed heads',labelNames:['state'],registers:[registry]})
const sampleTime=new Gauge({name:'pocketctl_inbox_queue_sample_timestamp_seconds',help:'Time of last successful database queue sample',registers:[registry]})

/** Optional loopback-only exporter. Scrapes share one bounded read-only query;
 * metrics failure never changes worker claims or retry decisions. */
export function createWorkerMetricsServer(pool:pg.Pool,port:number){
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('invalid worker metrics port')
  let sampling:Promise<void>|undefined
  const sample=()=>sampling??(sampling=(async()=>{
    const client=await pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query("SET LOCAL statement_timeout='4s'")
      await client.query("SET LOCAL lock_timeout='500ms'")
      const result=await client.query(`SELECT CASE WHEN status=1 THEN 'claimed'
        WHEN available_at>now() THEN 'retry_delayed' ELSE 'pending' END AS state,
        count(*)::int AS count, greatest(0,extract(epoch FROM now()-min(received_at)))::float8 AS age
        FROM event_inbox WHERE status IN (0,1) GROUP BY 1`)
      await client.query('COMMIT')
      for(const state of ['pending','retry_delayed','claimed']){
        const row=result.rows.find(row=>row.state===state)
        queueRows.set({state},row?.count??0);queueAge.set({state},row?.age??0)
      }
      sampleTime.set(Date.now()/1000)
    } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
    finally{client.release()}
  })().finally(()=>{sampling=undefined}))
  const server=createServer((request,response)=>{
    if(request.method!=='GET'||request.url!=='/metrics'){response.writeHead(404).end();return}
    void (async()=>{
      try{await sample();response.writeHead(200,{'Content-Type':registry.contentType});response.end(await registry.metrics())}
      catch{response.writeHead(503).end('metrics sample unavailable\n')}
    })()
  })
  return {
    async start(){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()})})},
    address:()=>server.address(),
    async stop(){if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await sampling},
  }
}
