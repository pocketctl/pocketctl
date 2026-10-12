import {z} from 'zod'
import type {ClaimApplicability} from './revision-bundle.js'

const ApplicabilitySchema=z.object({
 scopeKind:z.enum(['installation','repository','snapshot','branch','task']),scopeKey:z.string(),
 canonicalRepositoryKey:z.string().nullable(),repositoryId:z.string().nullable(),snapshotId:z.string().nullable(),branch:z.string().nullable(),
 status:z.enum(['verified','legacy_unknown','requires_review']),
}).strict()
export interface ClaimConsumptionFacts {
 scopeKind:string;scopeKey:string;repositoryId:string|null;snapshotId:string|null;branch:string|null
 applicability?:unknown;consumptionHoldReason?:string|null;canonicalRepositoryKey?:string|null
}
export interface ApplicabilityContext {repositoryId?:string|null;snapshotId?:string|null;branch?:string|null;taskScopeKey?:string|null}
export type ApplicabilityReason='consumption_hold'|'invalid_applicability'|'legacy_unknown'|'requires_review'|'metadata_mismatch'|'repository_context_required'|'snapshot_context_required'|'branch_context_required'|'task_context_required'
export type ClaimConsumptionDecision={eligible:true;reason:null}|{eligible:false;reason:ApplicabilityReason}

/** Explicit v2 metadata fails closed. Null metadata is the temporary, unmigrated v1 bridge. */
export function claimConsumptionDecision(facts:ClaimConsumptionFacts,context:ApplicabilityContext={}):ClaimConsumptionDecision {
 const deny=(reason:ApplicabilityReason):ClaimConsumptionDecision=>({eligible:false,reason})
 if(facts.consumptionHoldReason!=null)return deny('consumption_hold')
 if(facts.applicability==null)return{eligible:true,reason:null}
 const parsed=ApplicabilitySchema.safeParse(facts.applicability)
 if(!parsed.success)return deny('invalid_applicability')
 const app:ClaimApplicability=parsed.data
 if(app.status!=='verified')return deny(app.status)
 if(!matchesProjection(app,facts))return deny('metadata_mismatch')
 if(['repository','snapshot','branch'].includes(app.scopeKind)){
  if(!confirmedCanonicalRepositoryKey(app.canonicalRepositoryKey)||!app.repositoryId)return deny('invalid_applicability')
  if(context.repositoryId!==app.repositoryId)return deny('repository_context_required')
 }
 if(app.scopeKind==='snapshot'&&(!app.snapshotId||context.snapshotId!==app.snapshotId))return deny('snapshot_context_required')
 if(app.scopeKind==='branch'&&(!app.branch||context.branch!==app.branch))return deny('branch_context_required')
 if(app.scopeKind==='task'&&(!app.scopeKey||context.taskScopeKey!==app.scopeKey))return deny('task_context_required')
 return{eligible:true,reason:null}
}

/** Canonical identities are already confirmed host/path keys, not cwd, basenames or raw remote URLs. */
export function confirmedCanonicalRepositoryKey(key:string|null):key is string {
 if(!key || !/^[a-z0-9.-]+(?::[0-9]{1,5})?\/[^\s?#@\\]+$/.test(key))return false
 return key.slice(key.indexOf('/')+1).split('/').every(segment=>segment!==''&&segment!=='.'&&segment!=='..')
}
function matchesProjection(app:ClaimApplicability,facts:ClaimConsumptionFacts):boolean {
 return app.scopeKind===facts.scopeKind&&app.scopeKey===facts.scopeKey&&app.repositoryId===facts.repositoryId
  &&app.snapshotId===facts.snapshotId&&app.branch===facts.branch
  &&(facts.canonicalRepositoryKey===undefined||app.canonicalRepositoryKey===facts.canonicalRepositoryKey)
}
/** Freeze proven source metadata. Inconsistent/unknown metadata is retained for review, never widened. */
export function captureSourceApplicability(facts:ClaimConsumptionFacts):ClaimApplicability {
 const projected=ApplicabilitySchema.parse({scopeKind:facts.scopeKind,scopeKey:facts.scopeKey,
  canonicalRepositoryKey:facts.canonicalRepositoryKey??null,repositoryId:facts.repositoryId,snapshotId:facts.snapshotId,branch:facts.branch,
  status:facts.scopeKind==='installation'?'verified':'legacy_unknown'})
 if(facts.consumptionHoldReason!=null)return{...projected,status:'requires_review'}
 if(facts.applicability==null)return projected
 const parsed=ApplicabilitySchema.safeParse(facts.applicability)
 if(!parsed.success||!matchesProjection(parsed.data,facts))return{...projected,status:'requires_review'}
 const app=parsed.data
 if(app.status==='verified'&&!claimConsumptionDecision({...facts,applicability:app},
  {repositoryId:app.repositoryId,snapshotId:app.snapshotId,branch:app.branch,taskScopeKey:app.scopeKey}).eligible)
  return{...projected,status:'requires_review'}
 return app
}
