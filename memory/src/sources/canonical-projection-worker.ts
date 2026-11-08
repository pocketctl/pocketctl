import {prepareTeamSemanticPublication,persistTeamSemanticPublication} from './team-semantic-publication.js'
import type pg from 'pg'
import {canonicalPayloadHash,SourceUnavailableError,type SourceScope,type SourceRoot} from '@pocketctl/session-source'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import type {JobHandler} from '../jobs/worker.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage} from './canonical-references.js'
import {createObservedSourceReader} from './observed-reader.js'
import {loadSourceContextSet,checkSourceContextSet,requireSourceContext} from './source-context-set.js'
import {sameDerivedSourceVersion} from './derived-version.js'
import {sourceExecutionBranchFor} from './source-execution.js'
import {createCanonicalShadowHandler} from './canonical-shadow-worker.js'

/** One bounded page per claim. The durable cursor, refs and derived facts
 * commit together; job release/completion may crash independently and replay. */
export function createCanonicalProjectionHandler(pool:pg.Pool,options:{pageSize?:number;deferMs?:number;stabilizationMs?:number;sourceProfile?:'personal-relay-only';installationAllowlist?:readonly string[]}={}):JobHandler{
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
  if(sourceExecutionBranchFor(pool,scope.installationId)==='canonical-shadow'){
   return createCanonicalShadowHandler(pool,{pageSize:Math.min(pageSize,128),deferMs})(job,signal)
  }
  const contexts=await loadSourceContextSet(pool,scope.installationId,root,scan)
  requireSourceContext(contexts,scope,cursor)
  await checkSourceContextSet(pool,root,contexts)
  const team=root.kind==='team_collaboration'||root.kind==='team_delivery'
  const publishTeam=async()=>{
   const prepared=await prepareTeamSemanticPublication(pool,scope.installationId,root)
   if(prepared)await persistTeamSemanticPublication(pool,prepared,options.stabilizationMs)
  }
  if(team){
   const excluded=await prepareTeamSemanticPublication(pool,scope.installationId,root,{metadataOnly:true})
   if(excluded){await persistTeamSemanticPublication(pool,excluded,options.stabilizationMs);return}
  }
  const progress=(await pool.query(`SELECT next_cursor,state,source_version FROM memory_canonical_projection_progress
   WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4`,[scope.installationId,root.kind,root.key,canonicalPayloadHash(scope).toString('hex')])).rows[0]
  if(progress?.state==='ready'||progress?.state==='raw_ready'){
   const current=await createObservedSourceReader(pool).checkCurrent(scope,root)
   if(current.state==='current'&&sameDerivedSourceVersion(current.version,progress.source_version)){if(team)await publishTeam();return}
   if(current.state!=='current'&&current.state!=='changed')throw new SourceUnavailableError(current.state)
  }
  let page
  try{page=await prepareCanonicalReferencePage(pool,scope,root,{limit:pageSize,cursor:progress?.next_cursor??undefined})}
  catch(error){
   // A newer source revision invalidates the old cursor. Restart enumeration
   // under the new authority snapshot; existing source UUIDs are reused.
   if(!progress?.next_cursor||!(error instanceof SourceUnavailableError)||error.code!=='changed')throw error
   page=await prepareCanonicalReferencePage(pool,scope,root,{limit:pageSize})
  }
  if(signal.aborted)throw Error('canonical_projection_aborted')
  // Body IO can span a control change or a newer distribution. The immutable
  // execution clock and source/root fences repeat this at physical COMMIT.
  requireSourceContext(await loadSourceContextSet(pool,scope.installationId,root,scan),scope,cursor)
  await persistCanonicalReferencePage(pool,page,{project:true,checkpoint:true,stabilizationMs:options.stabilizationMs})
  if(team&&!page.hasMore)await publishTeam()
  if(page.hasMore)throw new JobDeferredError('source_not_ready',new Date(Date.now()+deferMs))
 }
}
