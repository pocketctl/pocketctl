import type {JobClaim} from '../jobs/types.js'
import type {SourceRoot} from '@pocketctl/session-source'

/** Admission hint after the repository's fenced completion acknowledgement. */
export function wakeCompletedPersonalProjection(job:JobClaim,outcome:string,wake:(root:SourceRoot)=>void):void{
 if(outcome!=='completed'||job.job_type!=='project_shared_source'||!job.installation_id)return
 const payload=job.payload
 if(!payload||typeof payload!=='object')return
 const scope=payload.scope as Record<string,unknown>|undefined,root=payload.root as Record<string,unknown>|undefined
 if(!scope||scope.ownerScopeKind!=='personal'||scope.installationId!==job.installation_id)return
 if(!root||root.kind!=='relay_event'||typeof root.key!=='string'||root.key.length===0||root.key.length>1024)return
 // The normal ordered SQL claim remains the authority; this is only a hint.
 wake({kind:'relay_event',key:root.key})
}
