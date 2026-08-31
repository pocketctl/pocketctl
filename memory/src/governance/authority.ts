import type { ReviewPolicyDocument, ReviewDecisionKind } from './types.js'

/**
 * ADR-P3-07 publication quorum. Pure and deterministic: given the decisions
 * bound to the CURRENT candidate revision (already filtered to memberships
 * still active at their bound revision by the caller), the effective review
 * policy, the proposer, and the publishing actor, decide whether publication
 * may proceed. No model call, no ordering heuristics.
 */

export interface QuorumDecisionInput {
  membershipId: string
  decision: ReviewDecisionKind
}

export interface BoundReviewDecision extends QuorumDecisionInput {
  decisionId: string
  membershipRevision: string
}

export interface CurrentMembershipFact {
  membershipId: string
  membershipRevision: string
  state: string
  roles: string[]
}

/** Revalidate a stored decision against the exact current membership fence. */
export function currentReviewDecisions(
  decisions: readonly BoundReviewDecision[],
  memberships: readonly CurrentMembershipFact[],
): Array<{ decisionId: string; membershipId: string; decision: ReviewDecisionKind }> {
  const current = new Map(memberships.map(membership => [membership.membershipId, membership]))
  return decisions.flatMap(decision => {
    const membership = current.get(decision.membershipId)
    const canReview = membership?.roles.some(role =>
      role === 'reviewer' || role === 'publisher' || role === 'scope_administrator') === true
    if (!membership || membership.state !== 'active' || !canReview
      || membership.membershipRevision !== decision.membershipRevision) return []
    return [{
      decisionId: decision.decisionId,
      membershipId: decision.membershipId,
      decision: decision.decision,
    }]
  })
}

export interface QuorumEvaluation {
  ok: boolean
  /** Machine-checkable failure reason for audit and API errors. */
  reason:
    | 'ok'
    | 'insufficient_approvals'
    | 'missing_independent_reviewer'
    | 'pending_change_request'
    | 'rejected'
  countedDecisionMemberships: string[]
}

export function evaluateQuorum(input: {
  decisions: QuorumDecisionInput[]
  policy: ReviewPolicyDocument
  proposerMembershipId: string | null
  publisherMembershipId: string
}): QuorumEvaluation {
  const { decisions, policy } = input

  if (decisions.some(decision => decision.decision === 'reject')) {
    return { ok: false, reason: 'rejected', countedDecisionMemberships: [] }
  }
  if (decisions.some(decision => decision.decision === 'request_changes')) {
    return { ok: false, reason: 'pending_change_request', countedDecisionMemberships: [] }
  }

  const approvals = decisions.filter(decision => decision.decision === 'approve')
  const counted = approvals.map(approval => approval.membershipId)

  if (policy.require_independent_reviewer) {
    const independent = approvals.some(
      approval => approval.membershipId !== input.proposerMembershipId)
    if (!independent) {
      return { ok: false, reason: 'missing_independent_reviewer', countedDecisionMemberships: [] }
    }
  }
  if (input.proposerMembershipId === input.publisherMembershipId
    && !policy.allow_self_publish) {
    // The publisher being the proposer is fine — publishing WITHOUT anyone
    // else's approval is not. The independent-reviewer check above already
    // guarantees at least one other approval when required; when it is not
    // required the floor still forbids zero-review self-publish.
    if (approvals.every(approval => approval.membershipId === input.proposerMembershipId)) {
      return { ok: false, reason: 'missing_independent_reviewer', countedDecisionMemberships: [] }
    }
  }
  if (counted.length < policy.minimum_approvals) {
    return { ok: false, reason: 'insufficient_approvals', countedDecisionMemberships: counted }
  }
  return { ok: true, reason: 'ok', countedDecisionMemberships: counted }
}
