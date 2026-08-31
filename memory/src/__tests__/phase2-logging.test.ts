import { describe, expect, test } from 'vitest'
import { redactSensitive } from '../logging.js'

/**
 * Phase 2 logging boundary (plan 12.1): the redaction layer strips query
 * and pack markers, grants and high-entropy tokens from anything that
 * could reach a log line.
 */
describe('phase two logging redaction', () => {
  test('strips pack envelopes and grant prefixes', () => {
    const line = redactSensitive('compile failed grant=eyJhbGciOiJSUzI1NiJ9.pack.part highentropyabcdef1234567890abcdef1234567890')
    expect(line).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    expect(line).not.toContain('highentropyabcdef1234567890abcdef1234567890')
  })

  test('keeps bounded error codes readable', () => {
    const line = redactSensitive('context compile outcome=retrieval_failed error=http_error')
    expect(line).toContain('retrieval_failed')
  })
})
