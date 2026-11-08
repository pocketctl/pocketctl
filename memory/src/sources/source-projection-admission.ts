import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import {loadSourceContextSet,checkSourceContextSet,requireSourceContext} from './source-context-set.js'
import {sameDerivedSourceVersion} from './derived-version.js'
export interface ProjectionObservation {scope:SourceScope;root:SourceRoot;version:SourceVersion}
const notReady=()=>new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
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
