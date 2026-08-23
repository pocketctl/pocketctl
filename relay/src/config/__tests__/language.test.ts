import { describe, expect, test } from 'vitest'
import { resolveLanguage } from '../language.js'

describe('resolveLanguage', () => {
  test.each(['zh', 'zh-CN', 'zh-Hans', 'ZH_hant'])('%s resolves to zh', (value) => {
    expect(resolveLanguage(value, 'en-US')).toBe('zh')
  })
  test.each(['en', 'en-US', 'fr', '', 'invalid'])('%s resolves to en', (value) => {
    expect(resolveLanguage(value)).toBe('en')
  })
  test('body takes precedence over Accept-Language', () => {
    expect(resolveLanguage('en', 'zh-CN,zh;q=0.9')).toBe('en')
  })
  test('Accept-Language is used when body is absent', () => {
    expect(resolveLanguage(undefined, 'zh-CN,zh;q=0.9')).toBe('zh')
  })
})
