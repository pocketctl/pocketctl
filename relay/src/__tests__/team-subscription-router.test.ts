import { describe, expect, test, vi } from 'vitest'

import { Router } from '../router.js'

function socket() {
  const sent: unknown[] = []
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    sent,
  } as any
}

describe('Team collaboration WebSocket subscriptions', () => {
  test('authorizes subscriptions, broadcasts only to participants, and revokes immediately', async () => {
    const authorizer = { canSubscribe: vi.fn(async (userId: number) => userId === 7) }
    const router = new Router({ query: vi.fn() } as any, { teamSubscriptionAuthorizer: authorizer })
    const allowed = socket()
    const denied = socket()
    router.registerClient(allowed, 7)
    router.registerClient(denied, 8)

    await router.handleClientMessage(allowed, { type: 'team_collaboration_subscribe', team_session_id: 'css_1' })
    await router.handleClientMessage(denied, { type: 'team_collaboration_subscribe', team_session_id: 'css_1' })
    expect(allowed.sent[0]).toMatchObject({ type: 'team_collaboration_subscription', subscribed: true })
    expect(denied.sent[0]).toMatchObject({ type: 'team_collaboration_subscription_error', error: 'not_found' })

    router.broadcastTeamEvent('css_1', [7], { event_seq: 4 })
    expect(allowed.sent[1]).toMatchObject({ type: 'team_collaboration_event', event: { event_seq: 4 } })
    expect(denied.sent).toHaveLength(1)

    router.revokeTeamSubscription('css_1', 7)
    expect(allowed.sent[2]).toEqual({ type: 'team_collaboration_access_revoked', team_session_id: 'css_1' })
    router.stop()
  })

  test('revalidates existing subscriptions after membership changes', async () => {
    let active = true
    const router = new Router({ query: vi.fn() } as any, {
      teamSubscriptionAuthorizer: { canSubscribe: vi.fn(async () => active) },
    })
    const ws = socket()
    router.registerClient(ws, 9)
    await router.handleClientMessage(ws, { type: 'team_collaboration_subscribe', team_session_id: 'css_2' })
    active = false
    await router.revalidateTeamSubscriptions()
    expect(ws.sent.at(-1)).toEqual({ type: 'team_collaboration_access_revoked', team_session_id: 'css_2' })
    router.stop()
  })
})
