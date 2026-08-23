import { describe, expect, test } from 'vitest'
import { hasSessionSearchQuery, matchesSessionSearch } from '../sessionSearch'

describe('sessionSearch', () => {
  test('matches title, model and agent with iOS separator normalization', () => {
    const session = {
      title: 'Alpha Local Session',
      model: 'claude-sonnet-4',
      agent: 'claude-code',
    }

    expect(matchesSessionSearch(session, 'alpha local')).toBe(true)
    expect(matchesSessionSearch(session, 'claude sonnet')).toBe(true)
    expect(matchesSessionSearch(session, 'CLAUDE/CODE')).toBe(true)
    expect(matchesSessionSearch(session, 'session-identifier')).toBe(false)
  })

  test('treats whitespace-only input as no active query', () => {
    expect(hasSessionSearchQuery('  \n ')).toBe(false)
    expect(hasSessionSearchQuery('codex')).toBe(true)
  })
})
