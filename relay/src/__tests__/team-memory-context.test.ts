import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'

import { TeamMemoryContextBridge } from '../team/memory-context-bridge.js'

const INSTALLATION = '11111111-1111-4111-8111-111111111111'
const SCOPE = '22222222-2222-4222-8222-222222222222'
const CLAIM = '33333333-3333-4333-8333-333333333333'
const VERSION = '44444444-4444-4444-8444-444444444444'

function grant(userId: number) {
  return {
    ok: true as const,
    token: `grant-${userId}`,
    expiresInSeconds: 60,
    providerId: 'pocketctl-memory',
    providerPublicOrigin: 'https://memory.example',
    bindings: [{
      installation_id: INSTALLATION,
      owner_scope_kind: 'team' as const,
      owner_scope_id: SCOPE,
      membership_id: `membership-${userId}`,
      membership_revision: '1',
      authorization_epoch: '1',
      permissions: ['read'],
    }],
  }
}

describe('TeamMemoryContextBridge', () => {
  it('requires exact published shared references readable by every participant', async () => {
    const query = vi.fn(async () => ({ rows: [{
      team_id: 'team-1', participant_user_ids: [7, 9], installation_id: INSTALLATION,
      owner_scope_id: SCOPE, owner_scope_kind: 'team',
    }] }))
    const mint = vi.fn(async ({ userId }: { userId: number }) => grant(userId))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }))
    const bridge = new TeamMemoryContextBridge({ query } as unknown as pg.Pool, { mint }, {
      enabled: true, fetchImpl: fetchImpl as typeof fetch,
    })

    const selection = await bridge.validateSnapshot({
      sessionId: 'session-1', actorUserId: 7, references: [{
        source_kind: 'memory_claim', source_id: CLAIM, source_version: VERSION,
        installation_id: INSTALLATION, owner_scope_id: SCOPE,
      }],
    })

    expect(selection).toMatchObject({ installation_id: INSTALLATION, owner_scope_id: SCOPE })
    expect(mint.mock.calls.map(call => call[0].userId).sort()).toEqual([7, 9])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://memory.example/api/v1/memory/context/references/validate',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects a private or foreign installation before publication is claimed', async () => {
    const query = vi.fn(async () => ({ rows: [{
      team_id: 'team-1', participant_user_ids: [7], installation_id: INSTALLATION,
      owner_scope_id: SCOPE, owner_scope_kind: 'team',
    }] }))
    const mint = vi.fn()
    const bridge = new TeamMemoryContextBridge({ query } as unknown as pg.Pool, { mint }, { enabled: true })

    await expect(bridge.validateSnapshot({
      sessionId: 'session-1', actorUserId: 7, references: [{
        source_kind: 'memory_claim', source_id: CLAIM, source_version: VERSION,
        installation_id: '55555555-5555-4555-8555-555555555555', owner_scope_id: SCOPE,
      }],
    })).rejects.toMatchObject({ code: 'memory_grant_required' })
    expect(mint).not.toHaveBeenCalled()
  })

  it('revalidates the execution receiver on every dispatch', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('FROM collaboration_calls')
      ? { rows: [{
          team_session_id: 'session-1', created_by_user_id: 7,
          context_references: [{
            source_kind: 'memory_claim', source_id: CLAIM, source_version: VERSION,
            installation_id: INSTALLATION, owner_scope_id: SCOPE,
          }],
        }] }
      : { rows: [{
          team_id: 'team-1', participant_user_ids: [7, 9], installation_id: INSTALLATION,
          owner_scope_id: SCOPE, owner_scope_kind: 'team',
        }] })
    const mint = vi.fn(async ({ userId }: { userId: number }) => userId === 11
      ? { ok: false as const, code: 'not_found' as const, message: 'not found' }
      : grant(userId))
    const bridge = new TeamMemoryContextBridge({ query } as unknown as pg.Pool, { mint }, {
      enabled: true,
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
    })

    await expect(bridge.prepareDispatch({ callId: 'call-1', receiverUserId: 11 }))
      .rejects.toMatchObject({ code: 'memory_grant_required' })
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ userId: 11 }))
  })
})
