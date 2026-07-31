import { describe, expect, test } from 'vitest'
import { childAgentTokenTotal, formatTokenCount } from '../tokenFormat'

describe('formatTokenCount', () => {
  test.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1500, '2K'],
    [999_999, '1.0M'],
    [1_000_000, '1.0M'],
    [999_999_999, '1.0G'],
    [1_000_000_000, '1.0G'],
    [999_999_999_999, '1.0T'],
    [1_000_000_000_000, '1.0T'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatTokenCount(value)).toBe(expected)
  })

  test.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'renders invalid value %s as an em dash',
    (value) => {
      expect(formatTokenCount(value)).toBe('—')
    },
  )
})

describe('childAgentTokenTotal', () => {
  test('adds input, output, cache read and cache create tokens', () => {
    expect(childAgentTokenTotal({
      tokenIn: 100,
      tokenOut: 200,
      tokenCache: 50,
      tokenCacheCreate: 30,
    })).toBe(380)
  })

  test('treats missing token fields as zero', () => {
    expect(childAgentTokenTotal({ tokenIn: 100 })).toBe(100)
  })

  test('adds BIGINT fields returned as strings instead of concatenating them', () => {
    expect(childAgentTokenTotal({
      tokenIn: '362479',
      tokenOut: '3973',
      tokenCache: '323584',
      tokenCacheCreate: '0',
    })).toBe(690_036)
  })
})
