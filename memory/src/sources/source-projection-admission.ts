import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import {loadSourceContextSet,checkSourceContextSet,requireSourceContext} from './source-context-set.js'
import {sameDerivedSourceVersion} from './derived-version.js'
import {metadataSourceExecution} from './source-execution.js'
export interface ProjectionObservation {scope:SourceScope;root:SourceRoot;version:SourceVersion}
const notReady=()=>new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
export interface MetadataScopeSeal {scanId:string;targetCursor:string;controlRevision:string}
/** Scope metadata only. This never grants whole-root/model readiness. */
export async function prepareMetadataScope(pool:pg.Pool,scope:SourceScope,root:SourceRoot,expectedScan?:string):Promise<MetadataScopeSeal>{
 if(root.kind!=='relay_event'||scope.ownerScopeKind!=='personal')throw notReady()
 const set=await loadSourceContextSet(pool,scope.installationId,root,expectedScan,'personal-projection')
 requireSourceContext(set,scope);await checkSourceContextSet(pool,root,set,'personal-projection')
 const context=set.contexts.find(c=>c.state==='current'&&canonicalJsonString(c.scope)===canonicalJsonString(scope))
 if(!context)throw notReady()
 return {scanId:set.scanId,targetCursor:context.cursorKey,controlRevision:set.controlRevision}
}
export function personalMetadataEnvelope(pool:pg.Pool,scope:SourceScope,root:SourceRoot,proof:unknown,seal:MetadataScopeSeal,purpose:'reference'|'episode'){
 const execution=metadataSourceExecution(pool,scope.installationId)
 const envelope={contract:'personal-metadata-selection-v1',purpose,executionId:execution.executionId,scanId:seal.scanId,targetCursor:seal.targetCursor,...proof as object}
 if(Buffer.byteLength(canonicalJsonString({scope,root,envelope}))>128*1024)throw Error('source_metadata_limit')
 return envelope
}
/** Identity mapping is independent of processing completeness. Every live
 * principal in the trusted seal must be caught up before positive consumers
 * can prepare model input, including references retained from old Feed rows. */
export async function prepareSourceProjectionAdmission(pool:pg.Pool,scope:SourceScope,root:SourceRoot){
 if(root.kind==='team_collaboration'||root.kind==='team_delivery')throw new JobTerminalError('team_raw_business_input_forbidden')
 const set=await loadSourceContextSet(pool,scope.installationId,root)
 requireSourceContext(set,scope)
 const contexts=await checkSourceContextSet(pool,root,set)
 const observations:ProjectionObservation[]=contexts.map(context=>({scope:context.scope,root,version:context.version}))
 const check=async(db:Pick<pg.Pool,'query'>,lock:boolean)=>{
  for(const o of observations){
   const rows=(await db.query(`SELECT state,source_version FROM memory_canonical_projection_progress
    WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4${lock?' FOR SHARE NOWAIT':''}`,
    [scope.installationId,root.kind,root.key,canonicalPayloadHash(o.scope).toString('hex')])).rows
   if(rows.length!==1||rows[0].state!=='ready'||!sameDerivedSourceVersion(rows[0].source_version,o.version))throw notReady()
  }
 }
 await check(pool,false)
 return {observations,requireScope:(candidate:SourceScope)=>requireSourceContext(set,candidate),async assertCurrent(db:Pick<pg.Pool,'query'>){
  const current=await loadSourceContextSet(db,scope.installationId,root,set.scanId)
  if(canonicalJsonString(current)!==canonicalJsonString(set))throw notReady()
  await check(db,true)
 }}
}
