export type LifecycleMode = 'off' | 'observe' | 'enforce'
export type LifecycleAction = 'archive' | 'cool' | 'resume' | 'purge'
export type ContentState =
  | 'hot'
  | 'cooling'
  | 'cold'
  | 'mixed'
  | 'deleting'
  | 'deleted'
export type LifecycleJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
export type LifecycleBlocker =
  | 'policy_disabled'
  | 'policy_not_effective'
  | 'owner_unknown'
  | 'scope_excluded'
  | 'activity_unknown'
  | 'activity_invalid'
  | 'activity_future'
  | 'activity_unverified'
  | 'status_unknown'
  | 'session_active'
  | 'session_deleting'
  | 'session_deleted'
  | 'admission_pending'
  | 'inbox_pending'
  | 'outbox_pending'
  | 'attention_pending'
  | 'effect_pending'
  | 'document_upload_pending'
  | 'collaboration_pending'
  | 'dependency_unknown'
  | 'extension_pending'
  | 'usage_unverified'
  | 'cooling_pending'

export interface SessionLifecycleConfig {
  mode: LifecycleMode
  policyVersion: string
  archiveDays: number
  purgeDays: number
  effectiveAt: string | null
  transitionDeadline: string | null
  notificationRetentionDays: number
  scanIntervalMs: number
  batchSessions: number
  batchBytes: number
  runBudgetMs: number
  transferConcurrency: number
  maxChunkBytes: number
  maxCompressedBytes: number
  objectBucket: string | null
  objectRegion: string | null
}
export interface LifecycleInput {
  ownerUserId: number | null
  scope: 'personal' | 'team' | 'unknown'
  activityAt: string | null
  activityVerified: boolean
  dependencyActivityAt?: (string | null)[]
  status: string | null
  turnActive?: boolean
  archiveReason: 'manual' | 'inactivity' | null
  contentState: ContentState
  historical?: boolean
  pinned?: boolean
  blockers: LifecycleBlocker[]
}
export interface LifecycleEvaluation {
  action: LifecycleAction | null
  activityAt: string | null
  archiveAt: string | null
  purgeAt: string | null
  dueAt: string | null
  blockedReasons: LifecycleBlocker[]
  policyVersion: string
}
