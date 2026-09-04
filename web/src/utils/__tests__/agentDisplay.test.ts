import { describe, test, expect } from 'vitest'
import { AGENT_DISPLAY_NAMES, agentDisplayName, agentShortLabel, agentIconClass } from '../agentDisplay.js'

describe('agentDisplay', () => {
  test('uses distinct public names for Codex CLI and Codex Desktop', () => {
    expect(agentDisplayName('zcode')).toBe('ZCode')
    expect(agentDisplayName('claude-code')).toBe('Claude Code')
    expect(agentDisplayName('codex')).toBe('Codex CLI')
    expect(agentDisplayName('codex-desktop')).toBe('Codex Desktop')
    expect(agentDisplayName('opencode')).toBe('OpenCode')
    expect(agentDisplayName('unknown')).toBe('unknown')
  })

  test('gives Codex Desktop a distinct short label in the Codex visual family', () => {
    expect(agentShortLabel('zcode')).toBe('ZC')
    expect(agentShortLabel('codex')).toBe('Cx')
    expect(agentShortLabel('codex-desktop')).toBe('CD')
    expect(agentShortLabel('opencode')).toBe('OC')
    expect(agentShortLabel('claude-code')).toBe('CC')
    expect(agentIconClass('zcode')).toBe('zcode')
    expect(agentIconClass('codex')).toBe('codex')
    expect(agentIconClass('codex-desktop')).toBe('codex-desktop')
    // opencode falls back to claude icon class (pre-existing behavior, unchanged)
    expect(agentIconClass('opencode')).toBe('claude')
    expect(agentIconClass('claude-code')).toBe('claude')
  })

  test('publishes all five supported agent display names', () => {
    expect(Object.keys(AGENT_DISPLAY_NAMES).sort()).toEqual(['claude-code', 'codex', 'codex-desktop', 'opencode', 'zcode'])
  })
})
