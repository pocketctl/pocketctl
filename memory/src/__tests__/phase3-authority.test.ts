import { describe, expect, test } from 'vitest'

import { currentReviewDecisions } from '../governance/authority.js'

describe('publication decision fences', () => {
  test('counts only decisions whose membership revision and review role are still current', () => {
    const decisions = [
      { decisionId: 'd1', membershipId: 'm1', membershipRevision: '2', decision: 'approve' as const },
      { decisionId: 'd2', membershipId: 'm2', membershipRevision: '1', decision: 'approve' as const },
      { decisionId: 'd3', membershipId: 'm3', membershipRevision: '4', decision: 'approve' as const },
    ]
    const current = currentReviewDecisions(decisions, [
      { membershipId: 'm1', membershipRevision: '3', state: 'active', roles: ['reviewer'] },
      { membershipId: 'm2', membershipRevision: '1', state: 'active', roles: ['reader'] },
      { membershipId: 'm3', membershipRevision: '4', state: 'active', roles: ['scope_administrator'] },
    ])

    expect(current).toEqual([{ decisionId: 'd3', membershipId: 'm3', decision: 'approve' }])
  })

  test('does not collapse distinct large membership revisions', () => {
    const current = currentReviewDecisions([{
      decisionId: 'stale', membershipId: 'm1',
      membershipRevision: '9007199254740992', decision: 'approve',
    }], [{
      membershipId: 'm1', membershipRevision: '9007199254740993',
      state: 'active', roles: ['reviewer'],
    }])
    expect(current).toEqual([])
  })
})

import {evaluateQuorum} from '../governance/authority.js'
import {DEFAULT_TEAM_REVIEW_POLICY,DEFAULT_ORGANIZATION_REVIEW_POLICY} from '../governance/review-policy.js'
describe('quorum policy enforcement',()=>{
 test('excludes actual publisher approval when policy forbids publisher counting',()=>{
  const result=evaluateQuorum({decisions:[{membershipId:'publisher',decision:'approve'}],policy:{...DEFAULT_TEAM_REVIEW_POLICY,publisher_may_count_as_reviewer:false},proposerMembershipId:'author',publisherMembershipId:'publisher'})
  expect(result.ok).toBe(false);expect(result.countedDecisionMemberships).toEqual([])
 })
 test('another publisher-role reviewer may count because they are not the publishing actor',()=>{
  const result=evaluateQuorum({decisions:[{membershipId:'other-publisher',decision:'approve'}],policy:{...DEFAULT_TEAM_REVIEW_POLICY,publisher_may_count_as_reviewer:false},proposerMembershipId:'author',publisherMembershipId:'publisher'})
  expect(result.ok).toBe(true);expect(result.countedDecisionMemberships).toEqual(['other-publisher'])
 })
 test('duplicate approvals from one reviewer cannot meet organization quorum',()=>{
  const result=evaluateQuorum({decisions:[{membershipId:'reviewer',decision:'approve'},{membershipId:'reviewer',decision:'approve'}],policy:DEFAULT_ORGANIZATION_REVIEW_POLICY,proposerMembershipId:'author',publisherMembershipId:'publisher'})
  expect(result.ok).toBe(false)
 })
})
