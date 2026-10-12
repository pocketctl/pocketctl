import { describe, expect, test, vi } from 'vitest'
import { createSystemNotificationStore } from '../useSystemNotifications'
import { AttentionInboxApiError } from '../../services/attentionInboxClient'
import type { SystemNotification, SystemNotificationPage } from '../../types/attentionInbox'

const notice: SystemNotification = {
  notification_id: 'notice1', revision: 1, kind: 'system', topic: 'session_lifecycle',
  created_at: '2026-10-12T00:00:00Z', read_at: null, expires_at: '2027-01-10T00:00:00Z',
  subject_count: 1, subject_preview: [], subjects_next_cursor: null, requires_approval: false,
}
const page = (notifications = [notice], next_cursor: string | null = null): SystemNotificationPage => ({ notifications, next_cursor, notification_counts: { unread: 1 } })
const globalScope = { type: 'global' } as const
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('system notifications scope and synchronization', () => {
  test('a selected notification on a later page is reauthorized and retained after read refresh', async () => {
    const get = vi.fn().mockResolvedValue({ notification: { ...notice, revision: 2, read_at: '2026-10-12T01:00:00Z' } })
    const store = createSystemNotificationStore({ list: vi.fn().mockResolvedValue(page([])), read: vi.fn(), get })
    await store.markRead(notice)
    expect(get).toHaveBeenCalledWith('notice1', globalScope)
    expect(store.items.value[0]?.revision).toBe(2)
    get.mockRejectedValueOnce(new AttentionInboxApiError(404, { error: { code: 'notification_not_found' } }))
    await store.refresh()
    expect(store.items.value).toEqual([])
  })
  test('an old host response cannot reveal titles in a different host scope', async () => {
    const slow = deferred<SystemNotificationPage>()
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce(page([]))
    const store = createSystemNotificationStore({ list, read: vi.fn() })
    const first = store.refresh({ type: 'daemon', daemonId: 'old' })
    await store.refresh({ type: 'daemon', daemonId: 'new' })
    slow.resolve(page()); await first
    expect(store.items.value).toEqual([])
    expect(list.mock.calls[1][0]).toEqual({ type: 'daemon', daemonId: 'new' })
  })
  test('paginates notices without duplicate IDs and keeps authoritative unread total', async () => {
    const list = vi.fn().mockResolvedValueOnce(page([notice], 'cursor')).mockResolvedValueOnce(page([notice, { ...notice, notification_id: 'notice2' }]))
    const store = createSystemNotificationStore({ list, read: vi.fn() })
    await store.refresh(); await store.refresh(globalScope, true)
    expect(list.mock.calls[1][1]).toBe('cursor')
    expect(store.items.value).toHaveLength(2); expect(store.unread.value).toBe(1)
    expect(store.nextCursor.value).toBeNull()
  })
  test('revocation clears previews immediately and prevents cached display', async () => {
    const list = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new AttentionInboxApiError(403, { error: { code: 'forbidden' } }))
    const store = createSystemNotificationStore({ list, read: vi.fn() })
    await store.refresh(); expect(store.items.value).toHaveLength(1)
    await store.refresh(); expect(store.items.value).toEqual([]); expect(store.unread.value).toBe(0); expect(store.available.value).toBe(false)
  })
  test('stale read mutation reloads current revision without overwriting it', async () => {
    const read = vi.fn().mockRejectedValue(new AttentionInboxApiError(409, { error: { code: 'stale_revision' } }))
    const list = vi.fn().mockResolvedValue(page([{ ...notice, revision: 3, read_at: '2026-10-12T01:00:00Z' }]))
    const store = createSystemNotificationStore({ list, read })
    await store.markRead(notice)
    expect(read).toHaveBeenCalledWith('notice1', 1, globalScope)
    expect(store.items.value[0]?.revision).toBe(3)
  })
  test('removed notices do not resurrect from an older in-flight response', async () => {
    const slow = deferred<SystemNotificationPage>()
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(page([]))
    const store = createSystemNotificationStore({ list, read: vi.fn() })
    const pending = store.refresh()
    store.consume({ type: 'attention_notification_removed', notification_id: 'notice1', last_revision: 2 })
    slow.resolve(page()); await pending; await Promise.resolve()
    expect(store.items.value).toEqual([])
    expect(list).toHaveBeenCalledTimes(2)
  })
  test('stop invalidates pending auth generation and empties memory cache', async () => {
    const slow = deferred<SystemNotificationPage>()
    const store = createSystemNotificationStore({ list: vi.fn().mockReturnValue(slow.promise), read: vi.fn() })
    const pending = store.refresh(); store.stop(); slow.resolve(page()); await pending
    expect(store.items.value).toEqual([]); expect(store.available.value).toBe(false)
  })
})
