/** Strict document content; authorization and execution results never come from this document. */
export interface MemorySkillDocument {
  schema_version: 'skill-candidate.v1'
  title: string
  trigger: string
  preconditions: string[]
  steps: Array<{
    instruction: string
    tool: string
    permissions: string[]
    operation: 'read' | 'local_write' | 'unknown' | 'deployment' | 'deletion' | 'production_write' | 'permission_change' | 'data_migration'
  }>
  validation: string[]
  failure_handling: string[]
  rollback: string[]
  source_tokens: string[]
}

export interface MemorySkillModes {
  mode: 'off' | 'shadow' | 'enabled'
  auto_publish_mode: 'off' | 'shadow' | 'enabled'
  canary_mode: 'off' | 'shadow' | 'enabled'
}
export interface MemorySkillSummary {
  skill_id: string; version_id: string; version_number: number; revision: number
  state: string; title: string; risk: 'low' | 'high' | 'unknown'; repository_id: string; created_at: string
}
export interface MemorySkillVersion {
  version_id: string; version_number: number; document_hash: string; policy_hash: string
  risk: string; created_at: string
}
export interface MemorySkillCandidate {
  candidate_id: string; task_id: string; generation: number; archive_id: string
  document: MemorySkillDocument; risk: string; risk_reasons: string[]; repository_id: string
  created_at: string; expected_revision: number; can_draft: boolean
}
export interface MemorySkillPage<T> extends MemorySkillModes { items: T[]; next_cursor: string | null }
export interface MemorySkillReplayCounts { total: number; pending: number; passed: number; failed: number; cancelled: number }
export interface MemorySkillReplay {
  run_id: string | null; state: 'not_run' | 'running' | 'passed' | 'failed' | 'cancelled'
  eligible: boolean; error_code: string | null; natural_execution_count: number
  provenance: { fixture: number; recorded: number }
  kinds: { historical_session: MemorySkillReplayCounts; golden_task: MemorySkillReplayCounts }
}
export interface MemorySkillReplayCase { case_id: string; kind: 'historical_session' | 'golden_task'; provenance: 'fixture' | 'recorded' }
export interface MemorySkillEligibility {
  eligible: boolean; manual_eligible: boolean; reason_codes: string[]; independent_successes: number
  required_independent_successes: number; product_gate: string; policy_hash: string | null; replay_run_id: string | null
}
export interface MemorySkillDetail extends MemorySkillSummary, MemorySkillModes {
  document: MemorySkillDocument; document_hash: string; source_digest: string; archive_id: string; policy_hash: string
  risk_reasons: string[]
  sources: Array<{ token: string; handle: string; excerpt_hash: string; event_id: string | null; artifact_id: string | null; evidence_id: string | null }>
  versions: MemorySkillVersion[]; replay: MemorySkillReplay
  publication: Record<string, unknown> | null; executions: Record<string, unknown>[]
  eligibility: MemorySkillEligibility | null
  permissions: {
    can_edit: boolean; can_review: boolean; can_replay: boolean; can_publish: boolean
    can_revoke: boolean; can_rollback: boolean; can_manage_policy: boolean
  }
}
export interface MemorySkillMutation { skill_id: string; version_id: string; revision: number; state: string; decision_id?: string }
export type MemorySkillReviewOutcome = 'accepted_as_is' | 'light_edit' | 'major_edit'
export interface MemorySkillDiff { from_version_id: string; to_version_id: string; changes: Array<{ field: string; before: unknown; after: unknown }> }
export interface MemorySkillPolicy {
  minimum_independent_successes: number; auto_mode: 'off' | 'shadow'; canary_mode: 'off' | 'shadow'
}
export interface MemorySkillPolicyState { revision: number; version_id: string | null; hash: string; policy: MemorySkillPolicy; can_manage_policy: boolean }
