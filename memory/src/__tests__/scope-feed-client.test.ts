import { describe, expect, test, vi } from 'vitest'
import { createFeedClient } from '../relay/feed-client.js'

const REQUESTED = '11111111-1111-4111-8111-111111111111'
const RETURNED = '22222222-2222-4222-8222-222222222222'

describe('scope-control feed client binding', () => {
  test('rejects a validly shaped batch returned for a different installation', async () => {
    const client = createFeedClient({
      http: { request: vi.fn(async () => ({
        installation_id: RETURNED,
        items: [],
        next_cursor: 'cursor',
        lease_token: 'lease',
        lease_expires_at: '2026-08-30T00:01:00.000Z',
      })) } as never,
      tokens: { get: vi.fn(async () => 'token'), invalidate: vi.fn() },
    })

    await expect(client.pullScopeControlFeed(REQUESTED, 100))
      .rejects.toThrow(/installation mismatch/)
  })
})
