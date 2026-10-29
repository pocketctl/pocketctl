import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { deliveryWithdrawal } from '../episodes/delivery-withdrawal.js'

function fixture() {
  const data = { team_id: 'team', team_session_id: 'session',
    submission_id: '11111111-1111-4111-8111-111111111111', decision_id: '22222222-2222-4222-8222-222222222222',
    team_memory_binding_id: 'binding', team_memory_binding_revision: 3,
    participant_user_id: 7, participant_revision: 5, reason: 'artifact_revoked', team_delivery_source_revoked: true }
  const session = 'team_delivery_' + createHash('sha256').update(JSON.stringify([
    'team-accepted-delivery-v2', data.team_session_id, data.submission_id, data.decision_id,
    data.team_memory_binding_id, data.team_memory_binding_revision, data.participant_user_id, data.participant_revision,
  ])).digest('hex').slice(0, 32)
  return { topic: 'session.access.revoked.v1', source_kind: 'session_access_revoked', event_type: 'session_access_revoked',
    source_id: `team-delivery-withdraw:${session}`, session_id: session, data: data as Record<string, unknown> }
}
describe('authenticated delivery withdrawal identity', () => {
  test('reconstructs only the original source tuple, excluding arbitrary fields', () => {
    const input = fixture(); input.data.private_text = 'PRIVATE'
    expect(deliveryWithdrawal(input)).toEqual({ teamId: 'team', teamSessionId: 'session',
      submissionId: input.data.submission_id, decisionId: input.data.decision_id })
  })
  test('ordinary access revocation has no global withdrawal semantics', () => {
    const input = fixture(); input.source_id = 'team-delivery-revoke:' + input.session_id; input.data.reason = 'participant_removed'
    expect(deliveryWithdrawal(input)).toBeNull()
    expect(deliveryWithdrawal({ ...input, data: {} })).toBeNull()
  })
  test.each(['topic', 'source_kind', 'event_type', 'source_id', 'session_id', 'decision_id', 'participant_user_id',
    'participant_revision', 'team_memory_binding_id', 'team_memory_binding_revision', 'team_session_id', 'flag', 'reason'])('fails closed for altered %s', field => {
    const input = fixture()
    if (['topic', 'source_kind', 'event_type', 'source_id', 'session_id'].includes(field)) (input as Record<string, unknown>)[field] = 'wrong'
    else if (field === 'flag') input.data.team_delivery_source_revoked = false
    else if (field === 'reason') input.data.reason = 'participant_removed'
    else input.data[field] = typeof input.data[field] === 'number' ? String(input.data[field]) : 'wrong'
    expect(() => deliveryWithdrawal(input)).toThrow(/delivery withdrawal/)
  })
})
