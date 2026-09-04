import { describe, expect, test } from 'vitest'

/**
 * Phase 2 observability contract (plan 12.1/17): metrics labels and log
 * lines never carry query text, prompt/pack content, version/evidence
 * content, session or path ids, grants/nonces, policy documents, or
 * high-cardinality values. This suite pins the label vocabulary.
 */

const FORBIDDEN_LABEL_VALUES = [
  'how does auth work',            // query text
  '<pocketctl_memory_context',     // pack envelope
  'grant-eyJ',                     // grant prefix
  'nonce-',                        // nonce prefix
  '/Users/',                       // path prefix
  'stable_text',                   // pack column name as a value
]

describe('phase two metric label vocabulary', () => {
  test('bounded context outcome codes are the only allowed label values', async () => {
    const { PHASE2_CONTEXT_OUTCOMES } = await import('../context/outcomes.js')
    expect(PHASE2_CONTEXT_OUTCOMES).toEqual([
      'off', 'shadow_queued', 'ready', 'empty', 'degraded',
      'unsupported_adapter', 'retrieval_failed', 'admission_failed',
      'admission_existing', 'grant_unavailable', 'deadline',
    ])
    // Every label is low-cardinality: bounded enum, no free text.
    for (const label of PHASE2_CONTEXT_OUTCOMES) {
      expect(label.length).toBeLessThanOrEqual(32)
      expect(label).toMatch(/^[a-z_]+$/)
    }
  })

  test('bounded admission and delivery codes', async () => {
    const { PHASE2_ADMISSION_CODES, PHASE2_DELIVERY_CODES } = await import('../context/outcomes.js')
    expect(PHASE2_ADMISSION_CODES.every(code => code.length <= 24)).toBe(true)
    expect(PHASE2_DELIVERY_CODES).toEqual(['delivered', 'delivery_failed', 'expired', 'skipped'])
  })

  test('label values never contain forbidden content classes', async () => {
    const { PHASE2_CONTEXT_OUTCOMES, PHASE2_ADMISSION_CODES, PHASE2_DELIVERY_CODES } =
      await import('../context/outcomes.js')
    const all = [...PHASE2_CONTEXT_OUTCOMES, ...PHASE2_ADMISSION_CODES, ...PHASE2_DELIVERY_CODES]
    for (const label of all) {
      for (const forbidden of FORBIDDEN_LABEL_VALUES) {
        expect(label).not.toContain(forbidden)
      }
    }
  })
})
