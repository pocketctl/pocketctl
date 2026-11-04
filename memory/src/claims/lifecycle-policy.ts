export const LIFECYCLE_DAY_MS = 86_400_000
export const LIFECYCLE_REVIEW_DAYS = 90
export const LIFECYCLE_COLD_DAYS = 90
export type LifecycleMode = 'off' | 'shadow' | 'enabled'
export interface LifecycleFacts {
 now: Date; createdAt: Date; validUntil: Date|null
 state: string; sourceAvailable: boolean; authority: string
 kind: 'fact'|'preference'|'constraint'|'decision'|'method'|'event'
 protection: 'none'|'pinned'|'critical'|'user_corrected'
 storageTier: 'hot'|'cold'; bodyState: 'present'|'reclaimed'; coldSince: Date|null
 lastConfirmedAt: Date|null; lastDeliveredAt: Date|null; lastConfirmedUseAt: Date|null
 observationState: 'unknown'|'observed'; observationStartedAt: Date|null
 valueAssessment: 'unknown'|'low'|'retain'
 coldMode: LifecycleMode; reclaimMode: LifecycleMode
}
export interface LifecycleDecision {
 action: 'retain'|'expire'|'revoke'|'cool'|'reclaim_eligible'
 reason: string
 nextEvaluateAt: Date
}
