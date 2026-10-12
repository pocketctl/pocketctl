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

/** Personal write authority remains restricted; reading future values does not
 * expand the personal writer's accepted authority enum. */
export type VersionAuthority = 'user_accepted' | 'user_corrected'
export type KnownVersionAuthority = VersionAuthority | 'automation_accepted' | 'team_reviewed' | 'team_published' | 'organization_reviewed' | 'organization_published'
export type ReadableVersionAuthority = KnownVersionAuthority | (string & {})

/** Additive read metadata only. An unrecognized/machine value must never fall
 * back to a human label. Preserve the original wire value beside this result. */
export function versionAuthorityCompatibility(value:unknown):{recognized:boolean,human_approved:boolean}{
 const human=typeof value==='string'&&['user_accepted','user_corrected','team_reviewed','team_published','organization_reviewed','organization_published'].includes(value)
 return {recognized:human||value==='automation_accepted',human_approved:human}
}

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
