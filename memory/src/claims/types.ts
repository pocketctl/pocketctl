/** Claim ledger domain types (plan §5.3 lifecycle). */

export type ClaimState = 'active' | 'superseded' | 'expired' | 'revoked'

export type ClaimType =
  | 'architecture_decision'
  | 'repository_convention'
  | 'bug_root_cause'
  | 'rejected_hypothesis'
  | 'test_invariant'
  | 'implementation_map'
  | 'operational_runbook'
  | 'work_method'
  | 'reusable_skill_candidate'

export type ScopeKind = 'installation' | 'repository' | 'snapshot' | 'branch' | 'task'

export type VersionAuthority = 'user_accepted' | 'user_corrected'

export type FeedbackAction =
  | 'candidate_accepted'
  | 'candidate_corrected'
  | 'candidate_rejected'
  | 'claim_corrected'
  | 'claim_expired'
  | 'claim_revoked'
  | 'claim_deleted'
  | 'recall_used'
  | 'recall_incorrect'
  | 'recall_not_useful'

export interface EvidenceInput {
  evidenceKind: 'event' | 'artifact' | 'episode'
  sourceEventId?: string | null
  artifactId?: string | null
  /** Episode the evidence row binds to (required for episode evidence). */
  episodeId?: string | null
  locator: Record<string, unknown>
  excerpt: string
  occurredAt: Date
}

export interface AcceptedClaim {
  claimId: string
  versionId: string
  versionNumber: number
  state: ClaimState
  revision: number
}
