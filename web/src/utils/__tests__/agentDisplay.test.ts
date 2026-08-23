import { describe, test, expect } from 'vitest'
import { AGENT_DISPLAY_NAMES, agentDisplayName, agentShortLabel, agentIconClass, isZcodeAgent } from '../agentDisplay.js'

describe('agentDisplay', () => {
  test('display name maps zcode and existing agents', () => {
    expect(agentDisplayName('zcode')).toBe('ZCode')
    expect(agentDisplayName('claude-code')).toBe('Claude Code')
    expect(agentDisplayName('codex')).toBe('Codex')
    expect(agentDisplayName('opencode')).toBe('OpenCode')
    expect(agentDisplayName('unknown')).toBe('unknown')
  })

  test('short label for zcode is ZC; existing agents unchanged', () => {
    expect(agentShortLabel('zcode')).toBe('ZC')
    expect(agentShortLabel('codex')).toBe('Cx')
    expect(agentShortLabel('opencode')).toBe('OC')
    expect(agentShortLabel('claude-code')).toBe('CC')
  })

  test('icon class for zcode is zcode; codex/opencode unchanged', () => {
    expect(agentIconClass('zcode')).toBe('zcode')
    expect(agentIconClass('codex')).toBe('codex')
    // opencode falls back to claude icon class (pre-existing behavior, unchanged)
    expect(agentIconClass('opencode')).toBe('claude')
    expect(agentIconClass('claude-code')).toBe('claude')
  })

  test('isZcodeAgent only true for zcode', () => {
    expect(isZcodeAgent('zcode')).toBe(true)
    expect(isZcodeAgent('claude-code')).toBe(false)
    expect(isZcodeAgent('')).toBe(false)
  })

  test('AGENT_DISPLAY_NAMES has exactly the four agents', () => {
    expect(Object.keys(AGENT_DISPLAY_NAMES).sort()).toEqual(['claude-code', 'codex', 'opencode', 'zcode'])
  })
})
