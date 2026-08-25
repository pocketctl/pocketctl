import { describe, expect, test } from 'vitest'
import { fuseRanks, RRF_K } from '../retrieval/rrf.js'

describe('reciprocal rank fusion', () => {
  test('single pools keep their order with RRF scores', () => {
    const fused = fuseRanks([
      { name: 'lexical', ranked: ['a', 'b', 'c'] },
    ], 10)
    expect(fused.map(entry => entry.versionId)).toEqual(['a', 'b', 'c'])
    expect(fused[0].score).toBeCloseTo(1 / RRF_K, 12)
    expect(fused[1].score).toBeCloseTo(1 / (RRF_K + 1), 12)
  })

  test('agreement across pools outranks single-pool hits', () => {
    const fused = fuseRanks([
      { name: 'lexical', ranked: ['x', 'a', 'b'] },
      { name: 'vector', ranked: ['a', 'b', 'x'] },
    ], 10)
    const a = fused.find(entry => entry.versionId === 'a')!
    const x = fused.find(entry => entry.versionId === 'x')!
    expect(a.score).toBeGreaterThan(x.score)
    expect(a.sources.sort()).toEqual(['lexical', 'vector'])
    expect(fused[0].versionId).toBe('a')
  })

  test('ties break deterministically by version id', () => {
    const first = fuseRanks([
      { name: 'p', ranked: ['zz', 'aa'] },
      { name: 'q', ranked: ['aa', 'zz'] },
    ], 10)
    const second = fuseRanks([
      { name: 'p', ranked: ['zz', 'aa'] },
      { name: 'q', ranked: ['aa', 'zz'] },
    ], 10)
    expect(first.map(entry => entry.versionId)).toEqual(['aa', 'zz'])
    expect(second.map(entry => entry.versionId)).toEqual(['aa', 'zz'])
  })

  test('empty pools and zero limits are safe', () => {
    expect(fuseRanks([], 10)).toEqual([])
    expect(fuseRanks([{ name: 'p', ranked: ['a'] }], 0)).toEqual([])
  })

  test('the limit truncates after deterministic ordering', () => {
    const fused = fuseRanks([{ name: 'p', ranked: ['a', 'b', 'c'] }], 2)
    expect(fused.map(entry => entry.versionId)).toEqual(['a', 'b'])
  })
})
