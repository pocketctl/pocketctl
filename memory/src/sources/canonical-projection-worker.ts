import {prepareTeamSemanticPublication,persistTeamSemanticPublication} from './team-semantic-publication.js'
import type pg from 'pg'
import {canonicalPayloadHash,canonicalJsonString,SourceUnavailableError,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import type {JobHandler} from '../jobs/worker.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage,preparePersonalMetadataReferencePage,persistPersonalMetadataReferencePage,completeReadyCanonicalProjection,ORIGINAL_REPAIR_MAX_ROWS} from './canonical-references.js'
import {createObservedSourceReader} from './observed-reader.js'
import {loadSourceContextSet,checkSourceContextSet,requireSourceContext} from './source-context-set.js'
import {sameDerivedSourceVersion} from './derived-version.js'
import {sourceExecutionBranchFor} from './source-execution.js'
import {createCanonicalShadowHandler} from './canonical-shadow-worker.js'
import {prepareMetadataScope} from './source-projection-admission.js'

/** Each durable page commits its cursor, refs and derived facts together.
 * Personal metadata may continue a small successful-page burst; generic,
 * Team and shadow work retain their existing single-page admission. */
export function createCanonicalProjectionHandler(pool:pg.Pool,options:{pageSize?:number;deferMs?:number;stabilizationMs?:number;sourceProfile?:'personal-relay-only';installationAllowlist?:readonly string[];onReady?:(root:SourceRoot)=>void}={}):JobHandler{
 const pageSize=options.pageSize??64,deferMs=options.deferMs??1000
 if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>256||!Number.isSafeInteger(deferMs)||deferMs<0||deferMs>60000)throw Error('canonical_projection_options_invalid')
 return async(job,signal)=>{
  const scope=structuredClone(job.payload.scope) as SourceScope|undefined,root=structuredClone(job.payload.root) as SourceRoot|undefined
  if(job.job_type!=='project_shared_source'||!scope||scope.installationId!==job.installation_id||!root||!['relay_event','team_collaboration','team_delivery'].includes(root.kind)
   ||typeof root.key!=='string'||root.key.length>1024)throw new JobTerminalError('invalid_source_scope')
  if(options.sourceProfile==='personal-relay-only'&&root.kind!=='relay_event')throw new JobTerminalError('canonical_source_kind_disabled')
  if(options.sourceProfile==='personal-relay-only'&&!options.installationAllowlist?.includes(scope.installationId))throw new JobTerminalError('canonical_source_installation_disabled')
  const scan=job.payload.distribution_scan,cursor=job.payload.target_cursor
  if(typeof scan!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(scan)||typeof cursor!=='string'||!cursor||cursor.length>2048)
   throw new JobTerminalError('invalid_source_context_set')
  if(signal.aborted)throw Error('canonical_projection_aborted')
  const branch=sourceExecutionBranchFor(pool,scope.installationId)
  const repairVersion=job.payload.reference_repair_version as SourceVersion|undefined
  const pagedRepair=job.payload.reference_repair_paged
  const repairOriginalIds=job.payload.reference_repair_original_ids
  const repairCanonicalIds=job.payload.reference_repair_canonical_ids
  if((repairVersion!==undefined||pagedRepair!==undefined||repairOriginalIds!==undefined||repairCanonicalIds!==undefined)&&(branch!=='canonical-active'||root.kind!=='relay_event'||scope.ownerScopeKind!=='personal'
   ||!repairVersion||Object.keys(repairVersion).sort().join(',')!=='authorization,content,storage'
   ||!Object.values(repairVersion).every(value=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value))
   ||(pagedRepair!==undefined?pagedRepair!==true||repairOriginalIds!==undefined||repairCanonicalIds!==undefined:
   !Array.isArray(repairOriginalIds)||repairOriginalIds.length<1||repairOriginalIds.length>ORIGINAL_REPAIR_MAX_ROWS
   ||new Set(repairOriginalIds).size!==repairOriginalIds.length
   ||!repairOriginalIds.every(id=>typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))
   ||!Array.isArray(repairCanonicalIds)||repairCanonicalIds.length!==repairOriginalIds.length
   ||new Set(repairCanonicalIds).size!==repairCanonicalIds.length
   ||!repairCanonicalIds.every(id=>typeof id==='string'&&/^[1-9]\d{0,18}$/.test(id)&&BigInt(id)<=9223372036854775807n))))
   throw new JobTerminalError('invalid_source_context_set')
  if(branch==='canonical-shadow'){
   return createCanonicalShadowHandler(pool,{pageSize:Math.min(pageSize,128),deferMs})(job,signal)
  }
  const purpose=repairVersion?'current-content':'personal-projection'
  const contexts=await loadSourceContextSet(pool,scope.installationId,root,scan,purpose)
  requireSourceContext(contexts,scope,cursor)
  const currentContexts=await checkSourceContextSet(pool,root,contexts,purpose)
  if(pagedRepair&&repairVersion&&!currentContexts.some(context=>context.cursorKey===cursor&&sameDerivedSourceVersion(context.version,repairVersion)))
   throw new JobTerminalError('source_context_set_changed')
  if(repairVersion&&!pagedRepair){
   const keys=repairCanonicalIds as string[]
   const originalIds=new Map(keys.map((key,index)=>[key,(repairOriginalIds as string[])[index]]))
   const reader=createObservedSourceReader(pool)
   const current=await reader.checkCurrent(scope,root)
   if(current.state!=='current'||!sameDerivedSourceVersion(current.version,repairVersion))throw new JobTerminalError('source_context_set_changed')
   try{
    const page=await prepareCanonicalReferencePage(pool,scope,root,{keys,expectedVersion:current.version})
    if(signal.aborted)throw Error('canonical_projection_aborted')
    requireSourceContext(await loadSourceContextSet(pool,scope.installationId,root,scan,purpose),scope,cursor)
    await persistCanonicalReferencePage(pool,page,{project:true,checkpoint:true,repair:{version:repairVersion,originalIds}})
   }catch(error){
    if(!(error instanceof SourceUnavailableError)||error.code!=='changed'||signal.aborted)throw error
    const fresh=await reader.checkCurrent(scope,root)
    if(fresh.state!=='current'||!sameDerivedSourceVersion(fresh.version,repairVersion))throw new JobTerminalError('source_context_set_changed')
    if(fresh.version.storage===current.version.storage)throw error
    // The failed proof is discarded. A new claim reads the same frozen keys
    // and seal under the fresh storage version before attempting any write.
    throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
   }
   options.onReady?.(root)
   return
  }
  const team=root.kind==='team_collaboration'||root.kind==='team_delivery',personal=!team&&scope.ownerScopeKind==='personal'
  const publishTeam=async()=>{
   const prepared=await prepareTeamSemanticPublication(pool,scope.installationId,root)
   if(prepared)await persistTeamSemanticPublication(pool,prepared,options.stabilizationMs)
  }
  if(team){
   const excluded=await prepareTeamSemanticPublication(pool,scope.installationId,root,{metadataOnly:true})
   if(excluded){await persistTeamSemanticPublication(pool,excluded,options.stabilizationMs);return}
  }
  const readProgress=async()=>(await pool.query(`SELECT next_cursor,state,source_version FROM memory_canonical_projection_progress
   WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4`,[scope.installationId,root.kind,root.key,canonicalPayloadHash(scope).toString('hex')])).rows[0]
  const progress=await readProgress()
  if(progress?.state==='ready'||(!personal&&progress?.state==='raw_ready')){
   const current=await createObservedSourceReader(pool).checkCurrent(scope,root)
   if(current.state==='current'&&sameDerivedSourceVersion(current.version,progress.source_version)){
    if(signal.aborted)throw Error('canonical_projection_aborted')
    if(team){await publishTeam();return}
    // A current per-context checkpoint can skip body IO only after SQL
    // confirms the sealed installation watermark under the current authority.
    const completed=await completeReadyCanonicalProjection(pool,scope,root,current.version,personal?{deferMs}:undefined)
    if(completed||!personal){
     if(personal)options.onReady?.(root)
     return
    }
   }
   if(current.state!=='current'&&current.state!=='changed')throw new SourceUnavailableError(current.state)
  }
  // A scanning checkpoint with a plain version and cursor belongs to the
  // strict ordinary reader. It must finish that sweep without changing cursors.
  const ordinaryContinuation=personal&&progress?.state==='scanning'&&typeof progress.source_version?.content==='string'
  if(personal&&!ordinaryContinuation&&!pagedRepair){
   let useOrdinary=false
   // Spend at most the existing one-second deferred interval on successful
   // fresh pages; this does not alter either periodic poll or error backoff.
   const burstStarted=performance.now(),burstBudgetMs=1000
   const seal=await prepareMetadataScope(pool,scope,root,scan)
   if(seal.targetCursor!==cursor)throw new JobTerminalError('source_context_set_changed')
   let currentProgress=progress
   for(let page=0;page<4;page++){
    if(signal.aborted)throw Error('canonical_projection_aborted')
    let selected
    try{selected=await preparePersonalMetadataReferencePage(pool,scope,root,seal,currentProgress,pageSize)}catch(error){
     // A typed invalidated read has produced no output. Yield this claim;
     // never retry the old body proof or replace its original scope/seal.
     if(error instanceof SourceUnavailableError&&error.code==='changed')throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
     if(error instanceof SourceUnavailableError&&error.code==='source_metadata_proof_unavailable'){
      useOrdinary=true
      break
     }
     throw error
    }
    if(signal.aborted)throw Error('canonical_projection_aborted')
    const result=await persistPersonalMetadataReferencePage(pool,selected,options.stabilizationMs,signal)
    if(result.contextReady){options.onReady?.(root);return}
    if(signal.aborted)throw Error('canonical_projection_aborted')
    if(page===3||performance.now()-burstStarted>=burstBudgetMs)break
    // Read the acknowledged durable cursor, never refresh an old body proof
    // or replace this job's immutable scope/seal with a new authority view.
    const nextProgress=await readProgress()
    if(signal.aborted)throw Error('canonical_projection_aborted')
    if(!nextProgress||nextProgress.state!=='scanning')throw Error('canonical_reference_cursor_changed')
    if(performance.now()-burstStarted>=burstBudgetMs||canonicalJsonString(nextProgress??null)===canonicalJsonString(currentProgress??null))break
    currentProgress=nextProgress
   }
   if(!useOrdinary)throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
  }
  // The ordinary reader repeats input and retention authority and commits
  // under an exact full-root version. Start it from the beginning when the
  // selected reader could not prove its page.
  const cursorForOrdinary=!personal||ordinaryContinuation?progress?.next_cursor??undefined:undefined
  const readOrdinaryPage=(cursor?:string)=>prepareCanonicalReferencePage(pool,scope,root,{limit:pageSize,cursor})
  const page=await readOrdinaryPage(cursorForOrdinary).catch(error=>{
   // A newer source revision invalidates the old cursor. Restart enumeration
   // under the new authority snapshot; existing source UUIDs are reused.
   if(!cursorForOrdinary||!(error instanceof SourceUnavailableError)||error.code!=='changed')throw error
   return readOrdinaryPage()
  }).catch(error=>{
   // A changing personal root needs a fresh execution, just like the selected
   // metadata path. No prepared proof reached the write transaction.
   if(personal&&error instanceof SourceUnavailableError&&error.code==='changed'){
    throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
   }
   throw error
  })
  if(signal.aborted)throw Error('canonical_projection_aborted')
  // Body IO can span a control change or a newer distribution. The immutable
  // execution clock and source/root fences repeat this at physical COMMIT.
  requireSourceContext(await loadSourceContextSet(pool,scope.installationId,root,scan,purpose),scope,cursor)
  try{
   await persistCanonicalReferencePage(pool,page,{project:true,checkpoint:true,stabilizationMs:options.stabilizationMs,
    reuseOriginalsAtVersion:pagedRepair?repairVersion:undefined})
  }catch(error){
   if(!pagedRepair||!repairVersion||!(error instanceof SourceUnavailableError)||error.code!=='changed'||signal.aborted)throw error
   const fresh=await createObservedSourceReader(pool).checkCurrent(scope,root)
   if(fresh.state!=='current'||!sameDerivedSourceVersion(fresh.version,repairVersion))throw new JobTerminalError('source_context_set_changed')
   throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
  }
  if(team&&!page.hasMore)await publishTeam()
  if(page.hasMore)throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
  if(personal)options.onReady?.(root)
 }
}
