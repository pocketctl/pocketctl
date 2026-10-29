import type { AcceptedDeliveryMemoryInput } from '../../team/accepted-delivery-memory-source.js'

export function acceptedDeliveryFixture(): AcceptedDeliveryMemoryInput {
  return {
    teamId: 'ctm_delivery', teamSessionId: 'css_delivery', callId: 'ccl_delivery', contextVersion: 0,
    taskId: 'ctk_delivery',
    binding: { id: 'cmbd_delivery', revision: 1, installationId: '11111111-1111-4111-8111-111111111111',
      ownerScopeKind: 'team', ownerScopeId: '22222222-2222-4222-8222-222222222222' },
    readers: [{ userId: 7, participantRevision: 1 }, { userId: 8, participantRevision: 1 }],
    spec: { revision: 2, goal: 'Fix stale state', acceptance: 'Replay preserves the accepted revision',
      authorUserId: 7, createdAt: new Date('2026-10-25T01:00:00.000Z') },
    submission: { id: '33333333-3333-4333-8333-333333333333', version: 4,
      summary: 'Use the immutable revision when replaying a request.', manifestSha256: 'a'.repeat(64),
      authorOfferId: 'cao_delivery', publishedAt: new Date('2026-10-25T01:01:00.000Z') },
    decision: { id: '44444444-4444-4444-8444-444444444444', decision: 'accepted',
      reviewerUserId: 8, createdAt: new Date('2026-10-25T01:02:00.000Z') },
  }
}
