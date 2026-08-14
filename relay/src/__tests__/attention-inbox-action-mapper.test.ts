import { describe, expect, test } from 'vitest'

import { mapApprovalActions, mapQuestionActions } from '../attention-inbox/action-mapper.js'

const ids = (actions: ReturnType<typeof mapApprovalActions>) => actions.map((action) => action.id)

describe('Attention Inbox approval action mapping', () => {
  test('maps Codex native decisions and removes persistent scope under incomplete classification', () => {
    expect(ids(mapApprovalActions({
      provider: 'codex',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      classificationIncomplete: true,
    }))).toEqual(['once', 'reject', 'cancel'])
  })

  test('retains Codex session scope only for a complete low-risk classification', () => {
    expect(ids(mapApprovalActions({
      provider: 'codex',
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
      riskLevel: 'low',
      classificationIncomplete: false,
      enforcedAllowedActions: ['once', 'always', 'reject'],
    }))).toEqual(['once', 'always', 'reject'])
  })

  test('offers OpenCode always only for a managed request with explicit save rules', () => {
    expect(ids(mapApprovalActions({
      provider: 'opencode',
      controlMode: 'managed',
      alwaysRules: ['git status'],
      riskLevel: 'medium',
      classificationIncomplete: false,
      enforcedAllowedActions: ['once', 'always', 'reject'],
    }))).toEqual(['once', 'always', 'reject'])

    expect(ids(mapApprovalActions({
      provider: 'opencode',
      controlMode: 'managed',
      alwaysRules: [],
      riskLevel: 'medium',
      classificationIncomplete: false,
      enforcedAllowedActions: ['once', 'always', 'reject'],
    }))).toEqual(['once', 'reject'])
  })

  test('never expands daemon-advertised actions and never trusts legacy complete-low fields for persistence', () => {
    expect(ids(mapApprovalActions({
      provider: 'codex',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      riskLevel: 'low',
      classificationIncomplete: false,
      enforcedAllowedActions: ['once', 'cancel'],
    }))).toEqual(['once', 'cancel'])

    expect(ids(mapApprovalActions({
      provider: 'codex',
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
      riskLevel: 'low',
      classificationIncomplete: false,
    }))).toEqual(['once', 'reject'])
  })

  test('does not synthesize actions for unmanaged OpenCode, Claude, or unknown Codex decisions', () => {
    expect(mapApprovalActions({ provider: 'opencode', controlMode: 'legacy_read_only' })).toEqual([])
    expect(mapApprovalActions({ provider: 'claude-code' })).toEqual([])
    expect(mapApprovalActions({ provider: 'codex', availableDecisions: ['futureDecision'] })).toEqual([])
  })

  test('fails question answering closed when the persisted schema is not answerable', () => {
    expect(mapQuestionActions({
      provider: 'codex', questions: [{ question: 'Missing choices', custom: false, options: [] }],
    }).map((action) => action.id)).toEqual(['reject'])
    expect(mapQuestionActions({
      provider: 'codex', questions: [{ question: 'Custom response', custom: true, options: [] }],
    }).map((action) => action.id)).toEqual(['answer', 'reject'])
  })
})
