import type pg from 'pg'
import type {SourceRoot,SourceScope} from '@pocketctl/session-source'
import type {JobHandler} from '../jobs/worker.js'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import {checkSourceContextSet,loadSourceContextSet,requireSourceContext} from './source-context-set.js'
import {sourceExecutionBranchFor} from './source-execution.js'
import {prepareTeamSemanticPublication,persistTeamSemanticPublication} from './team-semantic-publication.js'

export function createNativeTeamJobHandler(pool:pg.Pool,stabilizationMs:number,profile?:'personal-relay-only',onPublished?:(root:SourceRoot)=>void):JobHandler {
 return async(job,signal)=>{
  const {distribution_scan:scan,target_cursor:cursor}=job.payload
  const scope=job.payload.scope as SourceScope|undefined,root=job.payload.root as SourceRoot|undefined
  if(profile==='personal-relay-only'||!scope||scope.installationId!==job.installation_id||!root
   ||!['team_collaboration','team_delivery'].includes(root.kind)||typeof root.key!=='string'||!root.key||root.key.length>1024
   ||typeof scan!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(scan)
   ||typeof cursor!=='string'||!cursor||cursor.length>2048)throw new JobTerminalError('invalid_source_scope')
  if(sourceExecutionBranchFor(pool,scope.installationId)!=='canonical-active')throw new JobTerminalError('source_mode_generation_changed')
  signal.throwIfAborted()
  const set=await loadSourceContextSet(pool,scope.installationId,root,scan)
  requireSourceContext(set,scope,cursor)
  await checkSourceContextSet(pool,root,set)
  const publication=await prepareTeamSemanticPublication(pool,scope.installationId,root)
  if(!publication)throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
  signal.throwIfAborted()
  await persistTeamSemanticPublication(pool,publication,stabilizationMs)
  onPublished?.(root)
 }
}
