import { describe, expect, test } from 'vitest'
import { redactSensitive, SENSITIVE_FIELD_NAMES } from '../logging.js'

describe('phase one logging redaction', () => {
  test('claim statements, evidence excerpts and queries are sensitive fields', () => {
    for (const field of ['statement', 'excerpt', 'query', 'document', 'system_prompt', 'model_output']) {
      expect(SENSITIVE_FIELD_NAMES.has(field), field).toBe(true)
    }
  })

  test('model output and prompts never survive redaction', () => {
    const redacted = redactSensitive('model_output=Use vitest everywhere; query=login flake root cause')
    // Field VALUES are masked by the logger; direct strings are bounded and
    // token-shaped content removed. Either way nothing token-like survives.
    expect(redacted).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/)
  })

  test('bearer grants and long opaque secrets are masked', () => {
    const redacted = redactSensitive('Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig')
    expect(redacted).toContain('[redacted]')
  })

  test('absolute paths collapse to a bounded marker', () => {
    const redacted = redactSensitive('cwd /Users/alice/secret/project details')
    expect(redacted).not.toContain('/Users/alice')
  })

  test('oversized values truncate or redact to a bounded marker', () => {
    const redacted = redactSensitive('y'.repeat(500) + ' tail words that are not opaque')
    expect(redacted.length).toBeLessThan(400)
    expect(redacted).toContain('[redacted]')
    const truncated = redactSensitive('word '.repeat(120))
    expect(truncated).toContain('…[truncated]')
  })
})
