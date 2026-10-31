import type pg from 'pg'
import {previewSourceRetention,reclaimSourceTurn,type SourceRetentionSettings,type RetentionPreviewCursor} from './source.js'
import {retainMigrationChanges,retainMigrationHistory} from './migrations.js'
import {retainInventoryReports} from './reports.js'

/** Bounded passes, one transaction at a time. Backlog continuation runs after a
 * second; an empty daily sweep sleeps until its configured interval. */
export function createDataRetentionWorker(options:{pool:pg.Pool;settings:SourceRetentionSettings;signal:AbortSignal;
 onResult?(counts:Record<string,number>):void;onSkipped?(reason:string):void;onError?(error:unknown):void}){
 let cursor:RetentionPreviewCursor={}
 let timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<boolean>|undefined,stopped=false
 async function pass(){
  const counts:Record<string,number>={events:0,artifacts:0,snapshots:0,candidates:0,episodes:0,actions:0,checkpoints:0,runs:0,changes:0,reports:0,partials:0}
  let progress=false
  const preview=await previewSourceRetention(options.pool,options.settings.bodyDays,20,cursor)
  cursor={eligibleEpisodeId:preview.eligible.length===20?preview.eligible.at(-1)!.episode_id:undefined,
   ...(preview.reclaiming.length===20?{receiptInstallationId:preview.reclaiming.at(-1)!.installation_id,receiptTurnId:preview.reclaiming.at(-1)!.turn_id}:{})}
  const unique=new Map([...preview.reclaiming,...preview.eligible].map(r=>[r.installation_id+':'+r.turn_id,r]))
  for(const r of unique.values()){
   if(stopped||options.signal.aborted)break
   try{const result=await reclaimSourceTurn(options.pool,{installationId:r.installation_id,sessionId:r.session_id,turnId:r.turn_id,episodeId:r.episode_id},options.settings)
    if(result.skipped)options.onSkipped?.(result.skipped)
    for(const k of ['events','artifacts','snapshots','candidates','episodes'] as const){counts[k]+=result[k];progress||=result[k]>0}
   }catch(e){options.onError?.(e)}
  }
  if(!stopped&&!options.signal.aborted){
   for(const run of [retainMigrationHistory,retainMigrationChanges]){
    if(stopped||options.signal.aborted)break
    try{const result=await run(options.pool,options.settings.batchSize);for(const [k,v] of Object.entries(result)){counts[k]+=v;progress||=v>0}}catch(e){options.onError?.(e)}
   }
   if(!stopped&&!options.signal.aborted&&options.settings.reportDirectory)try{const result=await retainInventoryReports(options.pool,options.settings.reportDirectory,options.settings.batchSize);counts.reports=result.reports;counts.partials=result.partials}catch(e){options.onError?.(e)}
  }
  options.onResult?.(counts)
  return progress||preview.eligible.length===20||preview.reclaiming.length===20
 }
 function runOnce():Promise<boolean>{
  if(inFlight)return inFlight
  if(stopped||options.signal.aborted||options.settings.mode==='off')return Promise.resolve(false)
  inFlight=pass().finally(()=>{inFlight=undefined});return inFlight
 }
 function schedule(delay:number){if(stopped||options.signal.aborted)return;timer=setTimeout(()=>{timer=undefined;void runOnce().then(more=>schedule(more?1000:options.settings.intervalMs),e=>{options.onError?.(e);schedule(options.settings.intervalMs)})},delay);timer.unref?.()}
 return {runOnce,start(){if(timer||stopped||options.signal.aborted||options.settings.mode==='off')return;schedule(0)},async stop(){stopped=true;if(timer)clearTimeout(timer);await inFlight}}
}
