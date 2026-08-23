import { describe, expect, test, vi } from 'vitest'

import { createAttentionNotifier } from '../attention-inbox/notifier.js'

describe('Attention Inbox cross-instance notifier', () => {
  test('loads the committed full item from a compact PostgreSQL notification', async () => {
    let onNotification: ((message: { channel: string; payload?: string }) => void) | undefined
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      on: vi.fn((event: string, listener: typeof onNotification) => {
        if (event === 'notification') onNotification = listener
      }),
      off: vi.fn(),
      release: vi.fn(),
    }
    const item = { item_id: 'item-1', revision: 4, state: 'open' }
    const loadItem = vi.fn().mockResolvedValue(item)
    const broadcast = vi.fn()
    const notifier = createAttentionNotifier({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      loadItem,
      broadcast,
    })

    await notifier.start()
    onNotification?.({
      channel: 'pocketctl_attention',
      payload: JSON.stringify({ user_id: 7, item_id: 'item-1', revision: 4, operation: 'changed' }),
    })

    await vi.waitFor(() => expect(loadItem).toHaveBeenCalledWith(7, 'item-1', 4))
    expect(broadcast).toHaveBeenCalledWith(7, {
      type: 'attention_item_changed', schema_version: 1, item,
    })

    await notifier.stop()
    expect(client.query).toHaveBeenNthCalledWith(1, 'LISTEN pocketctl_attention')
    expect(client.query).toHaveBeenLastCalledWith('UNLISTEN pocketctl_attention')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('ignores malformed and unrelated notifications without broadcasting', async () => {
    let onNotification: ((message: { channel: string; payload?: string }) => void) | undefined
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      on: vi.fn((event: string, listener: typeof onNotification) => {
        if (event === 'notification') onNotification = listener
      }),
      off: vi.fn(),
      release: vi.fn(),
    }
    const broadcast = vi.fn()
    const notifier = createAttentionNotifier({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      loadItem: vi.fn(),
      broadcast,
    })
    await notifier.start()

    onNotification?.({ channel: 'other', payload: '{}' })
    onNotification?.({ channel: 'pocketctl_attention', payload: 'not-json' })
    onNotification?.({ channel: 'pocketctl_attention', payload: '{"user_id":"secret"}' })

    await Promise.resolve()
    expect(broadcast).not.toHaveBeenCalled()
    await notifier.stop()
  })

  test('broadcasts versioned recovery deltas only when recovery visibility is on', async () => {
    let onNotification: ((message: { channel: string; payload?: string }) => void) | undefined
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      on: vi.fn((_event: string, listener: typeof onNotification) => { onNotification = listener }),
      off: vi.fn(), release: vi.fn(),
    }
    const recovery = { recovery_id: 'recovery-1', revision: 2, state: 'open' }
    const loadRecovery = vi.fn().mockResolvedValue(recovery)
    const broadcast = vi.fn()
    const notifier = createAttentionNotifier({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      loadItem: vi.fn(), loadRecovery, recoveryVisible: true, broadcast,
    })
    await notifier.start()
    onNotification?.({
      channel: 'pocketctl_attention',
      payload: JSON.stringify({
        entity: 'recovery', user_id: 7, item_id: 'recovery-1', revision: 2, operation: 'changed',
      }),
    })

    await vi.waitFor(() => expect(loadRecovery).toHaveBeenCalledWith(7, 'recovery-1', 2))
    expect(broadcast).toHaveBeenCalledWith(7, {
      type: 'attention_recovery_changed', schema_version: 2, recovery,
    })
    await notifier.stop()

    const hiddenBroadcast = vi.fn()
    const hiddenClient = { ...client, on: vi.fn((_event: string, listener: typeof onNotification) => { onNotification = listener }) }
    const hidden = createAttentionNotifier({
      pool: { connect: vi.fn().mockResolvedValue(hiddenClient) } as never,
      loadItem: vi.fn(), loadRecovery, recoveryVisible: false, broadcast: hiddenBroadcast,
    })
    await hidden.start()
    onNotification?.({
      channel: 'pocketctl_attention',
      payload: JSON.stringify({
        entity: 'recovery', user_id: 7, item_id: 'recovery-1', revision: 2, operation: 'changed',
      }),
    })
    await Promise.resolve()
    expect(hiddenBroadcast).not.toHaveBeenCalled()
    await hidden.stop()
  })
})
