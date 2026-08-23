import { describe, expect, test } from 'vitest'
import { normalizeEffort, shouldShowEffort } from '../../utils/effort'

describe('session effort display', () => {
  test('normalizes effort keys while preserving a future value', () => {
    expect(normalizeEffort(' HIGH ')).toBe('high')
    expect(normalizeEffort('experimental')).toBe('experimental')
  })

  test('is hidden for empty and unsupported-agent values', () => {
    expect(shouldShowEffort('codex', '')).toBe(false)
    expect(shouldShowEffort('opencode', 'high')).toBe(false)
    expect(shouldShowEffort('claude-code', 'high')).toBe(true)
  })
})
