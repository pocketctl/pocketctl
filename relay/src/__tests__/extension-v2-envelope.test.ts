import { describe, expect, test } from 'vitest'

import {
  EXTENSION_ENVELOPE_VERSION_V2,
  buildScopeFeedEnvelope,
} from '../extensions/envelope.js'
import {
  EXTENSION_PROTOCOL_VERSIONS,
  SCOPE_CONTROL_TOPICS,
  isScopeControlTopic,
} from '../extensions/types.js'

describe('extension-feed.v2 envelope', () => {
  test('advertises the v2 protocol and control topics', () => {
    expect(EXTENSION_PROTOCOL_VERSIONS).toContain('extension-feed.v1')
    expect(EXTENSION_PROTOCOL_VERSIONS).toContain('extension-feed.v2')
    expect(SCOPE_CONTROL_TOPICS).toEqual([
      'scope.membership.v2',
      'scope.lifecycle.v2',
      'scope.installation.v2',
    ])
    expect(isScopeControlTopic('scope.membership.v2')).toBe(true)
    expect(isScopeControlTopic('session.event.v1')).toBe(false)
    expect(isScopeControlTopic('scope.audit.v9')).toBe(false)
  })

  test('builds a membership envelope with the frozen v2 shape', () => {
    const envelope = buildScopeFeedEnvelope(
      {
        outbox_id: 42,
        scope_kind: 'team',
        scope_id: '11111111-1111-4111-8111-111111111111',
        topic: 'scope.membership.v2',
        payload: {
          membership_id: '22222222-2222-4222-8222-222222222222',
          event_type: 'membership_state_changed',
          membership_revision: 4,
          state: 'revoked',
          roles: [],
          authorization_epoch: 7,
        },
        recorded_at: new Date('2026-08-30T10:00:00Z'),
      },
      42,
    )

    expect(envelope.envelope_version).toBe(EXTENSION_ENVELOPE_VERSION_V2)
    expect(envelope.envelope_version).toBe(2)
    expect(envelope.feed_id).toBe('42')
    expect(envelope.topic).toBe('scope.membership.v2')
    expect(envelope.owner_scope).toEqual({
      kind: 'team',
      id: '11111111-1111-4111-8111-111111111111',
      authorization_epoch: '7',
    })
    expect(envelope.source).toEqual({
      kind: 'scope_membership',
      id: '22222222-2222-4222-8222-222222222222',
      recorded_at: '2026-08-30T10:00:00.000Z',
    })
    expect(envelope.subject).toEqual({
      membership_id: '22222222-2222-4222-8222-222222222222',
      event_type: 'membership_state_changed',
    })
    expect(envelope.classification).toEqual({})
    expect(envelope.data).toEqual({
      membership_revision: '4',
      state: 'revoked',
      roles: [],
    })
  })

  test('builds a lifecycle envelope scoped to the owner scope', () => {
    const envelope = buildScopeFeedEnvelope(
      {
        outbox_id: 7,
        scope_kind: 'organization',
        scope_id: '33333333-3333-4333-8333-333333333333',
        topic: 'scope.lifecycle.v2',
        payload: {
          event_type: 'scope_suspended',
          authorization_epoch: 2,
          revision: 2,
          state: 'suspended',
        },
        recorded_at: new Date('2026-08-30T11:00:00Z'),
      },
      7,
    )
    expect(envelope.topic).toBe('scope.lifecycle.v2')
    expect(envelope.source.kind).toBe('scope_lifecycle')
    expect(envelope.source.id).toBe('33333333-3333-4333-8333-333333333333')
    expect(envelope.subject).toEqual({ event_type: 'scope_suspended' })
    expect(envelope.data).toEqual({ state: 'suspended' })
  })

  test('rejects envelope construction for non-control topics and malformed payloads', () => {
    const base = {
      outbox_id: 1,
      scope_kind: 'team' as const,
      scope_id: '11111111-1111-4111-8111-111111111111',
      recorded_at: new Date('2026-08-30T10:00:00Z'),
    }
    expect(() => buildScopeFeedEnvelope({
      ...base,
      topic: 'session.event.v1',
      payload: {},
    }, 1)).toThrow()
    expect(() => buildScopeFeedEnvelope({
      ...base,
      topic: 'scope.membership.v2',
      payload: { event_type: 'membership_created' },
    }, 1)).toThrow()
    expect(() => buildScopeFeedEnvelope({
      ...base,
      topic: 'scope.membership.v2',
      payload: {
        membership_id: 'not-a-uuid-or-opaque-id-ok',
        event_type: 'membership_created',
        membership_revision: 1,
        state: 'active',
        roles: ['reader'],
        authorization_epoch: 1,
      },
    }, 1)).not.toThrow()
  })
})
