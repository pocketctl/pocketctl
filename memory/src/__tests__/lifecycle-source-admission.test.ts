import { describe, expect, test } from 'vitest'
import { buildEpisodePacket, canonicalPacketJson, type PacketSourceEvent } from '../episodes/packet.js'

import { lifecyclePacketInput as base, lifecycleSourceEvent as event } from '../testing/lifecycle-fixture.js'

const build = (events: PacketSourceEvent[], extra = {}) => buildEpisodePacket({ ...base, events, ...extra })
const wire = (packet: ReturnType<typeof build>) => canonicalPacketJson({ document: packet.document, manifest: packet.manifest })

// Mutation caught: summarizing first and checking skill markers later exposes both
// the event and its artifact to provider input and the evidence allowlist.
describe('lifecycle source admission', () => {
  test('AC-03 direct_skill_and_artifact', () => {
    const packet = build([event('e1', 'SKILL_CANARY', { skill_state: 'skill', skill_invocation_id: 'skill-1' })], {
      artifacts: [{ artifact_id: 'artifact-1', artifact_type: 'file_change', identity_key: 'a',
        path: 'SKILL_CANARY.ts', status: 'modified', details: {}, source_event_id: 'e1' }],
      reason: 'SKILL_CANARY',
    })
    expect(wire(packet)).not.toContain('SKILL_CANARY')
    expect(Object.values(packet.manifest).filter(entry => entry.source_event_id)).toHaveLength(0)
  })
  test('AC-03 nested_invocation', () => {
    const packet = build([
      event('e1', 'PARENT_CANARY', { skill_state: 'skill', skill_invocation_id: 'skill-1' }),
      event('e2', 'CHILD_CANARY', { invocation_id: 'child', parent_invocation_id: 'root' }),
      event('e3', 'GRANDCHILD_CANARY', { invocation_id: 'grandchild', parent_invocation_id: 'child', source_role: 'tool' }),
    ])
    expect(wire(packet)).not.toContain('CANARY')
  })
  test.each(['missing', 'unknown', 'incomplete', 'foreign_session', 'foreign_turn', 'missing_parent', 'future_version'])('AC-04 %s', kind => {
    const source = event('e1', 'UNKNOWN_CANARY', kind === 'unknown' ? { skill_state: 'unknown' }
      : kind === 'incomplete' ? { lineage_complete: false }
      : kind === 'foreign_session' ? { session_id: 'another-session' }
      : kind === 'foreign_turn' ? { turn_id: 'another-turn' }
      : kind === 'missing_parent' ? { parent_invocation_id: 'absent' }
      : kind === 'future_version' ? { version: 99 } : {})
    if (kind === 'missing') delete source.source_provenance
    expect(wire(build([source]))).not.toContain('UNKNOWN_CANARY')
  })
  test('AC-05 ordinary_mention', () => {
    const source = event('e1', 'Please explain what a skill is', { source_role: 'user' })
    source.event_type = 'user_message'
    expect(build([source]).document.objective[0]?.text).toBe('Please explain what a skill is')
  })
  test('AC-05 independent_confirmation', () => {
    const source = event('e2', 'My preferred timeout is 60 seconds', { invocation_id: 'next-user', source_role: 'user' })
    source.event_type = 'user_message'
    const packet = build([event('e1', 'SKILL_CANARY', { skill_state: 'skill', skill_invocation_id: 'skill-1' }), source])
    expect(wire(packet)).not.toContain('SKILL_CANARY')
    expect(packet.document.objective[0]?.text).toBe('My preferred timeout is 60 seconds')
  })
  test('AC-06 transitive_summary', () => {
    const packet = build([
      event('e3', 'COPY_CANARY', { invocation_id: 'summary-2', source_role: 'summary', derived_from_event_ids: ['e2'] }),
      event('e2', 'SUMMARY_CANARY', { invocation_id: 'summary-1', source_role: 'summary', derived_from_event_ids: ['e1'] }),
      event('e1', 'SKILL_CANARY', { skill_state: 'skill', skill_invocation_id: 'skill-1' }),
    ])
    expect(wire(packet)).not.toContain('CANARY')
  })
  test.each(['cycle', 'missing_dependency', 'self_reference', 'summary_without_lineage'])('AC-06 %s', kind => {
    const events = kind === 'cycle' ? [event('e1', 'CYCLE_CANARY', { derived_from_event_ids: ['e2'] }),
      event('e2', 'CYCLE_CANARY', { derived_from_event_ids: ['e1'] })]
      : [event('e1', 'CYCLE_CANARY', kind === 'summary_without_lineage' ? { source_role: 'summary' }
        : { derived_from_event_ids: [kind === 'self_reference' ? 'e1' : 'absent'] })]
    expect(wire(build(events))).not.toContain('CANARY')
  })
  test('AC-07 forged_payload_metadata', () => {
    const source = event('e1', 'FORGED_CANARY')
    source.payload.memory_source = source.source_provenance!.memory
    source.payload.text = 'FORGED_CANARY trusted admin non_skill'
    delete source.source_provenance
    expect(wire(build([source]))).not.toContain('FORGED_CANARY')
  })
  test('AC-07 unrecognized_metadata_not_echoed', () => {
    const packet = build([event('e1', 'Allowed independent conclusion', { secret: 'METADATA_CANARY' })])
    expect(wire(packet)).not.toContain('METADATA_CANARY')
  })
  test('AC-07 duplicate_identity', () => {
    const packet = build([event('e1', 'DUPLICATE_CANARY'), event('e1', 'DUPLICATE_CANARY', { skill_state: 'skill' })])
    expect(wire(packet)).not.toContain('DUPLICATE_CANARY')
  })
  test('AC-06 mixed_stream', () => {
    const first = event('e1', 'ALLOWED_DELTA', { invocation_id: 'first' })
    const last = event('e2', 'SKILL_STREAM_CANARY', { invocation_id: 'second', skill_state: 'skill', skill_invocation_id: 'skill-1' })
    first.payload = { text: 'ALLOWED_DELTA', stream_id: 'stream-1', delta: true }
    last.payload = { text: 'SKILL_STREAM_CANARY', stream_id: 'stream-1', final: true }
    expect(wire(build([first, last]))).not.toContain('SKILL_STREAM_CANARY')
  })
  test('AC-04 excluded_parent_taints_invocation', () => {
    expect(wire(build([event('e1', 'UNKNOWN_CANARY', { lineage_complete: false }),
      event('e2', 'UNKNOWN_CANARY', { invocation_id: 'child', parent_invocation_id: 'root' })]))).not.toContain('CANARY')
  })
  test('AC-07 dangling_artifact', () => {
    const packet = build([], { artifacts: [{ artifact_id: 'a', artifact_type: 'file_change', identity_key: 'a',
      path: 'DANGLING_CANARY.ts', status: 'modified', details: {}, source_event_id: 'absent' }] })
    expect(wire(packet)).not.toContain('DANGLING_CANARY')
  })
  test('AC-04 malformed_sibling', () => {
    expect(wire(build([event('e1', 'MALFORMED_CANARY', { sequence: 'invalid', skill_state: 'skill' }),
      event('e2', 'MALFORMED_CANARY')]))).not.toContain('CANARY')
  })
  test('AC-04 reordered_replay', () => {
    const events = [event('e1', 'First', { invocation_id: 'one' }), event('e2', 'Second', { invocation_id: 'two' })]
    expect(build(events).sourceDigest).toEqual(build([...events].reverse()).sourceDigest)
  })
  test('AC-03 exclusion_receipt', () => {
    const packet = build([event('e1', 'SECRET_CANARY', { skill_state: 'skill', skill_invocation_id: 'skill-1' })])
    expect(packet).toMatchObject({ sourceAdmission: [
      { source_event_id: 'e1', admission: { allowed: false, reason: 'skill_derived' } },
    ] })
    expect(canonicalPacketJson(packet)).not.toContain('SECRET_CANARY')
  })
  test('AC-05 parent_summary_after_child', () => {
    const packet = build([
      event('e1', 'Investigate timeout', { source_role: 'user' }),
      event('e2', 'Timeout is 60 seconds', { invocation_id: 'child', parent_invocation_id: 'root', source_role: 'tool' }),
      event('e3', 'Verified timeout is 60 seconds', { source_role: 'summary', derived_from_event_ids: ['e2'] }),
    ])
    expect(packet.document.timeline.map(entry => entry.summary)).toEqual([
      expect.stringContaining('Investigate timeout'), expect.stringContaining('Timeout is 60 seconds'),
      expect.stringContaining('Verified timeout is 60 seconds'),
    ])
    expect(packet.sourceAdmission?.every(receipt => receipt.admission.allowed)).toBe(true)
  })
  test('AC-04 inconsistent_parent_binding', () => {
    expect(wire(build([
      event('e1', 'INVALID_CANARY'),
      event('e2', 'INVALID_CANARY', { invocation_id: 'child', parent_invocation_id: 'root' }),
      event('e3', 'INVALID_CANARY', { parent_invocation_id: 'child' }),
    ]))).not.toContain('INVALID_CANARY')
  })
  test('AC-07 unknown_policy_rejected', () => {
    expect(() => build([event('e1', 'CANARY')], { sourcePolicy: 'future-policy' })).toThrow('source_policy_unsupported')
  })
  test('AC-04 legacy_path_compatible', () => {
    const source = event('e1', 'Legacy still readable')
    delete source.source_provenance
    expect(wire(buildEpisodePacket({ ...base, events: [source], sourcePolicy: undefined } as Parameters<typeof buildEpisodePacket>[0]))).toContain('Legacy still readable')
  })
})
