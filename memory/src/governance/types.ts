/**
 * ADR-0005 governance domain types. The candidate state machine, review
 * policy document, and authority enum are frozen contracts (§6); unknown
 * values fail closed everywhere.
 */

export type PromotionCandidateState =
  | 'proposed'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'expired'
  | 'conflict'
  | 'published'

export const PROMOTION_CANDIDATE_STATES: readonly PromotionCandidateState[] = Object.freeze([
  'proposed', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'expired', 'conflict', 'published',
])

/** Frozen transitions (§6.1); published is terminal. */
const TRANSITIONS: Record<PromotionCandidateState, readonly PromotionCandidateState[]> = {
  proposed: Object.freeze(['changes_requested', 'approved', 'rejected', 'withdrawn', 'expired', 'conflict', 'published']),
  changes_requested: Object.freeze(['proposed', 'rejected', 'withdrawn', 'expired']),
  approved: Object.freeze(['rejected', 'withdrawn', 'expired', 'published']),
  rejected: Object.freeze([]),
  withdrawn: Object.freeze([]),
  expired: Object.freeze([]),
  conflict: Object.freeze(['approved', 'rejected', 'withdrawn', 'expired']),
  published: [],
}

const ALLOWED_CANDIDATE_TRANSITIONS: Record<PromotionCandidateState, readonly PromotionCandidateState[]> = Object.freeze(TRANSITIONS)

export function canTransitionCandidate(
  from: PromotionCandidateState,
  to: PromotionCandidateState,
): boolean {
  return (ALLOWED_CANDIDATE_TRANSITIONS[from] ?? []).includes(to)
}

export type ReviewDecisionKind = 'approve' | 'request_changes' | 'reject'

export type SharedAuthority =
  | 'team_reviewed'
  | 'team_published'
  | 'organization_reviewed'
  | 'organization_published'

/** Review Policy V1 document (§6.2). Fields are exactly these. */
export interface ReviewPolicyDocument {
  schema_version: 1
  minimum_approvals: number
  require_independent_reviewer: boolean
  require_publisher: boolean
  publisher_may_count_as_reviewer: boolean
  allow_self_publish: boolean
  candidate_ttl_days: number
  max_shared_evidence: number
  retention_days_after_revoke: number
  allow_parallel_conflicts: boolean
}

export interface PromotionCandidateRow {
  candidate_id: string
  target_installation_id: string
  source_installation_id: string
  source_scope_kind: 'personal' | 'team'
  source_claim_id: string
  source_version_id: string
  source_content_hash: string
  target_claim_type: string
  scope_kind: string
  scope_key: string
  normalized_key: string
  state: PromotionCandidateState
  conflict_group_id: string | null
  duplicate_of_claim_id: string | null
  expires_at: Date
  revision: number
  created_by_membership_id: string | null
  created_at: Date
  updated_at: Date
}

export interface PromotionCandidateVersionRow {
  candidate_revision_id: string
  candidate_id: string
  revision_number: number
  statement: string
  structured_content: Record<string, unknown>
  content_hash: string
  review_policy_version_id: string
  parent_review_policy_version_id: string | null
  created_by_membership_id: string | null
  created_at: Date
}

export interface ReviewDecisionRow {
  decision_id: string
  candidate_revision_id: string
  membership_id: string
  membership_revision: number
  decision: ReviewDecisionKind
  reason_code: string | null
  created_at: Date
}

export interface AuthorityRecordRow {
  authority_id: string
  installation_id: string
  version_id: string
  candidate_revision_id: string
  review_policy_version_id: string
  parent_review_policy_version_id: string | null
  counted_decision_ids: string[]
  publisher_membership_id: string | null
  source_scope_kind: string
  source_content_hash: string
  published_at: Date
}
