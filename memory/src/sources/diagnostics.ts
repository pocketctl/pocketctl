const stages=new Set(['pin_acquire','pin_renew','metadata_checkout','metadata_transaction','selected_commit'])
const reasons=new Set(['invalid_input','execution_invalid','authority_or_version_changed','native_unavailable','activity_unavailable','renewal_missing','capacity_limit','lease_or_scope_changed','activity_regressed','execution_deadline','lock_conflict','acquire_denied','transport_deadline','statement_timeout'])
const failures=new WeakMap<object,{source_stage:string;source_reason:string}>()
/** Diagnostics cannot change retry policy or carry arbitrary SQL/user text. */
export function annotateSourceFailure<T>(error:T,stage:string,reason:string):T {
 if(error&&typeof error==='object'&&stages.has(stage)&&reasons.has(reason))failures.set(error,{source_stage:stage,source_reason:reason})
 return error
}
export function sourceFailureFields(error:unknown):Record<string,string>{return error&&typeof error==='object'?{...failures.get(error)}:{}}
