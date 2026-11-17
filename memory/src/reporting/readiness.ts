import type {FastifyInstance} from 'fastify'

type BusinessSnapshot = Record<string,unknown>
/** Expensive operational aggregates are sampled once per process, never once
 * per probe. Failed/stale samples are explicitly unknown, never cached green. */
export function createHealthSnapshot(options:{load:()=>Promise<BusinessSnapshot>;now?:()=>number;maxAgeMs?:number}) {
 const now=options.now??Date.now,maxAge=options.maxAgeMs??90_000
 let value:BusinessSnapshot|undefined,sampledAt:number|undefined,lastSuccess:number|undefined,failed=false
 let current:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined
 const refresh=():Promise<void>=>{
  if(current)return current
  current=(async()=>{
   try{value=await options.load();lastSuccess=now();failed=false}
   catch{failed=true}
   finally{sampledAt=now()}
  })().finally(()=>{current=undefined})
  return current
 }
 return {
  refresh,
  read():BusinessSnapshot{
   const stale=sampledAt!==undefined&&now()-sampledAt>maxAge
   const state=stale?'stale':failed?'unavailable':sampledAt===undefined?'pending':'fresh'
   const metadata={state,sampled_at:sampledAt===undefined?null:new Date(sampledAt).toISOString(),last_success_at:lastSuccess===undefined?null:new Date(lastSuccess).toISOString(),max_age_ms:maxAge}
   if(state!=='fresh')return {status:'unknown',operational:{status:'unknown',reasons:[`health_snapshot_${state}`]},
    lifecycle:{execution:{status:'unknown'},coverage:{status:'unknown'}},budget_uncertainty:{status:'unknown'},health_snapshot:metadata}
   return {...value,health_snapshot:metadata}
  },
  start(intervalMs=30_000){if(timer)return;void refresh();timer=setInterval(()=>{void refresh()},intervalMs);timer.unref?.()},
  async stop(){if(timer)clearInterval(timer);timer=undefined;await current},
 }
}
export function registerReadiness(app:FastifyInstance,options:{probe:()=>Promise<unknown>;health:ReturnType<typeof createHealthSnapshot>;compatibility:unknown}) {
 app.get('/ready',async(_request,reply)=>{
  try{await options.probe()}catch{reply.code(503);return {status:'unavailable',readiness:'unavailable'}}
  return {...options.health.read(),readiness:'ready',compatibility:options.compatibility}
 })
}
