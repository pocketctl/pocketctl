import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AttentionInboxApiError } from '../../services/attentionInboxClient'
import type {
  AttentionInboxActionResponse,
  AttentionInboxItem,
  AttentionInboxItemResponse,
  AttentionInboxSnapshot,
  AttentionRecoveryItem,
  AttentionRecoveryResponse,
} from '../../types/attentionInbox'
import type { ListAttentionInboxInput } from '../../services/attentionInboxClient'
import { createAttentionInboxStore } from '../useAttentionInbox'

const baseItem: AttentionInboxItem = {
  item_id: 'item-high', revision: 4, provider: 'codex', kind: 'approval', state: 'open',
  risk: { level: 'high', classification_incomplete: true, reasons: [] },
  daemon: { id: 'daemon-1', display_name: 'Mac Studio' },
  session: { id: 'session-1', title: 'Deploy', status: 'waiting_approval' },
  request_id: 'request-1', title: 'Deploy production', summary: 'Approval request',
  context: { command: './deploy.sh' },
  allowed_actions: [
    { id: 'once', style: 'primary', destructive: false, label_key: 'attention.action.once' },
    { id: 'reject', style: 'danger', destructive: true, label_key: 'attention.action.reject' },
  ],
  seen_at: null, snoozed_until: null, submitted_at: null, resolved_at: null, handled_at: null,
  expires_at: null, resolution: null, last_error: null,
  created_at: '2026-08-12T01:00:00.000Z', updated_at: '2026-08-12T01:00:00.000Z',
}

const baseRecovery: AttentionRecoveryItem = {
  recovery_id: 'recovery-1', revision: 2, kind: 'recovery', state: 'open',
  reason_code: 'daemon_offline', daemon: { id: 'daemon-1', display_name: 'Mac Studio' },
  navigation: { type: 'host', daemon_id: 'daemon-1' },
  last_seen_at: '2026-08-12T01:00:00.000Z', seen_at: null, snoozed_until: null,
  resolved_at: null, handled_at: null, resolution: null,
  created_at: '2026-08-12T01:00:30.000Z', updated_at: '2026-08-12T01:00:30.000Z',
}

const enabledCapabilities: AttentionInboxSnapshot['capabilities'] = {
  schema_version: 2, mode: 'on', enabled: true, remote_response_enabled: true,
  providers: {
    codex: { projection: true, remote_response: true },
    opencode: { projection: true, remote_response: true },
    'claude-code': { projection: false, remote_response: false },
  },
  recovery: { mode: 'on', projection: true, visible: true },
}

function snapshot(
  items: AttentionInboxItem[],
  input: Partial<AttentionInboxSnapshot> = {},
): AttentionInboxSnapshot {
  return {
    schema_version: 2, server_time: '2026-08-12T01:00:00.000Z', capabilities: enabledCapabilities,
    scope: { type: 'global', daemon_id: null },
    counts: { actionable: items.filter(item => item.state === 'open').length, open: items.filter(item => item.state === 'open').length, snoozed: 0, submitting: 0, result_unknown: 0 },
    items, next_cursor: null, ...input,
  }
}

function harness(initial = snapshot([baseItem])) {
  let handler: ((event: any) => void) | null = null
  const list = vi.fn(async (_input: ListAttentionInboxInput) => initial)
  const mutate = vi.fn(async (): Promise<AttentionInboxItemResponse> => ({ item: { ...baseItem, revision: 5 } }))
  const mutateRecovery = vi.fn(async (): Promise<AttentionRecoveryResponse> => ({
    recovery: { ...baseRecovery, revision: 3, seen_at: '2026-08-12T02:00:00.000Z' },
  }))
  const submit = vi.fn(async (): Promise<AttentionInboxActionResponse> => ({
    outcome: 'submitted', item: { ...baseItem, revision: 5, state: 'submitting' }, final: false,
  }))
  const connect = vi.fn()
  const unsubscribe = vi.fn()
  const store = createAttentionInboxStore({
    api: { list, mutate, mutateRecovery, submit },
    webSocket: {
      connect,
      onEvent: vi.fn((next: (event: any) => void) => { handler = next; return unsubscribe }),
    },
    uuid: () => '33ee7974-f12a-4877-bbe9-00f2244e84ff',
  })
  return { store, list, mutate, mutateRecovery, submit, connect, unsubscribe, event: (value: any) => handler?.(value) }
}

beforeEach(() => vi.clearAllMocks())

