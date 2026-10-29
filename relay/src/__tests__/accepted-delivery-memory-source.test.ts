import { describe, expect, test } from 'vitest'
import { buildAcceptedDeliveryMemorySourceRecords } from '../team/memory-source-projector.js'

import { acceptedDeliveryFixture } from './fixtures/accepted-delivery-memory.js'

describe('accepted delivery source producer', () => {
  test('replay is deterministic and reader scopes are distinct even at the same participant revision', () => {
    const input = acceptedDeliveryFixture(), records = buildAcceptedDeliveryMemorySourceRecords(input)
    expect(records).toEqual(buildAcceptedDeliveryMemorySourceRecords(input))
    expect(records).toHaveLength(6)
    expect(new Set(records.map(record => record.sourceId)).size).toBe(6)
    expect(new Set(records.map(record => record.sessionId)).size).toBe(2)
    expect(records[0].payload).toMatchObject({ team_source_version: 2,
      accepted_delivery: { submission_id: input.submission.id, decision_id: input.decision.id, spec_revision: 2 },
      text: 'Fix stale state\n\nAcceptance criteria:\nReplay preserves the accepted revision' })
  })

  test('submission, decision, binding replacement and reader rejoin have separate revocation boundaries', () => {
    const original = acceptedDeliveryFixture()
    const variants = [original,
      { ...original, submission: { ...original.submission, id: '55555555-5555-4555-8555-555555555555' } },
      { ...original, decision: { ...original.decision, id: '66666666-6666-4666-8666-666666666666' } },
      { ...original, binding: { ...original.binding, id: 'replacement' } },
      { ...original, binding: { ...original.binding, revision: 2 } },
      { ...original, readers: [{ userId: 7, participantRevision: 2 }] },
    ]
    expect(new Set(variants.map(input => buildAcceptedDeliveryMemorySourceRecords(input)[0].sessionId)).size).toBe(6)
  })

  test('projects only allowlisted shared text and provenance, never extra private fields or fabricated events', () => {
    const input = { ...acceptedDeliveryFixture(), native_session_id: 'PRIVATE', file_bytes: 'PRIVATE' }
    Object.assign(input.submission, { private_transcript: 'PRIVATE' })
    const records = buildAcceptedDeliveryMemorySourceRecords(input)
    expect(JSON.stringify(records)).not.toContain('PRIVATE')
    expect(records.every(record => !('team_event_ids' in record.payload) && !('team_event_seqs' in record.payload))).toBe(true)
    expect(records[2].payload).toMatchObject({ status: 'completed', turn_reason: 'team_delivery_accepted' })
  })

  test('deduplicates identical readers but rejects inconsistent reader generations', () => {
    const input = acceptedDeliveryFixture()
    expect(buildAcceptedDeliveryMemorySourceRecords({ ...input, readers: [] })).toEqual([])
    expect(buildAcceptedDeliveryMemorySourceRecords({ ...input, readers: [input.readers[0], input.readers[0]] })).toHaveLength(3)
    expect(() => buildAcceptedDeliveryMemorySourceRecords({ ...input,
      readers: [input.readers[0], { ...input.readers[0], participantRevision: 2 }] })).toThrow(/conflicting/)
  })

  test.each(['rejected', 'bad-hash', 'future-publication', 'numeric-string', 'invalid-date', 'empty-summary'])('rejects invalid producer input: %s', kind => {
    const input = acceptedDeliveryFixture()
    if (kind === 'rejected') input.decision.decision = 'changes_requested' as never
    if (kind === 'bad-hash') input.submission.manifestSha256 = 'not-a-hash'
    if (kind === 'future-publication') input.submission.publishedAt = new Date('2027-01-01')
    if (kind === 'numeric-string') input.contextVersion = '0' as never
    if (kind === 'invalid-date') input.spec.createdAt = new Date('invalid')
    if (kind === 'empty-summary') input.submission.summary = '  '
    expect(() => buildAcceptedDeliveryMemorySourceRecords(input)).toThrow(/invalid/)
  })
})
