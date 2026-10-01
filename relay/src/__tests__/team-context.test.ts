import { describe, expect, test } from 'vitest'

import { buildTeamContextStableText, TEAM_CONTEXT_INPUT_BUDGET_BYTES } from '../team/context-delivery.js'

describe('Team context delivery', () => {
  test('keeps priority fields and newest evidence within the UTF-8 budget', () => {
    const result = buildTeamContextStableText({
      goal: 'Ship safely',
      consensus: ['Use explicit capabilities'],
      openQuestions: ['Is the provider ready?'],
      references: [{ source_kind: 'team_event', source_id: 'event-1', source_version: '3' }],
      history: [
        { event_seq: 9, kind: 'member_message', content: 'newest evidence' },
        { event_seq: 8, kind: 'agent_message', content: 'older evidence' },
      ],
    })
    expect(result.truncated).toBe(false)
    expect(result.stableText).toContain('Goal: Ship safely')
    expect(result.stableText.indexOf('History #9')).toBeLessThan(result.stableText.indexOf('History #8'))
    expect(Buffer.byteLength(result.stableText, 'utf8')).toBeLessThanOrEqual(TEAM_CONTEXT_INPUT_BUDGET_BYTES)
  })

  test('truncates deterministically without splitting UTF-8', () => {
    const input = {
      goal: '目标'.repeat(200), consensus: ['共识'.repeat(200)], openQuestions: [], references: [],
      history: [{ event_seq: 2, kind: 'member_message', content: '证据'.repeat(200) }],
    }
    const first = buildTeamContextStableText(input, 256)
    const second = buildTeamContextStableText(input, 256)
    expect(first).toEqual(second)
    expect(first.truncated).toBe(true)
    expect(Buffer.byteLength(first.stableText, 'utf8')).toBeLessThanOrEqual(256)
    expect(first.stableText).not.toContain('\uFFFD')
  })
})
