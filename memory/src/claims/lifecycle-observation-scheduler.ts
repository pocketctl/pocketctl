/** Observation must not queue behind model work. Carry the cursor between
 * bounded passes; a slow owner never restarts every sweep at UUID zero. */
export function createObservationScheduler(service:{listActivePersonalOwners(limit:number,after?:string):Promise<string[]>;recordObservationHeartbeat(input:{installationId:string;maxGapMs:number}):Promise<unknown>},options:{pageSize?:number;maxPages?:number;maxPassMs?:number;onError?(error:unknown):void}={}){
 let after:string|undefined,inflight:Promise<void>|undefined
 const pageSize=options.pageSize??100
 return {runOnce(signal:AbortSignal):Promise<void>{
  if(inflight)return inflight
  inflight=(async()=>{
   const started=Date.now()
   for(let page=0;page<(options.maxPages??20)&&!signal.aborted;page++){
    const owners=await service.listActivePersonalOwners(pageSize,after)
    for(const installationId of owners){if(signal.aborted)return;try{await service.recordObservationHeartbeat({installationId,maxGapMs:300000})}catch(error){options.onError?.(error)}finally{after=installationId};if(Date.now()-started>(options.maxPassMs??10000))return}
    if(owners.length<pageSize){after=undefined;return}
   }
  })().finally(()=>{inflight=undefined})
  return inflight
 }}
}
