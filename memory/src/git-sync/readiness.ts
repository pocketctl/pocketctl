/** Registration is a prerequisite, not a current authority or provider health proof.
 * Poll admission still revalidates the registered principal on every run. */
export function gitBootstrapStatus(mode:string,facts:{snapshot?:boolean;principal?:boolean}|undefined) {
 if(mode==='off')return {state:'disabled',reason:'feature_disabled',next_action:null} as const
 if(!facts?.snapshot)return {state:'required',reason:'initial_export_required',next_action:'export_authorized_assets'} as const
 if(!facts.principal)return {state:'required',reason:'sync_principal_required',next_action:'enroll_authorized_export'} as const
 return {state:'registered',reason:'poll_admission_required',next_action:null} as const
}
