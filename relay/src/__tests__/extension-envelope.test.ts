import { describe, expect, test } from 'vitest'
import {
  EXTENSION_ENVELOPE_VERSION,
  buildFeedEnvelope,
  extensionTopicForSource,
  SESSION_DELETED_SOURCE_KIND,
  SESSION_ACCESS_REVOKED_SOURCE_KIND,
} from '../extensions/envelope.js'

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    source_seq: 1,
    source_kind: 'canonical_event',
    source_id: 'event:93821',
    owner_user_id: 42,
    session_id: 'session-1',
    event_type: 'agent_text',
    occurred_at: null,
    payload: {
      type: 'agent_text',
      session_id: 'session-1',
      text: 'hi',
      turn_id: 'turn:v1:codex:abc',
      actor_scope: 'root',
      flow_scope: 'main',
      content_class: 'dialogue',
      classifier_version: 'v1',
    },
    created_at: new Date('2026-08-23T10:00:00Z'),
    ...overrides,
  }
}

describe('extension topic mapping for source rows', () => {
  test('canonical events map by event type with fail-open defaults', () => {
    expect(extensionTopicForSource({ event_type: 'turn_status', source_kind: 'canonical_event' })).toBe('turn.lifecycle.v1')
    expect(extensionTopicForSource({ event_type: 'session_created', source_kind: 'canonical_event' })).toBe('session.lifecycle.v1')
    expect(extensionTopicForSource({ event_type: 'session_discovered', source_kind: 'canonical_event' })).toBe('session.lifecycle.v1')
    expect(extensionTopicForSource({ event_type: 'session_status', source_kind: 'canonical_event' })).toBe('session.lifecycle.v1')
    expect(extensionTopicForSource({ event_type: 'agent_text', source_kind: 'canonical_event' })).toBe('session.event.v1')
    expect(extensionTopicForSource({ event_type: 'brand_new_type', source_kind: 'canonical_event' })).toBe('session.event.v1')
    expect(extensionTopicForSource({ event_type: 'agent_text', source_kind: 'unknown_kind' })).toBe('session.event.v1')
  })

  test('tombstone source kinds map to their dedicated topics', () => {
    expect(extensionTopicForSource({ event_type: 'session_deleted', source_kind: SESSION_DELETED_SOURCE_KIND })).toBe('session.deleted.v1')
    expect(extensionTopicForSource({ event_type: 'session_access_revoked', source_kind: SESSION_ACCESS_REVOKED_SOURCE_KIND })).toBe('session.access.revoked.v1')
  })
})

describe('extension feed envelope v1', () => {
  test('builds the frozen envelope shape', () => {
    const envelope = buildFeedEnvelope(sourceRow(), 183921)

    expect(envelope).toEqual({
      envelope_version: EXTENSION_ENVELOPE_VERSION,
      feed_id: '183921',
      topic: 'session.event.v1',
      source: {
        kind: 'canonical_event',
        id: 'event:93821',
        recorded_at: '2026-08-23T10:00:00.000Z',
      },
      subject: {
        session_id: 'session-1',
        turn_id: 'turn:v1:codex:abc',
        event_type: 'agent_text',
      },
      classification: {
        actor_scope: 'root',
        flow_scope: 'main',
        content_class: 'dialogue',
        classifier_version: 'v1',
      },
      data: sourceRow().payload,
    })
  })

  test('never introduces owner identity or credential material', () => {
    const envelope = buildFeedEnvelope(sourceRow(), 1)
    const keys = Object.keys(envelope)
    expect(keys).toEqual([
      'envelope_version', 'feed_id', 'topic', 'source', 'subject', 'classification', 'data',
    ])
    expect(JSON.stringify(envelope)).not.toContain('owner_user_id')
    expect(JSON.stringify(envelope)).not.toContain('42')
  })

  test('omits absent turn and classification instead of inventing them', () => {
    const envelope = buildFeedEnvelope(sourceRow({
      payload: { type: 'user_text', session_id: 'session-1', text: 'hi' },
    }), 5)
    expect(envelope.subject.turn_id).toBeUndefined()
    expect(envelope.classification.actor_scope).toBeUndefined()
  })

  test('tombstone envelopes keep the tombstone topic and payload', () => {
    const envelope = buildFeedEnvelope(sourceRow({
      source_kind: SESSION_DELETED_SOURCE_KIND,
      source_id: 'session_deleted:session-1',
      event_type: 'session_deleted',
      payload: { session_id: 'session-1' },
    }), 7)
    expect(envelope.topic).toBe('session.deleted.v1')
    expect(envelope.subject.event_type).toBe('session_deleted')
    expect(envelope.data).toEqual({ session_id: 'session-1' })
  })
})
