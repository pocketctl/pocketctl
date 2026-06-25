import { describe, test, expect, beforeEach } from 'vitest'
import { formatRelativeTime } from '../useRelativeTime'
import { useLocale } from '../useLocale'

// formatRelativeTime is locale-aware. Pin to zh so the expected Chinese
// strings stay stable regardless of the test runner's navigator.language.
beforeEach(() => {
  useLocale().setLocale('zh')
})

describe('formatRelativeTime', () => {
  test('returns empty string for null', () => {
    expect(formatRelativeTime(null)).toBe('')
  })

  test('returns empty string for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('')
  })

  test('returns empty string for invalid date string', () => {
    expect(formatRelativeTime('not-a-date')).toBe('')
  })

  test('returns "刚刚" for less than 1 minute ago', () => {
    const now = new Date()
    expect(formatRelativeTime(now)).toBe('刚刚')
    // 30 seconds ago
    expect(formatRelativeTime(new Date(Date.now() - 30_000))).toBe('刚刚')
  })

  test('returns "1分钟前" for 1 minute ago', () => {
    const oneMinAgo = new Date(Date.now() - 60_000)
    expect(formatRelativeTime(oneMinAgo)).toBe('1分钟前')
  })

  test('returns "5分钟前" for 5 minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000)
    expect(formatRelativeTime(fiveMinAgo)).toBe('5分钟前')
  })

  test('returns "59分钟前" for 59 minutes ago', () => {
    const fiftyNineMinAgo = new Date(Date.now() - 59 * 60_000)
    expect(formatRelativeTime(fiftyNineMinAgo)).toBe('59分钟前')
  })

  test('returns "1小时前" for 1 hour ago', () => {
    const oneHourAgo = new Date(Date.now() - 3600_000)
    expect(formatRelativeTime(oneHourAgo)).toBe('1小时前')
  })

  test('returns "23小时前" for 23 hours ago', () => {
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 3600_000)
    expect(formatRelativeTime(twentyThreeHoursAgo)).toBe('23小时前')
  })

  test('returns "MM-DD HH:mm" format for more than 24 hours ago', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000)
    const result = formatRelativeTime(twoDaysAgo)
    // Should match pattern "MM-DD HH:mm"
    expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  test('handles Date object input', () => {
    const justNow = new Date()
    expect(formatRelativeTime(justNow)).toBe('刚刚')
  })

  test('handles ISO string input', () => {
    const justNow = new Date().toISOString()
    expect(formatRelativeTime(justNow)).toBe('刚刚')
  })
})
