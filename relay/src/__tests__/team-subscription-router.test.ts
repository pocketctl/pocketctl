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

    await router.broadcastTeamEvent('css_1', [7], { event_seq: 4 })
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

  test('does not push an event to a previously subscribed account after access is revoked', async () => {
    let active = true
    const router = new Router({ query: vi.fn() } as any, { teamSubscriptionAuthorizer: { canSubscribe: async () => active } })
    const ws = socket()
    router.registerClient(ws, 7)
    try {
      await router.handleClientMessage(ws, { type: 'team_collaboration_subscribe', team_session_id: 'css_1' })
      active = false
      await router.broadcastTeamEvent('css_1', [7], { content: 'Must stay private' })
      expect(ws.sent).toEqual([
        expect.objectContaining({ type: 'team_collaboration_subscription', subscribed: true }),
        { type: 'team_collaboration_access_revoked', team_session_id: 'css_1' },
      ])
    } finally { router.stop() }
  })

  test('a queued event with an older audience cannot revoke a newly authorized participant', async () => {
    let blocked = false
    let release!: (allowed: boolean) => void
    const router = new Router({ query: vi.fn() } as any, { teamSubscriptionAuthorizer: {
      canSubscribe: async userId => blocked && userId === 7 ? new Promise<boolean>(resolve => { release = resolve }) : true,
    } })
    const original = socket(), newcomer = socket()
    try {
      router.registerClient(original, 7)
      await router.handleClientMessage(original, { type: 'team_collaboration_subscribe', team_session_id: 'css_1' })
      blocked = true
      const event = router.broadcastTeamEvent('css_1', [7], { event_seq: 1 })
      await Promise.resolve()
      router.registerClient(newcomer, 8)
      await router.handleClientMessage(newcomer, { type: 'team_collaboration_subscribe', team_session_id: 'css_1' })
      blocked = false; release(true); await event
      expect(newcomer.sent).toEqual([expect.objectContaining({ type: 'team_collaboration_subscription', subscribed: true })])
      await router.broadcastTeamEvent('css_1', [7, 8], { event_seq: 2 })
      expect(newcomer.sent.at(-1)).toMatchObject({ type: 'team_collaboration_event', event: { event_seq: 2 } })
    } finally { router.stop() }
  })
})
