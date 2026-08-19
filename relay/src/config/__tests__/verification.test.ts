import { describe, expect, test, vi } from 'vitest'
import {
  CODE_HMAC_LENGTH,
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  MAX_VERIFY_ATTEMPTS,
  SEND_COOLDOWN_MS,
  challengeKey,
  codeHmac,
  generateCode,
} from '../verification.js'

describe('generateCode', () => {
  test('uses a CSPRNG: mocking Math.random must not force predictable codes', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const codes = new Set<string>()
      for (let i = 0; i < 50; i++) codes.add(generateCode())
      // With Math.random pinned to 0 the legacy implementation always returned
      // 100000; a CSPRNG keeps producing the full range and never collapses.
      expect(codes.size).toBeGreaterThan(1)
      expect(codes.has('100000')).toBe(false)
      for (const code of codes) expect(code).toMatch(/^\d{6}$/)
    } finally {
      randomSpy.mockRestore()
    }
  })

  test('always returns a 6-digit decimal string in the documented range', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode()
      expect(code).toMatch(/^\d{6}$/)
      expect(Number(code)).toBeGreaterThanOrEqual(100000)
      expect(Number(code)).toBeLessThan(1000000)
    }
  })
})

describe('codeHmac', () => {
  const pepper = 'unit-test-pepper-0123456789abcdef-0123'

  test('never stores or returns the plaintext code', () => {
    const digest = codeHmac('123456', pepper)
    expect(digest).not.toContain('123456')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).toHaveLength(CODE_HMAC_LENGTH)
  })

  test('is deterministic for the same code and pepper', () => {
    expect(codeHmac('654321', pepper)).toBe(codeHmac('654321', pepper))
  })

  test('differs across codes and peppers', () => {
    expect(codeHmac('654321', pepper)).not.toBe(codeHmac('654322', pepper))
    expect(codeHmac('654321', pepper)).not.toBe(codeHmac('654321', 'other-pepper'))
  })
})

describe('challengeKey', () => {
  const pepper = 'unit-test-pepper-0123456789abcdef-0123'

  test('is stable for identical purpose/email/user scope', () => {
    expect(challengeKey(pepper, 'login', 'user@example.test', null))
      .toBe(challengeKey(pepper, 'login', 'user@example.test', null))
    expect(challengeKey(pepper, 'bind_email', 'user@example.test', 7))
      .toBe(challengeKey(pepper, 'bind_email', 'user@example.test', 7))
  })

  test('never embeds the raw email and is hex', () => {
    const key = challengeKey(pepper, 'login', 'user@example.test', null)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('user@example.test')
  })

  test('separates purpose and user scope', () => {
    const email = 'user@example.test'
    expect(challengeKey(pepper, 'login', email, null))
      .not.toBe(challengeKey(pepper, 'bind_email', email, null))
    expect(challengeKey(pepper, 'bind_email', email, 1))
      .not.toBe(challengeKey(pepper, 'bind_email', email, 2))
  })
})

describe('challenge policy constants', () => {
  test('lockout and cooldown constants match the security invariants', () => {
    expect(MAX_VERIFY_ATTEMPTS).toBe(5)
    expect(SEND_COOLDOWN_MS).toBe(60_000)
    expect(FAILURE_WINDOW_MS).toBe(15 * 60_000)
    expect(LOCKOUT_MS).toBe(15 * 60_000)
  })
})
