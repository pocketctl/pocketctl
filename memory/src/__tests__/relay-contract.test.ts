import { describe, expect, test } from 'vitest'
import { EXTENSION_TOPICS } from '../relay/contracts.js'
import { classifyEnvelope, validateFeedBatch } from '../relay/validation.js'

/** Redacted JSON fixture mirroring relay/src/extensions/envelope.ts output. */
function envelopeFixture(overrides: Record<string, unknown> = {}) {
  return {
    envelope_version: 1,
    feed_id: '101',
    topic: 'session.event.v1',
    source: { kind: 'canonical_event', id: 'evt-1', recorded_at: '2026-08-23T00:00:00.000Z' },
    subject: { session_id: 'ses-1', turn_id: 'turn-1', event_type: 'agent_text' },
    classification: { actor_scope: 'agent', content_class: 'assistant_text' },
    data: { type: 'agent_text', session_id: 'ses-1', text: 'redacted' },
    ...overrides,
  }
}

describe('relay envelope contract', () => {
  test('accepts a well-formed v1 envelope', () => {
    const decision = classifyEnvelope(envelopeFixture())
    expect(decision.kind).toBe('accepted')
    if (decision.kind === 'accepted') {
      expect(decision.envelope.feed_id).toBe('101')
      expect(decision.envelope.subject.event_type).toBe('agent_text')
      expect(decision.envelope.classification.actor_scope).toBe('agent')
    }
  })

  test('accepts unknown event types as generic source events (invariant 8)', () => {
    const decision = classifyEnvelope(envelopeFixture({
      subject: { session_id: 'ses-1', event_type: 'brand_new_event_type' },
    }))
    expect(decision.kind).toBe('accepted')
  })

  test('accepts envelopes without a turn or a session', () => {
    const noTurn = classifyEnvelope(envelopeFixture({
      subject: { session_id: 'ses-1', event_type: 'session_created' },
    }))
    expect(noTurn.kind).toBe('accepted')
    const noSession = classifyEnvelope(envelopeFixture({
      subject: { session_id: null, event_type: 'session_status' },
    }))
    expect(noSession.kind).toBe('accepted')
  })

  test('quarantines unsupported envelope versions without touching the body', () => {
    const decision = classifyEnvelope(envelopeFixture({ envelope_version: 2 }))
    expect(decision).toEqual({ kind: 'quarantined', errorCode: 'unsupported_envelope_version' })
  })

  test('quarantines malformed envelopes with a bounded code', () => {
    for (const broken of [
      null,
      'text',
      42,
      {},
      envelopeFixture({ feed_id: 101 }),
      envelopeFixture({ topic: 'memory.candidates.v1' }),
      envelopeFixture({ source: { kind: 'x', id: 'y' } }),
      envelopeFixture({ subject: { session_id: 'ses-1' } }),
      envelopeFixture({ data: 'not-an-object' }),
    ]) {
      const decision = classifyEnvelope(broken)
      expect(decision.kind, JSON.stringify(broken)).toBe('quarantined')
      if (decision.kind === 'quarantined') {
        expect(decision.errorCode).toBe('invalid_envelope')
      }
    }
  })

  test('freezes exactly the five relay topics', () => {
    expect([...EXTENSION_TOPICS].sort()).toEqual([
      'session.access.revoked.v1',
      'session.deleted.v1',
      'session.event.v1',
      'session.lifecycle.v1',
      'turn.lifecycle.v1',
    ])
  })
})

describe('relay feed batch contract', () => {
  function batchFixture(overrides: Record<string, unknown> = {}) {
    return {
      installation_id: '11111111-1111-1111-1111-111111111111',
      items: [envelopeFixture()],
      next_cursor: 'opaque-cursor',
      lease_token: 'opaque-lease',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    }
  }

  test('accepts a well-formed batch', () => {
    const result = validateFeedBatch(batchFixture())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.batch.items).toHaveLength(1)
    }
  })

  test('accepts an empty batch', () => {
    const result = validateFeedBatch(batchFixture({ items: [] }))
    expect(result.ok).toBe(true)
  })

  test('rejects batches missing cursor or lease material as a whole', () => {
    for (const broken of [
      batchFixture({ next_cursor: '' }),
      batchFixture({ lease_token: '' }),
      batchFixture({ lease_expires_at: 'yesterday' }),
      batchFixture({ installation_id: 'not-a-uuid' }),
      { installation_id: '11111111-1111-1111-1111-111111111111' },
    ]) {
      const result = validateFeedBatch(broken)
      expect(result.ok, JSON.stringify(broken)).toBe(false)
    }
  })

  test('a batch with quarantinable envelopes is still valid; the row decides', () => {
    const result = validateFeedBatch(batchFixture({
      items: [envelopeFixture({ envelope_version: 3 })],
    }))
    expect(result.ok).toBe(true)
  })
})
