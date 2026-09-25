export const TEAM_CONTRACT_VERSION = 'team-collaboration.v1' as const

export type TeamID = string
export type TeamAgentOfferID = string
export type TeamTaskID = string
export type TeamSessionID = string
export type TeamEventID = string
export type TeamRunID = string

export type TeamState = 'active' | 'dissolved'
export type TeamInvitationState = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
export type TeamAgentAvailability = 'online' | 'offline' | 'unsupported' | 'unmanaged' | 'occupied'
export type TeamTaskState = 'open' | 'in_progress' | 'completed' | 'archived' | 'deleted'
export type TeamSessionState = 'active' | 'paused' | 'ended' | 'archived'
export type TeamRunState = 'ready' | 'running' | 'waiting_input' | 'blocked' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type TeamMessageTargetMode = 'offers' | 'all' | 'discussion'
export type TeamProvider = 'codex' | 'claude-code'

export interface TeamCapabilities {
  schema_version: 1
  contract_version: typeof TEAM_CONTRACT_VERSION
  collaboration: boolean
  autorun: boolean
  memory_bridge: boolean
  writes_enabled: boolean
}

export interface TeamSummary {
  id: TeamID
  name: string
  creator_user_id: number
  state: TeamState
  revision: number
  member_count: number
  created_at: string
  updated_at: string
}

export interface TeamMember {
  id: string
  team_id: TeamID
  user_id: number
  display_label: string
  state: 'active' | 'left' | 'removed'
  revision: number
  joined_at: string
  ended_at: string | null
}

export interface TeamInvitation {
  id: string
  team_id: TeamID
  invited_by_user_id: number
  recipient_user_id: number | null
  recipient_email: string | null
  team_name?: string
  invited_by_label?: string
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
  state: 'active' | 'revoked'
  revision: number
  availability: TeamAgentAvailability
  installed: boolean
  online: boolean
  managed_callable: boolean
  dispatch_supported: boolean
  created_at: string
  updated_at: string
}

export interface TeamAgentCandidate {
  daemon_id: string
  hostname: string | null
  provider: TeamProvider
  installed: boolean
  online: boolean
  managed_callable: boolean
  dispatch_supported: boolean
  availability: TeamAgentAvailability
  occupied_team_id: TeamID | null
}

export interface TeamTask {
  id: TeamTaskID
  team_id: TeamID
  creator_user_id: number
  title: string
  background: string
  state: TeamTaskState
  previous_state: 'open' | 'in_progress' | 'completed' | null
  revision: number
  holder_user_ids: number[]
  session_ids: TeamSessionID[]
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface TeamSessionParticipant {
  id: string
  user_id: number
  state: string
  revision: number
}

export interface TeamSessionAgentBinding {
  id: string
  offer_id: TeamAgentOfferID
  owner_user_id: number
  daemon_id: string
  provider: TeamProvider
  state: string
  revision: number
  native_session_id: string | null
  availability: TeamAgentAvailability
}

export interface TeamSessionSummary {
  id: TeamSessionID
  team_id: TeamID
  creator_user_id: number
  task_id: TeamTaskID | null
  title: string
  state: TeamSessionState
  revision: number
  latest_event_seq: number
  current_context_version: number
  participants: TeamSessionParticipant[]
  agent_bindings: TeamSessionAgentBinding[]
  updated_at: string
  created_at: string
}

export type TeamSession = TeamSessionSummary

export interface TeamEventReference {
  event_id: TeamEventID
  event_seq: number
}

export interface TeamEvent {
  id: TeamEventID
  team_session_id: TeamSessionID
  event_seq: number
  kind: 'member_message' | 'agent_message' | 'status' | 'context' | 'run' | 'system'
  author_user_id: number | null
  author_offer_id: TeamAgentOfferID | null
  target_mode: TeamMessageTargetMode | null
  target_offer_ids: TeamAgentOfferID[]
  reference: TeamEventReference | null
  context_version: number | null
  call_id: string | null
  content: string
  created_at: string
}

export interface TeamContextReference {
  source_kind: 'team_event' | 'memory_claim' | 'memory_evidence' | 'wiki_section'
  source_id: string
  source_version: string
  owner_scope_id: string | null
  installation_id: string | null
}

export interface TeamContextSnapshot {
  id: string
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

export interface TeamRun {
  id: TeamRunID
  team_session_id: TeamSessionID
  coordinator_offer_id: TeamAgentOfferID
  context_version: number
  state: TeamRunState
  stop_requested: boolean
  budget: {
    max_calls: number
    max_concurrent_calls: number
    max_duration_seconds: number
  }
  calls_used: number
  revision: number
  created_at: string
  updated_at: string
}

export interface TeamApiErrorBody {
  error?: {
    code?: string
    message?: string
    retryable?: boolean
    reconcile_required?: boolean
    current_revision?: number
  }
}
