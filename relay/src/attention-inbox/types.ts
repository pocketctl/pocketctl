export type AttentionInboxMode = 'off' | 'observe' | 'on'
export type AttentionProvider = 'codex' | 'opencode' | 'claude-code'
export type AttentionRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type AttentionItemKind = 'approval' | 'question'
export type AttentionItemState =
  | 'open'
  | 'snoozed'
  | 'submitting'
  | 'result_unknown'
  | 'resolved'
  | 'expired'
export type AttentionRecoveryState = 'open' | 'snoozed' | 'resolved'

export type AttentionActionID = 'once' | 'always' | 'reject' | 'cancel' | 'answer'

export interface AttentionAction {
  id: AttentionActionID
  style: 'primary' | 'secondary' | 'danger'
  destructive: boolean
  labelKey: string
}

export interface AttentionProviderCapability {
  projection: boolean
  remoteResponse: boolean
}

export interface AttentionInboxConfig {
  schemaVersion: 1
  mode: AttentionInboxMode
  enabled: boolean
  remoteResponseEnabled: boolean
  providers: Record<AttentionProvider, AttentionProviderCapability>
  recovery: {
    mode: AttentionInboxMode
    projection: boolean
    visible: boolean
  }
}

export interface AttentionRecoveryRecord {
  recoveryId: string
  userId: number
  daemonId: string
  registrationGeneration: string
  state: AttentionRecoveryState
  revision: number
  reasonCode: 'daemon_offline'
  daemonDisplayName: string
  lastSeenAt: Date
  seenAt: Date | null
  snoozedUntil: Date | null
  resolvedAt: Date | null
  handledAt: Date | null
  resolution: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export interface AttentionItemDraft {
  userId: number
  daemonId: string
  sessionId: string
  requestId: string
  provider: Exclude<AttentionProvider, 'claude-code'>
  kind: AttentionItemKind
  riskLevel: AttentionRiskLevel
  classificationIncomplete: boolean
  riskReasons: string[]
  title: string
  summary: string
  context: Record<string, unknown>
  allowedActions: AttentionAction[]
  sourceEventId: number
  sourceEventType: string
  sourceEventKey: string | null
  expiresAt: Date | null
  createdAt: Date
}

export interface AttentionItemIdentity {
  userId: number
  daemonId: string
  sessionId: string
  requestId: string
  kind: AttentionItemKind
}

export type AttentionProjection =
  | { operation: 'upsert'; item: AttentionItemDraft }
  | {
      operation: 'resolve'
      identity: AttentionItemIdentity
      resolutionEventId: number
      resolution: Record<string, unknown>
    }

export type AttentionInteractionCommand =
  | {
      type: 'approval_response'
      session_id: string
      request_id: string
      action: Extract<AttentionActionID, 'once' | 'always' | 'reject' | 'cancel'>
    }
  | {
      type: 'question_response'
      session_id: string
      request_id: string
      answers: string[][]
    }
  | {
      type: 'question_reject'
      session_id: string
      request_id: string
    }

export type AttentionInteractionRouteResult =
  | { accepted: true }
  | {
      accepted: false
      code:
        | 'session_not_found'
        | 'daemon_unreachable'
        | 'observer_read_only'
        | 'interaction_unsupported'
    }

export interface AttentionItemRecord {
  itemId: string
  userId: number
  daemonId: string
  sessionId: string
  requestId: string
  provider: AttentionProvider
  kind: AttentionItemKind
  state: AttentionItemState
  revision: number
  riskLevel: AttentionRiskLevel
  classificationIncomplete: boolean
  riskReasons: string[]
  title: string
  summary: string
  context: Record<string, unknown>
  allowedActions: AttentionAction[]
  seenAt: Date | null
  snoozedUntil: Date | null
  submittedAt: Date | null
  resolvedAt: Date | null
  handledAt: Date | null
  expiresAt: Date | null
  resolution: Record<string, unknown> | null
  lastErrorCode: string | null
  createdAt: Date
  updatedAt: Date
  daemonDisplayName?: string
  sessionTitle?: string
  sessionStatus?: string
}

export interface AttentionActionRequest {
  expectedRevision: number
  actionId: AttentionActionID
  answers?: string[][]
}

export type AttentionActionClaim =
  | { outcome: 'claimed'; item: AttentionItemRecord; receiptId: string }
  | { outcome: 'idempotent'; item: AttentionItemRecord; receiptId: string; status: string; errorCode?: string }
  | { outcome: 'already_submitting'; item: AttentionItemRecord }
  | { outcome: 'resolved_elsewhere'; item: AttentionItemRecord }
  | { outcome: 'not_found' }
  | { outcome: 'stale_revision'; item: AttentionItemRecord }
  | { outcome: 'idempotency_key_reused'; item: AttentionItemRecord }
  | { outcome: 'action_not_allowed'; item: AttentionItemRecord }
  | { outcome: 'provider_not_enabled'; item: AttentionItemRecord }
