import { beforeAll, describe, expect, test } from 'vitest'
import { adaptTeamSource, type TeamSourceAdapterInput } from '../episodes/team-source-adapter.js'
import { compileEpisode, sourceReferenceFromEvents } from '../episodes/compiler.js'
import { independentSourceCount, teamOriginalRoot } from '../episodes/source-lineage.js'

// Execute the real Relay producer without expanding Memory's TypeScript rootDir.
let inputs: TeamSourceAdapterInput[]
beforeAll(async () => {
  const producer = await import(new URL('../../../relay/src/team/accepted-delivery-memory-source.ts', import.meta.url).href)
  const fixture = await import(new URL('../../../relay/src/__tests__/fixtures/accepted-delivery-memory.ts', import.meta.url).href)
  inputs = producer.buildAcceptedDeliveryMemorySourceRecords(fixture.acceptedDeliveryFixture()).map((record: {
    sourceKind: string; sourceId: string; sessionId: string; eventType: string; occurredAt: Date; payload: Record<string, unknown>
  }) => ({
    source_kind: record.sourceKind, source_id: record.sourceId, session_id: record.sessionId,
    turn_id: record.payload.turn_id as string, event_type: record.eventType,
    recorded_at: record.occurredAt, classification: {}, data: record.payload,
  }))
})

describe('accepted delivery source consumer contract', () => {
  test('consumes the actual Relay packet and keeps submission plus decision identity through episode compilation', () => {
    const events = inputs.slice(0, 3).map(input => adaptTeamSource(input)!)
    expect(events.map(event => event.eventType)).toEqual(['user_goal', 'agent_text', 'turn_status'])
    expect(events[2].payload).toMatchObject({ turn_status: 'completed', turn_reason: 'team_delivery_accepted' })
    expect(events[1].provenance).toMatchObject({ source_version: 2, accepted_delivery: {
      task_id: 'ctk_delivery', spec_revision: 2, submission_version: 4, decision: 'accepted', reviewer_user_id: 8,
    } })
    expect(events[1].provenance.team_event_ids).toBeUndefined()
    const reference = sourceReferenceFromEvents(events.map(event => ({ source_provenance: { ...event.provenance } })))
    const episode = compileEpisode({
      installationId: 'personal', sessionId: events[0].sessionId, turnId: events[0].turnId,
      outcome: 'completed', reason: 'team_delivery_accepted', startedAt: events[0].occurredAt,
      terminalAt: events[2].occurredAt, eventCount: 3, artifactCounts: {}, eventTypeCounts: {},
      classificationDistribution: {}, toolErrorCount: 0, retryCount: 0, correctionCount: 0,
      stabilizationMs: 30_000, sourceReference: reference,
    })
    expect(episode.summary.references.source?.accepted_delivery).toEqual(inputs[0].data.accepted_delivery)
    expect(JSON.stringify(episode.summary)).not.toContain('Fix stale state')
  })

  test('reader projections and original Call remain one independent evidence source', () => {
    const first = adaptTeamSource(inputs[1])!, second = adaptTeamSource(inputs[4])!
    expect(first.originPosition).not.toBe(second.originPosition)
    expect(first.canonicalEventKey).toBe(second.canonicalEventKey)
    expect(first.sessionId).not.toBe(second.sessionId)
    const rawCall = { source_kind: 'team_session', source_version: 1,
      team_id: first.provenance.team_id, team_session_id: first.provenance.team_session_id, team_call_id: first.provenance.team_call_id }
    const roots = [rawCall, first.provenance, second.provenance].map(source => teamOriginalRoot(source)!)
    expect(new Set(roots).size).toBe(1)
    expect(independentSourceCount(roots.map((root, index) => ({
      sessionId: `session-${index}`, episodeId: `episode-${index}`, sourceRootIds: [root],
    })))).toBe(1)
  })

  test.each([
    'decision', 'submission', 'hash', 'scope-team', 'scope-reader', 'session', 'turn', 'source-id',
    'original-id', 'projection-id', 'fake-events', 'numeric-string', 'timestamp', 'outcome', 'event-type', 'version',
  ])('rejects inconsistent or malformed feed records: %s', kind => {
    const input = structuredClone(inputs[2]), data = input.data
    const delivery = data.accepted_delivery as Record<string, unknown>, scope = data.read_scope as Record<string, unknown>
    if (kind === 'decision') delivery.decision = 'changes_requested'
    if (kind === 'submission') delivery.submission_id = '55555555-5555-4555-8555-555555555555'
    if (kind === 'hash') delivery.manifest_sha256 = 'invalid'
    if (kind === 'scope-team') scope.team_id = 'another-team'
    if (kind === 'scope-reader') scope.participant_user_id = 9
    if (kind === 'session') input.session_id = 'another-session'
    if (kind === 'turn') input.turn_id = 'another-turn'
    if (kind === 'source-id') input.source_id += 'suffix'
    if (kind === 'original-id') data.original_source_id = 'another-source'
    if (kind === 'projection-id') data.reader_projection_id = 'another-projection'
    if (kind === 'fake-events') data.team_event_ids = ['fabricated-event']
    if (kind === 'numeric-string') data.context_version = '0'
    if (kind === 'timestamp') data.occurred_at = '2026-10-25T01:03:00.000Z'
    if (kind === 'outcome') data.status = 'failed'
    if (kind === 'event-type') input.event_type = 'agent_text'
    if (kind === 'version') data.team_source_version = 99
    expect(() => adaptTeamSource(input)).toThrow()
  })

  test('never promotes feed flags or arbitrary content to knowledge publication authority', () => {
    const input = structuredClone(inputs[1])
    Object.assign(input.data, { actor_scope: 'system', native_session_id: 'PRIVATE', published: true, auto_publish: true })
    Object.assign(input.data.accepted_delivery as object, { private_note: 'PRIVATE', published: true })
    const event = adaptTeamSource(input)!
    expect(event.classification.actor_scope).toBe('root')
    expect(event.payload).not.toHaveProperty('published')
    expect(event.provenance.accepted_delivery).not.toHaveProperty('published')
    expect(JSON.stringify(event)).not.toContain('PRIVATE')
  })

  test('incomplete v2 provenance cannot silently downgrade to a legacy episode reference', () => {
    const source = { ...adaptTeamSource(inputs[0])!.provenance } as Record<string, unknown>
    delete source.accepted_delivery
    expect(sourceReferenceFromEvents([{ source_provenance: source }])).toBeNull()
  })

  test('legacy v1 Call packets are still accepted with their original identity and terminal reason', () => {
    const data = { ...inputs[0].data, team_source_version: 1, turn_id: 'team-call:ccl_delivery',
      team_event_ids: ['cev_goal'], team_event_seqs: [1] }
    delete (data as Record<string, unknown>).accepted_delivery
    const event = adaptTeamSource({ ...inputs[0], data, session_id: 'legacy-session', turn_id: data.turn_id })!
    expect(event.provenance.source_version).toBe(1)
    expect(event.canonicalEventKey).toBe('team:ctm_delivery:css_delivery:ccl_delivery:goal:v1')
    expect(event.provenance).not.toHaveProperty('accepted_delivery')
    expect(adaptTeamSource({ ...inputs[0], source_kind: 'native' })).toBeNull()
  })
})
