import { describe, expect, test, vi } from 'vitest'
import { createScopeControlProjector } from '../governance/membership-projector.js'

const INSTALLATION = '11111111-1111-4111-8111-111111111111'
const TEAM = '22222222-2222-4222-8222-222222222222'
const OTHER_TEAM = '33333333-3333-4333-8333-333333333333'
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444'

function envelope(ownerScopeId: string, feedId = '1') {
  return {
    envelope_version: 2,
    feed_id: feedId,
    topic: 'scope.membership.v2',
    owner_scope: { kind: 'team', id: ownerScopeId, authorization_epoch: '9007199254740993' },
    source: { kind: 'scope_membership', id: MEMBERSHIP, recorded_at: '2026-08-30T00:00:00.000Z' },
    subject: { membership_id: MEMBERSHIP, event_type: 'membership_roles_changed' },
    classification: {},
    data: { membership_revision: '9007199254740993', state: 'active', roles: ['reviewer'] },
  }
}

function projectorFor(item: ReturnType<typeof envelope>) {
  const ack = vi.fn(async () => 0)
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
  const mirror = {
    get: vi.fn(async () => ({
      installation_id: INSTALLATION,
      owner_scope_kind: 'team',
      owner_scope_id: TEAM,
      parent_organization_id: null,
      state: 'active',
      authorization_epoch: '9007199254740993',
      last_feed_id: '9007199254740992',
    })),
    advanceEpoch: vi.fn(async () => undefined),
    tombstoneEpochAtLeast: vi.fn(async () => false),
    recordTombstone: vi.fn(async () => undefined),
    listSharedInstallations: vi.fn(async () => []),
  }
  const projector = createScopeControlProjector({
    pool: pool as never,
    workerId: 'test',
    pullScopeControlFeed: vi.fn(async () => ({
      installation_id: INSTALLATION,
      items: [item],
      next_cursor: 'cursor',
      lease_token: 'lease',
      lease_expires_at: '2026-08-30T00:01:00.000Z',
    })),
    ackScopeControlFeed: ack,
    mirror: mirror as never,
  })
  return { projector, pool, mirror, ack }
}

describe('scope-control projector isolation fences', () => {
  test('rejects an envelope for a different owner scope without projecting or ACKing', async () => {
    const { projector, pool, ack } = projectorFor(envelope(OTHER_TEAM))
    await expect(projector.consumeInstallation(INSTALLATION)).rejects.toThrow(/owner scope mismatch/)
    expect(pool.query).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
  })

  test('projects adjacent feed ids above the JavaScript safe-integer limit', async () => {
    const { projector, pool, ack } = projectorFor(envelope(TEAM, '9007199254740993'))
    await expect(projector.consumeInstallation(INSTALLATION)).resolves.toEqual({ projected: 1, skipped: 0 })
    expect(pool.query).toHaveBeenCalled()
    expect(ack).toHaveBeenCalledTimes(1)
  })

  test('marks a shared installation ready only after its control feed is ACKed', async () => {
    const sequence: string[] = []
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("local_status = 'ready'")) sequence.push('ready')
        return { rows: [], rowCount: 0 }
      }),
    }
    const mirror = {
      get: vi.fn(async () => ({
        installation_id: INSTALLATION,
        owner_scope_kind: 'team',
        owner_scope_id: TEAM,
        parent_organization_id: null,
        state: 'active',
        authorization_epoch: '1',
        last_feed_id: '0',
      })),
      advanceEpoch: vi.fn(async () => undefined),
      tombstoneEpochAtLeast: vi.fn(async () => false),
      recordTombstone: vi.fn(async () => undefined),
      listSharedInstallations: vi.fn(async () => []),
    }
    const projector = createScopeControlProjector({
      pool: pool as never,
      workerId: 'test',
      pullScopeControlFeed: vi.fn(async () => ({
        installation_id: INSTALLATION,
        items: [],
        next_cursor: 'cursor',
        lease_token: 'lease',
        lease_expires_at: '2026-08-30T00:01:00.000Z',
      })),
      ackScopeControlFeed: vi.fn(async () => { sequence.push('ack'); return 0 }),
      mirror: mirror as never,
    })

    await expect(projector.consumeInstallation(INSTALLATION))
      .resolves.toEqual({ projected: 0, skipped: 0 })
    expect(sequence).toEqual(['ack', 'ready'])
  })
})
