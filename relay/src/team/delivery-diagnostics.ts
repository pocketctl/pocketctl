// Never return raw native outcomes: they may contain private paths or output.
const inputCodes = new Set([
 'authorization_required','source_busy','step_input_unavailable','team_not_found',
 'access_denied','team_feature_disabled','artifact_unavailable','artifact_integrity',
 'input_limit_exceeded','revision_conflict',
])
const localCodes = new Set([
 'context_budget_exceeded', 'context_snapshot_unavailable',
 'step_input_transport_unavailable','step_input_response_invalid','step_input_manifest_invalid',
 'step_input_authorization_invalid','step_input_manifest_binding_invalid','step_task_context_binding_invalid',
 'step_input_snapshot_invalid','step_input_source_invalid','step_input_artifact_invalid',
 'step_input_limit_exceeded','step_input_directory_invalid','step_input_artifact_integrity',
 'step_input_manifest_changed','step_input_local_manifest_limit','step_input_existing_invalid',
 'step_input_existing_changed',
])
export function deliveryFailureCode(state: string, outcome: unknown): string | null {
 if(state!=='failed'&&state!=='blocked')return null
 if(typeof outcome==='string') {
  if(localCodes.has(outcome))return outcome
  const match=/^delivery_http_([45][0-9]{2}):([a-z_]+)$/.exec(outcome)
  if(match&&inputCodes.has(match[2]))return outcome
 }
 return 'execution_failed'
}