describe('useAttentionInbox store', () => {
  test('keeps the feature unavailable and does not bind WebSocket when capability is disabled', async () => {
    const disabled = snapshot([], {
      capabilities: {
        ...enabledCapabilities, mode: 'off', enabled: false, remote_response_enabled: false,
        providers: {
          codex: { projection: false, remote_response: false },
          opencode: { projection: false, remote_response: false },
          'claude-code': { projection: false, remote_response: false },
        },
      },
    })
    const { store, connect } = harness(disabled)

    await store.start()

    expect(store.isAvailable.value).toBe(false)
    expect(connect).not.toHaveBeenCalled()
    expect(store.actionableCount({ type: 'global' })).toBe(0)
  })

  test('orders active items by state, risk, then newest update', async () => {
    const items: AttentionInboxItem[] = [
      { ...baseItem, item_id: 'medium', risk: { ...baseItem.risk, level: 'medium' }, updated_at: '2026-08-12T03:00:00.000Z' },
      { ...baseItem, item_id: 'critical-old', risk: { ...baseItem.risk, level: 'critical' }, updated_at: '2026-08-12T01:00:00.000Z' },
      { ...baseItem, item_id: 'submitting', state: 'submitting', risk: { ...baseItem.risk, level: 'critical' }, updated_at: '2026-08-12T04:00:00.000Z' },
      { ...baseItem, item_id: 'critical-new', risk: { ...baseItem.risk, level: 'critical' }, updated_at: '2026-08-12T02:00:00.000Z' },
    ]
    const { store } = harness(snapshot(items))
    await store.start()

    expect(store.itemsFor({ type: 'global' }, 'active').map(item => item.item_id))
      .toEqual(['critical-new', 'critical-old', 'medium', 'submitting'])
  })

  test('uses server scope counts even when only one page is loaded', async () => {
    const { store } = harness(snapshot([baseItem], {
      counts: { actionable: 12, open: 12, snoozed: 3, submitting: 1, result_unknown: 2 },
      next_cursor: 'page-2',
    }))
    await store.start()

    expect(store.actionableCount({ type: 'global' })).toBe(12)
  })

  test('keeps recovery identity separate and includes only open recovery in attention count', async () => {
    const current = snapshot([baseItem], {
      recovery_items: [baseRecovery, {
        ...baseRecovery, recovery_id: 'recovery-resolved', state: 'resolved', revision: 4,
        resolved_at: '2026-08-12T02:00:00.000Z', handled_at: '2026-08-12T02:00:00.000Z',
      }],
      counts: {
        actionable: 1, open: 1, snoozed: 0, submitting: 0, result_unknown: 0,
        recovery_open: 1, recovery_snoozed: 0, attention_required: 2,
      },
    })
    const { store } = harness(current)
    await store.start()

    expect(store.attentionCount({ type: 'global' })).toBe(2)
    expect(store.recoveryItemsFor({ type: 'global' }, 'active').map(item => item.recovery_id))
      .toEqual(['recovery-1'])
    expect(store.recoveryItemsFor({ type: 'global' }, 'handled').map(item => item.recovery_id))
      .toEqual(['recovery-resolved'])
    expect(store.itemById(baseRecovery.recovery_id)).toBeUndefined()
  })

  test('revision-checks recovery deltas and submits metadata through the recovery endpoint only', async () => {
    const { store, event, mutateRecovery, submit } = harness(snapshot([baseItem], {
      recovery_items: [baseRecovery],
      counts: {
        actionable: 1, open: 1, snoozed: 0, submitting: 0, result_unknown: 0,
        recovery_open: 1, recovery_snoozed: 0, attention_required: 2,
      },
    }))
    await store.start()

    event({ type: 'attention_recovery_changed', recovery: { ...baseRecovery, revision: 1, state: 'resolved' } })
    expect(store.recoveryById(baseRecovery.recovery_id)?.state).toBe('open')
    event({
      type: 'attention_recovery_changed',
      recovery: { ...baseRecovery, revision: 3, state: 'snoozed', snoozed_until: '2026-08-12T03:00:00.000Z' },
    })
    expect(store.recoveryById(baseRecovery.recovery_id)?.state).toBe('snoozed')

    const ok = await store.markRecoverySeen(baseRecovery.recovery_id)
    expect(ok).toBe(true)
    expect(mutateRecovery).toHaveBeenCalledWith({
      recoveryId: baseRecovery.recovery_id, expectedRevision: 3,
      operation: 'mark_seen', snoozedUntil: undefined,
    })
    expect(submit).not.toHaveBeenCalled()
  })

  test('updates exact server counts when a live item stops being actionable', async () => {
    const { store, event } = harness(snapshot([baseItem], {
      counts: { actionable: 12, open: 12, snoozed: 3, submitting: 1, result_unknown: 2 },
      next_cursor: 'page-2',
    }))
    await store.start()

    event({
      type: 'attention_item_changed',
      item: { ...baseItem, revision: 5, state: 'resolved', allowed_actions: [], resolved_at: '2026-08-12T02:00:00.000Z' },
    })

    expect(store.actionableCount({ type: 'global' })).toBe(11)
  })

  test('reconciles server counts when a live item was outside the loaded page', async () => {
    const unseenItem = { ...baseItem, item_id: 'outside-first-page', revision: 1 }
    const { store, list, event } = harness(snapshot([baseItem], {
      counts: { actionable: 12, open: 12, snoozed: 0, submitting: 0, result_unknown: 0 },
      next_cursor: 'page-2',
    }))
    await store.start()
    list.mockResolvedValueOnce(snapshot([baseItem, unseenItem], {
      counts: { actionable: 13, open: 13, snoozed: 0, submitting: 0, result_unknown: 0 },
      next_cursor: 'page-2',
    }))

    event({ type: 'attention_item_changed', item: unseenItem })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))

    expect(store.actionableCount({ type: 'global' })).toBe(13)
  })

  test('ignores lower revisions, accepts higher revisions, and removes retained items', async () => {
    const { store, event } = harness()
    await store.start()

    event({ type: 'attention_item_changed', item: { ...baseItem, revision: 3, title: 'stale' } })
    expect(store.itemById(baseItem.item_id)?.title).toBe('Deploy production')

    event({ type: 'attention_item_changed', item: { ...baseItem, revision: 5, title: 'current' } })
    expect(store.itemById(baseItem.item_id)?.title).toBe('current')

    event({ type: 'attention_item_removed', item_id: baseItem.item_id, last_revision: 5 })
    expect(store.itemById(baseItem.item_id)).toBeUndefined()
  })

  test('refreshes every loaded scope after the WebSocket reconnects', async () => {
    const { store, list, event } = harness()
    await store.start()
    list.mockResolvedValueOnce(snapshot([], { scope: { type: 'daemon', daemon_id: 'daemon-1' } }))
    await store.refresh({ type: 'daemon', daemonId: 'daemon-1' })
    list.mockClear()

    event({ type: 'connection_restored' })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))

    expect(list.mock.calls.map(call => call[0].scope)).toEqual([
      { type: 'global' },
      { type: 'daemon', daemonId: 'daemon-1' },
    ])
  })

  test('keeps a higher live revision and reconciles counts over a stale snapshot', async () => {
    const { store, list, event } = harness()
    await store.start()
    event({
      type: 'attention_item_changed',
      item: { ...baseItem, revision: 5, state: 'resolved', allowed_actions: [], resolved_at: '2026-08-12T02:00:00.000Z' },
    })
    expect(store.actionableCount({ type: 'global' })).toBe(0)
    list.mockResolvedValueOnce(snapshot([baseItem], {
      counts: { actionable: 1, open: 1, snoozed: 0, submitting: 0, result_unknown: 0 },
    }))

    await store.refresh({ type: 'global' })

    expect(store.itemById(baseItem.item_id)?.revision).toBe(5)
    expect(store.itemById(baseItem.item_id)?.state).toBe('resolved')
    expect(store.actionableCount({ type: 'global' })).toBe(0)
  })

  test('keeps a higher recovery delta and reconciles counts over a stale snapshot', async () => {
    let resolveSnapshot: ((value: AttentionInboxSnapshot) => void) | undefined
    const initial = snapshot([baseItem], {
      recovery_items: [baseRecovery],
      counts: {
        actionable: 1, open: 1, snoozed: 0, submitting: 0, result_unknown: 0,
        recovery_open: 1, recovery_snoozed: 0, attention_required: 2,
      },
    })
    const { store, list, event } = harness(initial)
    await store.start()
    list.mockImplementationOnce(() => new Promise<AttentionInboxSnapshot>(resolve => { resolveSnapshot = resolve }))

    const pendingRefresh = store.refresh({ type: 'global' })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    event({
      type: 'attention_recovery_changed',
      recovery: {
        ...baseRecovery, revision: 3, state: 'resolved',
        resolved_at: '2026-08-12T02:00:00.000Z', handled_at: '2026-08-12T02:00:00.000Z',
      },
    })
    resolveSnapshot?.(initial)
    await pendingRefresh

    expect(store.recoveryById(baseRecovery.recovery_id)?.revision).toBe(3)
    expect(store.recoveryById(baseRecovery.recovery_id)?.state).toBe('resolved')
    expect(store.attentionCount({ type: 'global' })).toBe(1)
  })

  test('does not resurrect removed recovery from a stale in-flight snapshot', async () => {
    let resolveSnapshot: ((value: AttentionInboxSnapshot) => void) | undefined
    const initial = snapshot([baseItem], {
      recovery_items: [baseRecovery],
      counts: {
        actionable: 1, open: 1, snoozed: 0, submitting: 0, result_unknown: 0,
        recovery_open: 1, recovery_snoozed: 0, attention_required: 2,
      },
    })
    const { store, list, event } = harness(initial)
    await store.start()
    list.mockImplementationOnce(() => new Promise<AttentionInboxSnapshot>(resolve => { resolveSnapshot = resolve }))

    const pendingRefresh = store.refresh({ type: 'global' })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    event({
      type: 'attention_recovery_removed', recovery_id: baseRecovery.recovery_id, last_revision: 2,
    })
    resolveSnapshot?.(initial)
    await pendingRefresh

    expect(store.recoveryById(baseRecovery.recovery_id)).toBeUndefined()
    expect(store.attentionCount({ type: 'global' })).toBe(1)
  })

  test('removes unchanged cached items omitted by a complete authoritative snapshot', async () => {
    const { store, list } = harness()
    await store.start()
    list.mockResolvedValueOnce(snapshot([], {
      counts: { actionable: 0, open: 0, snoozed: 0, submitting: 0, result_unknown: 0 },
      next_cursor: 'new-page-2',
    }))

    await store.refresh({ type: 'global' })

    expect(store.itemById(baseItem.item_id)).toBeUndefined()
    expect(store.hasMore({ type: 'global' })).toBe(true)
  })

  test('does not resurrect a removed item from a stale in-flight snapshot', async () => {
    let resolveSnapshot: ((value: AttentionInboxSnapshot) => void) | undefined
    const { store, list, event } = harness()
    await store.start()
    list.mockImplementationOnce(() => new Promise<AttentionInboxSnapshot>(resolve => { resolveSnapshot = resolve }))

    const pendingRefresh = store.refresh({ type: 'global' })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    event({ type: 'attention_item_removed', item_id: baseItem.item_id, last_revision: 4 })
    resolveSnapshot?.(snapshot([baseItem]))
    await pendingRefresh

    expect(store.itemById(baseItem.item_id)).toBeUndefined()
    expect(store.actionableCount({ type: 'global' })).toBe(0)
  })

  test('refreshes loaded counts when an unloaded retained item is removed', async () => {
    const { store, list, event } = harness(snapshot([baseItem], {
      counts: { actionable: 12, open: 12, snoozed: 0, submitting: 0, result_unknown: 0 },
      next_cursor: 'page-2',
    }))
    await store.start()
    list.mockResolvedValueOnce(snapshot([baseItem], {
      counts: { actionable: 11, open: 11, snoozed: 0, submitting: 0, result_unknown: 0 },
      next_cursor: 'page-2',
    }))

    event({ type: 'attention_item_removed', item_id: 'outside-first-page', last_revision: 8 })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))

    expect(store.actionableCount({ type: 'global' })).toBe(11)
  })

  test('binds live updates when a later refresh enables the feature', async () => {
    const disabled = snapshot([], {
      capabilities: {
        ...enabledCapabilities, mode: 'off', enabled: false, remote_response_enabled: false,
        providers: {
          codex: { projection: false, remote_response: false },
          opencode: { projection: false, remote_response: false },
          'claude-code': { projection: false, remote_response: false },
        },
      },
    })
    const { store, list, connect } = harness(disabled)
    await store.start()
    list.mockResolvedValueOnce(snapshot([baseItem]))

    await store.refresh({ type: 'global' })

    expect(store.isAvailable.value).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  test('clears account-scoped items and capability state when stopped', async () => {
    const { store, list } = harness()
    await store.start()

    store.stop()

    expect(store.isAvailable.value).toBe(false)
    expect(store.itemById(baseItem.item_id)).toBeUndefined()

    list.mockResolvedValueOnce(snapshot([{ ...baseItem, item_id: 'next-account-item' }]))
    await store.start()
    expect(store.itemById(baseItem.item_id)).toBeUndefined()
    expect(store.itemById('next-account-item')).toBeDefined()
  })

  test('ignores a snapshot that arrives after the account store is stopped', async () => {
    let resolveSnapshot: ((value: AttentionInboxSnapshot) => void) | undefined
    const { store, list } = harness()
    list.mockImplementationOnce(() => new Promise<AttentionInboxSnapshot>(resolve => { resolveSnapshot = resolve }))

    const pendingStart = store.start()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    store.stop()
    resolveSnapshot?.(snapshot([baseItem]))
    await pendingStart

    expect(store.isAvailable.value).toBe(false)
    expect(store.itemById(baseItem.item_id)).toBeUndefined()
  })

  test('ignores a metadata response that arrives after the account store is stopped', async () => {
    let resolveMutation: ((value: AttentionInboxItemResponse) => void) | undefined
    const { store, mutate } = harness()
    await store.start()
    mutate.mockImplementationOnce(() => new Promise<AttentionInboxItemResponse>(resolve => { resolveMutation = resolve }))

    const pendingMutation = store.markSeen(baseItem.item_id)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    store.stop()
    resolveMutation?.({ item: { ...baseItem, revision: 5, seen_at: '2026-08-12T02:00:00.000Z' } })

    expect(await pendingMutation).toBe(false)
    expect(store.isAvailable.value).toBe(false)
    expect(store.itemById(baseItem.item_id)).toBeUndefined()
  })

  test('loads an opaque daemon cursor without duplicating an existing live item', async () => {
    const first = snapshot([baseItem], { scope: { type: 'daemon', daemon_id: 'daemon-1' }, next_cursor: 'opaque-2' })
    const { store, list } = harness(first)
    await store.refresh({ type: 'daemon', daemonId: 'daemon-1' })
    expect(store.hasMore({ type: 'daemon', daemonId: 'daemon-1' })).toBe(true)
    list.mockResolvedValueOnce(snapshot([
      { ...baseItem, revision: 5, title: 'updated live row' },
      { ...baseItem, item_id: 'item-page-2', revision: 1 },
    ], { scope: { type: 'daemon', daemon_id: 'daemon-1' } }))

    await store.loadMore({ type: 'daemon', daemonId: 'daemon-1' })

    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'opaque-2' }))
    expect(store.itemsFor({ type: 'daemon', daemonId: 'daemon-1' }, 'active').map(item => item.item_id).sort())
      .toEqual(['item-high', 'item-page-2'])
    expect(store.itemById('item-high')?.revision).toBe(5)
    expect(store.hasMore({ type: 'daemon', daemonId: 'daemon-1' })).toBe(false)
  })

  test('requires global, provider, and item action capabilities', async () => {
    const claude = { ...baseItem, item_id: 'claude', provider: 'claude-code' as const }
    const { store } = harness(snapshot([baseItem, claude]))
    await store.start()

    expect(store.allowedActions(baseItem).map(action => action.id)).toEqual(['once', 'reject'])
    expect(store.allowedActions(claude)).toEqual([])
    expect(store.allowedActions({ ...baseItem, state: 'snoozed' })).toEqual([])
    expect(store.allowedActions({ ...baseItem, state: 'resolved' })).toEqual([])
  })

  test('replaces a stale local item with the server current item', async () => {
    const { store, mutate } = harness()
    await store.start()
    mutate.mockRejectedValueOnce(new AttentionInboxApiError(409, {
      error: {
        code: 'stale_revision', message: 'stale', retryable: true,
        current_item: { ...baseItem, revision: 8, state: 'resolved' },
      },
    }))

    const ok = await store.markSeen(baseItem.item_id)

    expect(ok).toBe(false)
    expect(store.itemById(baseItem.item_id)?.revision).toBe(8)
    expect(store.itemById(baseItem.item_id)?.state).toBe('resolved')
  })

  test('submits one explicit action with revision and a fresh idempotency key', async () => {
    const { store, submit } = harness()
    await store.start()

    const ok = await store.submit(baseItem.item_id, 'once')

    expect(ok).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith({
      itemId: baseItem.item_id,
      expectedRevision: 4,
      actionId: 'once',
      answers: undefined,
      idempotencyKey: '33ee7974-f12a-4877-bbe9-00f2244e84ff',
    })
    expect(store.itemById(baseItem.item_id)?.state).toBe('submitting')
  })
})
