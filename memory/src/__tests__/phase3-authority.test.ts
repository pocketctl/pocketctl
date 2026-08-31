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
