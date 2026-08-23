import { describe, expect, test } from 'vitest'
import { contentDigest } from '../contentDigest'

describe('contentDigest', () => {
  test('returns the lowercase first 16 SHA-256 bytes for ASCII', async () => {
    expect(await contentDigest('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e')
  })

  test('hashes UTF-8 bytes for multi-byte text', async () => {
    expect(await contentDigest('你好')).toBe('670d9743542cae3ea7ebe36af56bd536')
  })
})
