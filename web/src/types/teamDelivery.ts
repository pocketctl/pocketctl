export interface ReviewPolicy { reviewer_user_id: number; primary_offer_id: string; required_checks: string[] }
export interface DeliverySpec extends ReviewPolicy { task_id: string; revision: number | string; goal: string; acceptance: string }
export interface DeliveryArtifact { id: string; name: string; mime_type: string; byte_size: number; sha256: string; required: boolean }
export interface DeliveryEvidence { check_id: string; result: 'passed'|'failed'|'unverified'; source_kind: 'agent_claim'; artifact_id: string; code_revision: string | null }
export interface TaskSubmission {
  submission_id: string; spec_revision: string | number; version: string | number | null; state: 'preparing'|'published';
  summary: string; delivery_role: 'primary'|'contribution'; submitted_by_user_id: number; source_call_id: string;
  source_offer_id: string; source_run_id: string | null; context_version: string | number; code_revision: string | null;
  manifest: DeliveryArtifact[]; evidence: DeliveryEvidence[]; revoked_artifact_ids: string[];
  contribution_ids: string[]; published_at: string | null;
  decision_id?: string | null;
  personal_memory_capture?: 'captured'|'not_captured'|'access_revoked'|'withdrawn'|null;
  decision: 'accepted'|'changes_requested'|null; decision_reason: string | null;
}
export interface TrustedDeliveryEvidence {
 evidence_id:string;submission_id:string;connector_id:string;principal_user_id:number;connector_kind:'ci'|'review';repository:string;
 run_id:string;check_id:string;spec_revision:number|string;code_revision:string;result:'passed'|'failed'|'unverified';report_sha256:string;received_at:string
}
export interface TaskDelivery {
  attempt_id?:string;
  trusted_evidence?:TrustedDeliveryEvidence[];
  team_id?: string;
  task_id: string; task_state: string; revision: number; spec: DeliverySpec; specs: DeliverySpec[];
  latest_submission_id: string | null; submissions: TaskSubmission[]; writes_enabled: boolean;
}
export interface DeliveryDecision {
  request_id: string; expected_revision: number; submission_id: string; spec_revision: number;
  decision: 'accepted'|'changes_requested'; reason: string; verified_checks: string[];
}
export interface DeliveryReminder {
  attempt_id?: string | null;
  item_id: string; task_id: string; team_id: string; title: string; submission_id: string;
  version: string | number; kind: 'review_required'|'changes_requested'; seen_at: string | null;
  team_session_id: string; delivery_revision: string | number; has_revoked_artifacts: boolean;
}
export interface DeliveryExecution {
 provider?: string
  export_status?: {phase:'waiting_for_files'|'publication_pending'|'blocked'|'published';error_code:string|null;revision:number;updated_at:string}|null;
  call_id: string; team_session_id: string; offer_id: string; state: string; spec_revision: string | number | null;
  created_at: string; dispatched_at: string | null; accepted_at: string | null; started_at: string | null; finished_at: string | null;
  deliveries: Array<{ submission_id: string; version: number; published_at: string }>;
}

export interface DeliveryManagement {
  task_revision?: number; requirements_revision?: number;
  display_offers?: Array<{offer_id:string;provider:string;owner_user_id:number}>;
  can_manage: boolean; revision: number; spec_revision: number;
  reviewers: Array<{user_id:number}>;
  offers: Array<{offer_id:string; provider:string; owner_user_id:number}>;
  sessions: Array<{team_session_id:string; title:string; current_context_version:number; offer_ids:string[]}>;
  execution_block: 'read_only'|'outstanding_execution'|'accepted_delivery'|null;
}
export interface DeliverySpecRevision {
  request_id:string; expected_revision:number; goal:string; acceptance:string; policy:ReviewPolicy;
}
export interface DeliveryExecute {
  expected_task_revision?: number;
  request_id:string; expected_revision:number; spec_revision:number; context_version:number; target_offer_ids:string[];
}

export interface SessionDeliveryCard {
 task_id:string;title:string;task_state:string;revision:number;spec_revision:number;reviewer_user_id:number;
 event_id:string|null;source_call_id:string|null;latest_submission_id:string|null;submission_spec_revision:number|null;
 version:number|null;summary:string|null;published_at:string|null;decision:'accepted'|'changes_requested'|null;decision_reason:string|null;
 execution_pending:boolean;files:Array<{id:string;name:string;byte_size:number}>;revoked_artifact_ids:string[];
}
export interface SessionDeliveryCards {team_id:string;team_session_id:string;items:SessionDeliveryCard[];next_cursor:string|null}
