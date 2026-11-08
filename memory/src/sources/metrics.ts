import {Counter,Gauge,type Registry} from 'prom-client'
import type pg from 'pg'
import {bindSourcePool,sourcePoolContext} from './pool-context.js'
const kinds=['relay_event','team_collaboration','team_delivery','legacy_archive'] as const
const modes=['legacy-feed','shared-shadow','shared-active','paused'] as const
const states=['pending','leased','dead'] as const
const copies=['source_events','source_artifacts','memory_feed_inbox','memory_snapshot_events'] as const
const operations=['listHeads','getHeads','resolveBodies','checkCurrent','checkAuthority'] as const
const reasons=['revoked','deleted','changed','archive_unavailable','archive_binding_invalid','archive_namespace_mismatch','hash_mismatch','source_body_reclaimed','source_store_unavailable','body_byte_limit','source_metadata_conflict','other'] as const
const bounded=(value:string,values:readonly string[])=>values.includes(value)?value:'other'
export function createSourceMetrics(registry:Registry){
 const ready=new Gauge({name:'pocketctl_memory_source_activation_ready',help:'Shared source contract readiness; not business acceptance',registers:[registry]})
 const roots=new Gauge({name:'pocketctl_memory_source_roots',help:'Unprocessed roots by finite kind and queue state',labelNames:['kind','state'] as const,registers:[registry]})
 const age=new Gauge({name:'pocketctl_memory_source_dirty_oldest_seconds',help:'Age of earliest still unprocessed revision; pre-tracking upgrades use last modification as a lower bound',labelNames:['kind','state'] as const,registers:[registry]})
 const installations=new Gauge({name:'pocketctl_memory_source_installations',help:'Installation counts by source input mode',labelNames:['mode'] as const,registers:[registry]})
 const bytes=new Gauge({name:'pocketctl_memory_source_copy_allocated_bytes',help:'Physical allocation of Memory source/transport copies including indexes and TOAST',labelNames:['table'] as const,registers:[registry]})
 const errors=new Counter({name:'pocketctl_memory_source_reader_errors_total',help:'Reader failures with finite labels; no identities or raw error messages',labelNames:['operation','kind','reason'] as const,registers:[registry]})
 return {ready,roots,age,installations,bytes,readerError(operation:string,kind:string,reason:string){errors.inc({operation:bounded(operation,operations),kind:bounded(kind,kinds),reason:bounded(reason,reasons)})}}
}
export type SourceMetrics=ReturnType<typeof createSourceMetrics>
export function attachSourceMetrics(pool:object,metrics:SourceMetrics):void{
 bindSourcePool(pool,{...sourcePoolContext(pool),readerObserver:(operation,kind,reason)=>metrics.readerError(operation,kind,reason)})
}
const numeric=(value:unknown)=>{if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value)||!Number.isFinite(Number(value)))throw Error('source_health_invalid');return Number(value)}
export async function updateSourceGauges(db:Pick<pg.Pool,'query'>,metrics:SourceMetrics):Promise<void>{
 if(sourcePoolContext(db).namespace!=='memory')return
 const h=(await db.query('SELECT shared.memory_source_health() AS health')).rows[0]?.health
 if(!h||typeof h.ready!=='boolean'||!Array.isArray(h.roots)||!Array.isArray(h.modes)||!Array.isArray(h.copies))throw Error('source_health_invalid')
 // Validate all values before resetting any prior measurements.
 const rows=h.roots.map((r:any)=>({...r,count:numeric(r.count),oldest_seconds:numeric(r.oldest_seconds)}))
 const modeRows=h.modes.map((r:any)=>({...r,count:numeric(r.count)}))
 const copyRows=h.copies.map((r:any)=>({...r,bytes:numeric(r.bytes)}))
 metrics.ready.set(h.ready?1:0)
 for(const kind of kinds)for(const state of states){const row=rows.find((r:any)=>r.kind===kind&&r.state===state);metrics.roots.set({kind,state},row?.count??0);metrics.age.set({kind,state},row?.oldest_seconds??0)}
 for(const mode of modes)metrics.installations.set({mode},modeRows.find((r:any)=>r.mode===mode)?.count??0)
 for(const table of copies){const row=copyRows.find((r:any)=>r.table===table);if(row)metrics.bytes.set({table},row.bytes)}
}
/** A scrape cannot fan out unbounded SQL. Attempts are shared and paced;
 * server cancellation applies to this transaction only. */
export function createSourceGaugeCollector(pool:pg.Pool,metrics:SourceMetrics,options:{now?:()=>number;intervalMs?:number}={}){
 const now=options.now??Date.now,interval=options.intervalMs??15000
 let last=-Infinity,pending:Promise<void>|undefined
 return ():Promise<void>=>{
  if(sourcePoolContext(pool).namespace!=='memory')return Promise.resolve()
  if(pending)return pending
  if(now()-last<interval)return Promise.resolve()
  last=now()
  pending=(async()=>{
   const client=await pool.connect();bindSourcePool(client,sourcePoolContext(pool))
   try{
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'")
    await updateSourceGauges(client,metrics);await client.query('COMMIT')
   }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
  })().finally(()=>{pending=undefined})
  return pending
 }
}
