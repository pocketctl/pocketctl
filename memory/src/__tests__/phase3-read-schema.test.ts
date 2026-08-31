import { describe, expect, test } from 'vitest'

import { RecallRequestSchema, SearchRequestSchema } from '../api/schemas.js'
import { validateScopeControlBatch } from '../relay/validation.js'

const PERSONAL = '11111111-1111-4111-8111-111111111111'
const TEAM = '22222222-2222-4222-8222-222222222222'

describe('phase 3 read request schema', () => {
  test('accepts a bounded explicit scope selection for search and recall', () => {
    expect(SearchRequestSchema.parse({ query: 'q', scope_installation_ids: [PERSONAL, TEAM] })
      .scope_installation_ids).toEqual([PERSONAL, TEAM])
    expect(RecallRequestSchema.parse({ query: 'q', scope_installation_ids: [TEAM] })
      .scope_installation_ids).toEqual([TEAM])
    expect(SearchRequestSchema.safeParse({ query: 'q', scope_installation_ids: [] }).success).toBe(false)
    expect(SearchRequestSchema.safeParse({
      query: 'q', scope_installation_ids: Array.from({ length: 17 }, () => PERSONAL),
    }).success).toBe(false)
  })
})

describe('scope control batch validation', () => {
  test('rejects the whole batch when any authorization-control envelope is malformed', () => {
    const decision = validateScopeControlBatch({
      installation_id: TEAM,
      items: [{ envelope_version: 99, feed_id: '1' }],
      next_cursor: 'cursor',
      lease_token: 'lease',
      lease_expires_at: '2026-08-30T00:00:00.000Z',
    })
    expect(decision.ok).toBe(false)
  })

  test('rejects arbitrary metadata and unknown roles in the scope-control allowlist', () => {
    const base = {
      envelope_version: 2,
      feed_id: '1',
      topic: 'scope.membership.v2',
      owner_scope: { kind: 'team', id: TEAM, authorization_epoch: '2' },
      source: {
        kind: 'scope_membership',
        id: PERSONAL,
        recorded_at: '2026-08-30T00:00:00.000Z',
      },
      subject: { membership_id: PERSONAL, event_type: 'membership_created' },
      classification: {},
      data: { membership_revision: '1', state: 'active', roles: ['reader'] },
    }
    const batch = (item: unknown) => validateScopeControlBatch({
      installation_id: TEAM,
      items: [item],
      next_cursor: 'cursor',
      lease_token: 'lease',
      lease_expires_at: '2026-08-30T00:00:00.000Z',
    })
    expect(batch(base).ok).toBe(true)
    expect(batch({ ...base, data: { ...base.data, arbitrary: 'secret' } }).ok).toBe(false)
    expect(batch({ ...base, data: { ...base.data, roles: ['root'] } }).ok).toBe(false)
  })
})
