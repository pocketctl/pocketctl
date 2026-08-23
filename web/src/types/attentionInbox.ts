export type AttentionInboxMode = 'off' | 'observe' | 'on'
export type AttentionInboxProvider = 'codex' | 'opencode' | 'claude-code'
export type AttentionInboxKind = 'approval' | 'question'
export type AttentionInboxDisplayKind = AttentionInboxKind | 'recovery'
export type AttentionInboxState = 'open' | 'snoozed' | 'submitting' | 'result_unknown' | 'resolved' | 'expired'
export type AttentionRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type AttentionActionID = 'once' | 'always' | 'reject' | 'cancel' | 'answer'
export type AttentionMetadataOperation = 'mark_seen' | 'snooze' | 'restore'

export type AttentionInboxScope =
  | { type: 'global' }
  | { type: 'daemon'; daemonId: string; daemonName?: string }

export interface AttentionProviderCapability {
  projection: boolean
  remote_response: boolean
}

export interface AttentionInboxCapabilities {
  schema_version: 1 | 2
  mode: AttentionInboxMode
  enabled: boolean
  remote_response_enabled: boolean
  providers: Record<AttentionInboxProvider, AttentionProviderCapability>
  recovery?: {
    mode: AttentionInboxMode
    projection: boolean
    visible: boolean
  }
}

export interface AttentionInboxAction {
  id: AttentionActionID
  style: 'primary' | 'secondary' | 'danger'
  destructive: boolean
  label_key: string
}

export interface AttentionQuestionOption {
  label: string
  description?: string
}

export interface AttentionQuestion {
  id?: string
  header?: string
  question: string
  options?: Array<AttentionQuestionOption | string>
  multiple?: boolean
  custom?: boolean
  secret?: boolean
}

export interface AttentionInboxContext {
  approval_kind?: string
  tool?: string
  command?: string
  cwd?: string
  description?: string
  files?: string[]
  permission_name?: string
  patterns?: string[]
  always_rules?: string[]
  questions?: AttentionQuestion[]
  context_truncated?: boolean
  [key: string]: unknown
}

export interface AttentionInboxItem {
  item_id: string
  revision: number
  provider: AttentionInboxProvider
  kind: AttentionInboxKind
  state: AttentionInboxState
  risk: {
    level: AttentionRiskLevel
    classification_incomplete: boolean
    reasons: string[]
  }
  daemon: { id: string; display_name: string }
  session: { id: string; title: string; status: string | null }
  request_id: string
  title: string
  summary: string
  context: AttentionInboxContext
  allowed_actions: AttentionInboxAction[]
  seen_at: string | null
  snoozed_until: string | null
  submitted_at: string | null
  resolved_at: string | null
  handled_at: string | null
  expires_at: string | null
  resolution: Record<string, unknown> | null
  last_error: { code: string } | null
  created_at: string
  updated_at: string
}

export interface AttentionInboxCounts {
  actionable: number
  open: number
  snoozed: number
  submitting: number
  result_unknown: number
  recovery_open?: number
  recovery_snoozed?: number
  attention_required?: number
}

export interface AttentionRecoveryItem {
  recovery_id: string
  revision: number
  kind: 'recovery'
  state: 'open' | 'snoozed' | 'resolved'
  reason_code: 'daemon_offline'
  daemon: { id: string; display_name: string }
  navigation: { type: 'host'; daemon_id: string }
  last_seen_at: string
  seen_at: string | null
  snoozed_until: string | null
  resolved_at: string | null
  handled_at: string | null
  resolution: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface AttentionInboxSnapshot {
  schema_version: 1 | 2
  server_time: string
  capabilities: AttentionInboxCapabilities
  scope: { type: 'global' | 'daemon'; daemon_id: string | null }
  counts: AttentionInboxCounts
  items: AttentionInboxItem[]
  recovery_items?: AttentionRecoveryItem[]
  next_cursor: string | null
}

export interface AttentionInboxItemResponse { item: AttentionInboxItem }
export interface AttentionRecoveryResponse { recovery: AttentionRecoveryItem }

export interface AttentionInboxActionResponse {
  outcome: 'submitted' | 'idempotent' | 'resolved_elsewhere'
  receipt_id?: string | number
  item: AttentionInboxItem
  final: boolean
}
