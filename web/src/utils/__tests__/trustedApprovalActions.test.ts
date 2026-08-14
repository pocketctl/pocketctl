import { describe, expect, test } from 'vitest'

import { trustedApprovalActions } from '../trustedApprovalActions'

describe('trusted approval action rendering', () => {
  test('intersects native decisions with a valid enforced context', () => {
    expect(trustedApprovalActions({
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      securityContext: {
        schema_version: 1, risk_level: 'low', classification_incomplete: false,
        risk_reasons: ['executes_command'], allowed_actions: ['once', 'always', 'cancel'],
      },
    }, false, true)).toEqual(['once', 'always', 'cancel'])
  })

  test('removes persistent approval for legacy and malformed contexts', () => {
    const message = {
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
      securityContext: { schema_version: 1, risk_level: 'low', allowed_actions: ['always'] },
    }
    expect(trustedApprovalActions(message, false, false)).toEqual(['once', 'reject'])
    expect(trustedApprovalActions(message, false, true)).toEqual(['once', 'reject'])
  })

  test('reapplies risk policy when an enforced context advertises always too broadly', () => {
    expect(trustedApprovalActions({
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
      securityContext: {
        schema_version: 1, risk_level: 'high', classification_incomplete: false,
        risk_reasons: ['executes_command'], allowed_actions: ['once', 'always', 'reject'],
      },
    }, false, true)).toEqual(['once', 'reject'])
  })

  test('preserves Claude one-shot explicit decisions without trusted policy capability', () => {
    expect(trustedApprovalActions({
      approvalKind: 'claude_channel', availableDecisions: ['accept', 'decline'],
    }, false, false)).toEqual(['once', 'reject'])
  })

  test('treats an array risk level as malformed instead of coercing it', () => {
    expect(trustedApprovalActions({
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
      securityContext: {
        schema_version: 1,
        risk_level: ['low'],
        classification_incomplete: false,
        risk_reasons: [],
        allowed_actions: ['once', 'always', 'reject'],
      },
    }, false, true)).toEqual(['once', 'reject'])
  })
})
