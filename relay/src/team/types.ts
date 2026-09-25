export const TEAM_CONTRACT_VERSION = 'team-collaboration.v1' as const
export const TEAM_PROTOCOL_VERSION = 1 as const

export type TeamID = string
export type TeamMembershipID = string
export type TeamInvitationID = string
export type TeamAgentOfferID = string
export type TeamTaskID = string
export type TeamSessionID = string
export type TeamParticipantID = string
export type TeamAgentBindingID = string
export type TeamEventID = string
export type TeamContextVersionID = string
export type TeamRunID = string
export type TeamCallID = string
export type TeamMemoryBindingID = string

export type TeamState = 'active' | 'dissolved'
export type TeamMembershipState = 'active' | 'left' | 'removed'
export type TeamInvitationState = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
export type TeamAgentOfferState = 'active' | 'revoked'
export type TeamAgentAvailability = 'online' | 'offline' | 'unsupported' | 'unmanaged' | 'occupied'
export type TeamTaskState = 'open' | 'in_progress' | 'completed' | 'archived' | 'deleted'
export type TeamSessionState = 'active' | 'paused' | 'ended' | 'archived'
export type TeamRunState = 'ready' | 'running' | 'waiting_input' | 'blocked' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type TeamCallState = 'pending' | 'dispatched' | 'accepted' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'uncertain'
export type TeamEventKind = 'member_message' | 'agent_message' | 'status' | 'context' | 'run' | 'system'
export type TeamMessageTargetMode = 'offers' | 'all' | 'discussion'
export type TeamProvider = 'codex' | 'claude-code'

export const TEAM_DAEMON_CAPABILITIES = Object.freeze([
  'team_collaboration_dispatch_v1',
  'team_collaboration_context_v1',
  'team_collaboration_reconcile_v1',
] as const)

export type TeamDaemonCapability = typeof TEAM_DAEMON_CAPABILITIES[number]

export interface TeamRecord {
  id: TeamID
  name: string
  creator_user_id: number
  state: TeamState
  revision: number
  created_at: string
  updated_at: string
}

export interface TeamMembership {
  id: TeamMembershipID
  team_id: TeamID
  user_id: number
  state: TeamMembershipState
  revision: number
  joined_at: string
  ended_at: string | null
}

export interface TeamInvitation {
  id: TeamInvitationID
  team_id: TeamID
  invited_by_user_id: number
  recipient_user_id: number | null
  recipient_email: string | null
  state: TeamInvitationState
  revision: number
  expires_at: string
  created_at: string
}

export interface TeamAgentOffer {
  id: TeamAgentOfferID
  team_id: TeamID
  owner_user_id: number
  daemon_id: string
  provider: TeamProvider
  runtime_profile_id: string | null
  capability_revision: number
  state: TeamAgentOfferState
  revision: number
  availability: TeamAgentAvailability
  created_at: string
  updated_at: string
}

export interface TeamTask {
  id: TeamTaskID
  team_id: TeamID
  creator_user_id: number
  title: string
  background: string
  state: TeamTaskState
  previous_state: Exclude<TeamTaskState, 'archived' | 'deleted'> | null
  revision: number
  holder_user_ids: number[]
  session_ids: TeamSessionID[]
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface TeamSession {
  id: TeamSessionID
  team_id: TeamID
  creator_user_id: number
  task_id: TeamTaskID | null
  title: string
  state: TeamSessionState
  revision: number
  latest_event_seq: number
  current_context_version: number
  created_at: string
  updated_at: string
}

export interface TeamParticipant {
  id: TeamParticipantID
  team_session_id: TeamSessionID
  user_id: number
  state: 'active' | 'removed'
  added_by_user_id: number
  created_at: string
  removed_at: string | null
}

export interface TeamAgentBinding {
  id: TeamAgentBindingID
  team_session_id: TeamSessionID
  offer_id: TeamAgentOfferID
  owner_user_id: number
  native_session_id: string | null
  state: 'active' | 'removed' | 'unavailable'
  revision: number
  created_at: string
  updated_at: string
}

export interface TeamEventReference {
  event_id: TeamEventID
  event_seq: number
}

export interface TeamEvent {
  id: TeamEventID
  team_session_id: TeamSessionID
  event_seq: number
  kind: TeamEventKind
  author_user_id: number | null
  author_offer_id: TeamAgentOfferID | null
  target_mode: TeamMessageTargetMode | null
  target_offer_ids: TeamAgentOfferID[]
  reference: TeamEventReference | null
  context_version: number | null
  call_id: TeamCallID | null
  content: string
  created_at: string
}

export interface TeamContextSnapshot {
  id: TeamContextVersionID
  team_session_id: TeamSessionID
  version: number
  revision: number
  goal: string
  consensus: string[]
  open_questions: string[]
  references: TeamContextReference[]
  content_hash: string
  created_by_user_id: number
  created_at: string
}

export interface TeamContextReference {
  source_kind: 'team_event' | 'memory_claim' | 'memory_evidence' | 'wiki_section'
  source_id: string
  source_version: string
  owner_scope_id: string | null
  installation_id: string | null
}

export interface TeamRunBudget {
  max_calls: number
  max_concurrent_calls: number
  max_duration_seconds: number
}

export interface TeamRun {
  id: TeamRunID
  team_session_id: TeamSessionID
  initiator_user_id: number
  coordinator_offer_id: TeamAgentOfferID
  context_version: number
  state: TeamRunState
  stop_requested: boolean
  budget: TeamRunBudget
  calls_used: number
  next_step: number
  processed_call_step: number
  revision: number
  waiting_question: string | null
  terminal_reason: string | null
  started_at: string | null
  deadline_at: string
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface TeamCall {
  id: TeamCallID
  team_session_id: TeamSessionID
  run_id: TeamRunID | null
  run_step: number | null
  run_role: 'coordinator' | 'worker' | null
  offer_id: TeamAgentOfferID
  native_session_id: string | null
  provider_request_id: string | null
  context_version: number
  state: TeamCallState
  outcome: string | null
  created_at: string
  updated_at: string
}

export interface TeamMemoryBinding {
  id: TeamMemoryBindingID
  team_id: TeamID
  owner_scope_id: string
  installation_id: string
  revision: number
  created_by_user_id: number
  created_at: string
  updated_at: string
}

export interface TeamMutationRequest {
  request_id: string
  expected_revision?: number
}

export interface TeamErrorEnvelope {
  error: {
    code: TeamErrorCode
    message: string
    retryable: boolean
    reconcile_required?: boolean
    current_revision?: number
  }
}

export type TeamErrorCode =
  | 'team_feature_disabled'
  | 'team_not_found'
  | 'membership_required'
  | 'participant_required'
  | 'creator_required'
  | 'offer_owner_required'
  | 'memory_grant_required'
  | 'invalid_state'
  | 'revision_conflict'
  | 'context_revision_conflict'
  | 'idempotency_conflict'
  | 'daemon_team_conflict'
  | 'agent_unavailable'
  | 'capability_not_supported'
  | 'no_callable_agent'
  | 'dispatch_uncertain'
  | 'budget_exhausted'
