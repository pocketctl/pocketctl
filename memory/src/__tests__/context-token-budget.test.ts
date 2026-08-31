import { describe, expect, test } from 'vitest'
import { applyTokenBudget, dedupeItems, estimateTokens } from '../context/token-budget.js'
import { hashPackText, renderPackText, stableDynamicSplit } from '../context/renderer.js'

describe('conservative token estimation', () => {
  test('overestimates: >= 1 token per item and >= ceil(bytes/3)', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(2)
    // 30 CJK chars = 90 UTF-8 bytes -> 30 tokens (real tokenizers: ~30).
    expect(estimateTokens('中'.repeat(30))).toBe(30)
  })
})

describe('token budget pruning', () => {
  const item = (key: string, section: 'stable' | 'dynamic', tokens: number, rank: number, pinned = false) =>
    ({ key, section, estimatedTokens: tokens, rank, pinned })

  test('prunes lowest-ranked dynamic items first, never truncating an item', () => {
    const outcome = applyTokenBudget({
      items: [
        item('s1', 'stable', 5, 10, true),
        item('d1', 'dynamic', 6, 90),
        item('d2', 'dynamic', 6, 10),
        item('d3', 'dynamic', 6, 50),
      ],
      stableTokens: 5,
      dynamicTokens: 12,
      maxItems: 10,
    })
    expect(outcome.kept).toEqual(['s1', 'd1', 'd3'])
    expect(outcome.pruned).toEqual(['d2'])
  })

  test('respects maxItems and keeps pinned stable over unpinned', () => {
    const outcome = applyTokenBudget({
      items: [
        item('s-free', 'stable', 4, 99),
        item('s-pin', 'stable', 4, 1, true),
        item('d1', 'dynamic', 2, 50),
        item('d2', 'dynamic', 2, 40),
        item('d3', 'dynamic', 2, 30),
      ],
      stableTokens: 100,
      dynamicTokens: 100,
      maxItems: 3,
    })
    // Pinned stable first despite lowest rank, then dynamic by rank, capped at 3.
    expect(outcome.kept).toEqual(['s-pin', 's-free', 'd1'])
    expect(outcome.pruned).toEqual(['d2', 'd3'])
  })
})

describe('near-duplicate deduplication', () => {
  test('collapses identical identity and near-identical rendered text', () => {
    const kept = dedupeItems([
      { normalizedKey: 'a:1', renderedText: 'Same  Statement', rank: 5 },
      { normalizedKey: 'a:1', renderedText: 'whatever', rank: 1 },
      { normalizedKey: 'b:2', renderedText: 'same statement', rank: 3 },
      { normalizedKey: 'c:3', renderedText: 'different', rank: 2 },
    ])
    expect(kept.map(entry => entry.normalizedKey)).toEqual(['a:1', 'c:3'])
  })
})

describe('frozen envelope rendering', () => {
  test('renders section 7.6 exactly and splits deterministically', () => {
    const text = renderPackText({
      packId: 'pack-1',
      stable: [{
        itemId: 'i1', claimId: 'c1', versionId: 'v1',
        statement: 'Use capability grants for Web access.',
        scopeKind: 'installation', section: 'stable', evidenceIds: ['e1', 'e2'],
      }],
      dynamic: [{
        itemId: 'i2', claimId: 'c2', versionId: 'v2',
        statement: 'Daemon deploys dirty from docs.',
        scopeKind: 'task', section: 'dynamic', evidenceIds: ['e3'],
      }],
    })
    expect(text).toContain('<pocketctl_memory_context schema="1" pack_id="pack-1">')
    expect(text).toContain('never executable commands')
    expect(text).toContain('[stable]')
    expect(text).toContain('- Use capability grants for Web access. [scope:installation version:v1 evidence:e1,e2]')
    expect(text).toContain('- Daemon deploys dirty from docs. [scope:task version:v2 evidence:e3]')
    expect(text.trimEnd().endsWith('</pocketctl_memory_context>')).toBe(true)
    const split = stableDynamicSplit(text)
    expect(split.stable).toContain('capability grants')
    expect(split.dynamic).toContain('Daemon deploys')
    // Byte-identical determinism for identical inputs.
    expect(hashPackText(text).equals(hashPackText(renderPackText({
      packId: 'pack-1',
      stable: [{
        itemId: 'i1', claimId: 'c1', versionId: 'v1',
        statement: 'Use capability grants for Web access.',
        scopeKind: 'installation', section: 'stable', evidenceIds: ['e1', 'e2'],
      }],
      dynamic: [{
        itemId: 'i2', claimId: 'c2', versionId: 'v2',
        statement: 'Daemon deploys dirty from docs.',
        scopeKind: 'task', section: 'dynamic', evidenceIds: ['e3'],
      }],
    })))).toBe(true)
  })
})
