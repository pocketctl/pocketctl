import { describe, expect, test } from 'vitest'
import {
  isCreateCapableAgentType,
  isObserverAgentType,
} from '../session-observer-policy.js'

describe('session agent protocol policy', () => {
  test.each([
    ['claude-code', true],
    ['codex', true],
    ['opencode', true],
    ['', false],
    ['zcode', false],
    ['codex-desktop', false],
    ['Codex', false],
    ['codex-preview', false],
    ['future-agent', false],
  ] as const)('requires exact create opt-in for %j', (agent, expected) => {
    expect(isCreateCapableAgentType(agent)).toBe(expected)
  })

  test.each(['zcode', 'codex-desktop'])('keeps observer code for %s', (agent) => {
    expect(isObserverAgentType(agent)).toBe(true)
    expect(isCreateCapableAgentType(agent)).toBe(false)
  })
})
