const stages=new Set(['pin_acquire','pin_renew','metadata_queue','metadata_checkout','metadata_transaction','metadata_commit','selected_commit'])
const reasons=new Set(['invalid_input','execution_invalid','authority_or_version_changed','authority_changed','content_version_changed','authorization_version_changed','storage_version_changed','native_unavailable','activity_unavailable','renewal_missing','capacity_limit','lease_or_scope_changed','activity_regressed','execution_deadline','lock_conflict','acquire_denied','transport_deadline','statement_timeout','cancelled'])
export function isSourceFailureDetail(stage:string,reason:string):boolean {
 return stages.has(stage)&&reasons.has(reason)
}
const failures=new WeakMap<object,{source_stage:string;source_reason:string;source_stage_ms?:number;source_remaining_ms?:number}>()
/** Diagnostics cannot change retry policy or carry arbitrary SQL/user text. */
export function annotateSourceFailure<T>(error:T,stage:string,reason:string,timing?:{started:number;deadline:number}):T {
 if(error&&typeof error==='object'&&isSourceFailureDetail(stage,reason)){
  const now=performance.now()
  failures.set(error,{source_stage:stage,source_reason:reason,...(timing && {
   source_stage_ms:Math.max(0,Math.round(now-timing.started)),
   source_remaining_ms:Math.max(0,Math.round(timing.deadline-now)),
  })})
 }
 return error
}
export function sourceFailureFields(error:unknown):Record<string,string|number>{return error&&typeof error==='object'?{...failures.get(error)}:{}}

/** Carry only fixed diagnostic fields across the public source-error boundary. */
export function copySourceFailure(error:unknown,target:Error):void {
 const fields=error && typeof error==='object' ? failures.get(error) : undefined
 if(fields)failures.set(target,fields)
}
