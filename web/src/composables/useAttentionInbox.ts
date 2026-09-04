import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  AttentionInboxApiError,
  listAttentionInbox,
  mutateAttentionItem,
  mutateAttentionRecovery,
  submitAttentionAction,
  type ListAttentionInboxInput,
  type MutateAttentionItemInput,
  type MutateAttentionRecoveryInput,
  type SubmitAttentionActionInput,
} from '../services/attentionInboxClient'
import type {
  AttentionActionID,
  AttentionInboxAction,
  AttentionInboxActionResponse,
  AttentionInboxCapabilities,
  AttentionInboxCounts,
  AttentionInboxItem,
  AttentionInboxItemResponse,
  AttentionInboxScope,
  AttentionInboxSnapshot,
  AttentionMetadataOperation,
  AttentionRecoveryItem,
  AttentionRecoveryResponse,
} from '../types/attentionInbox'
import { useWebSocket } from './useWebSocket'
import { createClientId } from '../utils/clientId'

export type AttentionLifecycleFilter = 'active' | 'snoozed' | 'handled'

interface AttentionInboxAPI {
  list(input: ListAttentionInboxInput): Promise<AttentionInboxSnapshot>
  mutate(input: MutateAttentionItemInput): Promise<AttentionInboxItemResponse>
  mutateRecovery?(input: MutateAttentionRecoveryInput): Promise<AttentionRecoveryResponse>
  submit(input: SubmitAttentionActionInput): Promise<AttentionInboxActionResponse>
}

interface AttentionInboxWebSocket {
  connect(): unknown
  onEvent(handler: (event: any) => void): () => unknown
}

interface AttentionInboxStoreDependencies {
  api: AttentionInboxAPI
  webSocket: AttentionInboxWebSocket
  uuid: () => string
}

export interface AttentionInboxStore {
  capabilities: Ref<AttentionInboxCapabilities>
  isAvailable: ComputedRef<boolean>
  isLoading: Ref<boolean>
  errorMessage: Ref<string>
  start(): Promise<void>
  stop(): void
  refresh(scope?: AttentionInboxScope): Promise<void>
  loadMore(scope?: AttentionInboxScope): Promise<void>
  hasMore(scope: AttentionInboxScope): boolean
  itemsFor(scope: AttentionInboxScope, filter: AttentionLifecycleFilter): AttentionInboxItem[]
  itemById(itemID: string): AttentionInboxItem | undefined
  recoveryItemsFor(scope: AttentionInboxScope, filter: AttentionLifecycleFilter): AttentionRecoveryItem[]
  recoveryById(recoveryID: string): AttentionRecoveryItem | undefined
  actionableCount(scope: AttentionInboxScope): number
  attentionCount(scope: AttentionInboxScope): number
  allowedActions(item: AttentionInboxItem): AttentionInboxAction[]
  markSeen(itemID: string): Promise<boolean>
  snooze(itemID: string, until: Date): Promise<boolean>
  restore(itemID: string): Promise<boolean>
  markRecoverySeen(recoveryID: string): Promise<boolean>
  snoozeRecovery(recoveryID: string, until: Date): Promise<boolean>
  restoreRecovery(recoveryID: string): Promise<boolean>
  submit(itemID: string, actionID: AttentionActionID, answers?: string[][]): Promise<boolean>
}

const disabledCapabilities: AttentionInboxCapabilities = {
  schema_version: 1,
  mode: 'off',
  enabled: false,
  remote_response_enabled: false,
  providers: {
    codex: { projection: false, remote_response: false },
    opencode: { projection: false, remote_response: false },
    'claude-code': { projection: false, remote_response: false },
  },
  recovery: { mode: 'off', projection: false, visible: false },
}

const allStates = ['open', 'snoozed', 'submitting', 'result_unknown', 'resolved', 'expired'] as const

function scopeKey(scope: AttentionInboxScope): string {
  return scope.type === 'global' ? 'global' : `daemon:${scope.daemonId}`
}

function prioritySort(left: AttentionInboxItem, right: AttentionInboxItem): number {
  const stateRank = { open: 0, result_unknown: 0, submitting: 1, snoozed: 2, resolved: 3, expired: 3 }
  const riskRank = { critical: 0, high: 1, medium: 2, low: 3 }
  const stateDelta = stateRank[left.state] - stateRank[right.state]
  if (stateDelta !== 0) return stateDelta
  const riskDelta = riskRank[left.risk.level] - riskRank[right.risk.level]
  if (riskDelta !== 0) return riskDelta
  const timeDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at)
  if (timeDelta !== 0) return timeDelta
  return right.item_id.localeCompare(left.item_id)
}

function lifecycleMatches(item: AttentionInboxItem, filter: AttentionLifecycleFilter): boolean {
  if (filter === 'active') return item.state === 'open' || item.state === 'submitting' || item.state === 'result_unknown'
  if (filter === 'snoozed') return item.state === 'snoozed'
  return item.state === 'resolved' || item.state === 'expired'
}

function recoveryLifecycleMatches(item: AttentionRecoveryItem, filter: AttentionLifecycleFilter): boolean {
  if (filter === 'active') return item.state === 'open'
  if (filter === 'snoozed') return item.state === 'snoozed'
  return item.state === 'resolved'
}

export function createAttentionInboxStore(dependencies: AttentionInboxStoreDependencies): AttentionInboxStore {
  const capabilities = ref<AttentionInboxCapabilities>(disabledCapabilities)
  const items = ref(new Map<string, AttentionInboxItem>())
  const recoveryItems = ref(new Map<string, AttentionRecoveryItem>())
  const cursors = new Map<string, string | null>()
  const counts = new Map<string, AttentionInboxCounts>()
  const scopes = new Map<string, AttentionInboxScope>()
  const isLoading = ref(false)
  const errorMessage = ref('')
  const inFlight = new Set<string>()
  const removedRevisions = new Map<string, number>()
  const removedRecoveryRevisions = new Map<string, number>()
  const latestScopeRequest = new Map<string, number>()
  let started = false
  let generation = 0
  let requestSequence = 0
  let unsubscribe: (() => unknown) | null = null

  const isAvailable = computed(() => capabilities.value.enabled)

  function matchesScope(item: AttentionInboxItem, scope: AttentionInboxScope): boolean {
    return scope.type === 'global' || item.daemon.id === scope.daemonId
  }

  function recoveryMatchesScope(item: AttentionRecoveryItem, scope: AttentionInboxScope): boolean {
    return scope.type === 'global' || item.daemon.id === scope.daemonId
  }

  function recoveryContribution(item: AttentionRecoveryItem | undefined): { open: number; snoozed: number } {
    return { open: item?.state === 'open' ? 1 : 0, snoozed: item?.state === 'snoozed' ? 1 : 0 }
  }

  function adjustRecoveryLoadedCounts(
    previous: AttentionRecoveryItem | undefined,
    current: AttentionRecoveryItem | undefined,
    skippedKeys: ReadonlySet<string> = new Set(),
  ): void {
    for (const [key, scope] of scopes) {
      if (skippedKeys.has(key)) continue
      adjustRecoveryCount(
        key,
        previous && recoveryMatchesScope(previous, scope) ? previous : undefined,
        current && recoveryMatchesScope(current, scope) ? current : undefined,
      )
    }
  }

  function adjustRecoveryCount(
    key: string,
    previous: AttentionRecoveryItem | undefined,
    current: AttentionRecoveryItem | undefined,
  ): void {
    const exact = counts.get(key)
    if (!exact) return
    const before = recoveryContribution(previous)
    const after = recoveryContribution(current)
    counts.set(key, {
      ...exact,
      recovery_open: Math.max(0, (exact.recovery_open ?? 0) - before.open + after.open),
      recovery_snoozed: Math.max(0, (exact.recovery_snoozed ?? 0) - before.snoozed + after.snoozed),
      ...(exact.attention_required !== undefined ? {
        attention_required: Math.max(0, exact.attention_required - before.open + after.open),
      } : {}),
    })
  }

  function upsertRecovery(item: AttentionRecoveryItem, skippedKeys: ReadonlySet<string> = new Set()): void {
    const removedRevision = removedRecoveryRevisions.get(item.recovery_id)
    if (removedRevision !== undefined && removedRevision >= item.revision) return
    const existing = recoveryItems.value.get(item.recovery_id)
    if (existing && existing.revision >= item.revision) return
    if (removedRevision !== undefined) removedRecoveryRevisions.delete(item.recovery_id)
    adjustRecoveryLoadedCounts(existing, item, skippedKeys)
    const next = new Map(recoveryItems.value)
    next.set(item.recovery_id, item)
    recoveryItems.value = next
  }

  function removeRecovery(
    recoveryID: string,
    lastRevision?: number,
    skippedKeys: ReadonlySet<string> = new Set(),
  ): void {
    const existing = recoveryItems.value.get(recoveryID)
    if (lastRevision !== undefined) {
      removedRecoveryRevisions.set(recoveryID, Math.max(lastRevision, removedRecoveryRevisions.get(recoveryID) ?? 0))
    }
    if (!existing || (lastRevision !== undefined && existing.revision > lastRevision)) return
    adjustRecoveryLoadedCounts(existing, undefined, skippedKeys)
    const next = new Map(recoveryItems.value)
    next.delete(recoveryID)
    recoveryItems.value = next
  }

  function contribution(item: AttentionInboxItem | undefined): AttentionInboxCounts {
    return {
      actionable: item && (item.state === 'open' || item.state === 'result_unknown') && item.allowed_actions.length > 0 ? 1 : 0,
      open: item?.state === 'open' ? 1 : 0,
      snoozed: item?.state === 'snoozed' ? 1 : 0,
      submitting: item?.state === 'submitting' ? 1 : 0,
      result_unknown: item?.state === 'result_unknown' ? 1 : 0,
    }
  }

  function adjustCount(key: string, previous: AttentionInboxItem | undefined, current: AttentionInboxItem | undefined): void {
    const exact = counts.get(key)
    if (!exact) return
    const before = contribution(previous)
    const after = contribution(current)
    counts.set(key, {
      ...exact,
      actionable: Math.max(0, exact.actionable - before.actionable + after.actionable),
      open: Math.max(0, exact.open - before.open + after.open),
      snoozed: Math.max(0, exact.snoozed - before.snoozed + after.snoozed),
      submitting: Math.max(0, exact.submitting - before.submitting + after.submitting),
      result_unknown: Math.max(0, exact.result_unknown - before.result_unknown + after.result_unknown),
      ...(exact.attention_required !== undefined ? {
        attention_required: Math.max(0, exact.attention_required - before.actionable + after.actionable),
      } : {}),
    })
  }

  function adjustLoadedCounts(
    previous: AttentionInboxItem | undefined,
    current: AttentionInboxItem | undefined,
    skippedKeys: ReadonlySet<string> = new Set(),
  ): void {
    for (const [key, scope] of scopes) {
      if (skippedKeys.has(key)) continue
      adjustCount(
        key,
        previous && matchesScope(previous, scope) ? previous : undefined,
        current && matchesScope(current, scope) ? current : undefined,
      )
    }
  }

  function upsert(item: AttentionInboxItem, adjustCounts = true, skippedCountKeys: ReadonlySet<string> = new Set()): void {
    const removedRevision = removedRevisions.get(item.item_id)
    if (removedRevision !== undefined && removedRevision >= item.revision) return
    const existing = items.value.get(item.item_id)
    if (existing && existing.revision >= item.revision) return
    if (removedRevision !== undefined) removedRevisions.delete(item.item_id)
    if (adjustCounts) adjustLoadedCounts(existing, item, skippedCountKeys)
    const next = new Map(items.value)
    next.set(item.item_id, item)
    items.value = next
  }

  function remove(itemID: string, lastRevision?: number, skippedCountKeys: ReadonlySet<string> = new Set()): void {
    const existing = items.value.get(itemID)
    if (lastRevision !== undefined) {
      removedRevisions.set(itemID, Math.max(lastRevision, removedRevisions.get(itemID) ?? 0))
    }
    if (!existing || (lastRevision !== undefined && existing.revision > lastRevision)) return
    adjustLoadedCounts(existing, undefined, skippedCountKeys)
    const next = new Map(items.value)
    next.delete(itemID)
    items.value = next
  }

  function syncLiveUpdates(): void {
    if (!started) return
    if (!capabilities.value.enabled) {
      unsubscribe?.()
      unsubscribe = null
      return
    }
    if (unsubscribe) return
    unsubscribe = dependencies.webSocket.onEvent(onEvent)
    dependencies.webSocket.connect()
  }

  async function refresh(scope: AttentionInboxScope = { type: 'global' }): Promise<void> {
    const requestGeneration = generation
    const key = scopeKey(scope)
    const requestID = ++requestSequence
    latestScopeRequest.set(key, requestID)
    const baselineRevisions = new Map(
      [...items.value.values()]
        .filter(item => matchesScope(item, scope))
        .map(item => [item.item_id, item.revision] as const),
    )
    const baselineRecoveryRevisions = new Map(
      [...recoveryItems.value.values()]
        .filter(item => recoveryMatchesScope(item, scope))
        .map(item => [item.recovery_id, item.revision] as const),
    )
    scopes.set(key, scope.type === 'global' ? { type: 'global' } : { type: 'daemon', daemonId: scope.daemonId })
    isLoading.value = true
    try {
      const snapshot = await dependencies.api.list({ scope, states: [...allStates], limit: 50 })
      if (requestGeneration !== generation || latestScopeRequest.get(key) !== requestID) return
      capabilities.value = snapshot.capabilities
      counts.set(key, snapshot.counts)
      cursors.set(key, snapshot.next_cursor)
      const snapshotRecoveryItems = snapshot.recovery_items ?? []
      const snapshotIDs = new Set(snapshot.items.map(item => item.item_id))
      const skippedCountKeys = new Set([key])
      for (const item of snapshot.items) {
        const removedRevision = removedRevisions.get(item.item_id)
        if (removedRevision !== undefined && removedRevision >= item.revision) {
          adjustCount(key, item, undefined)
          continue
        }
        const current = items.value.get(item.item_id)
        if (current && current.revision > item.revision) {
          adjustCount(key, item, current)
        } else {
          upsert(item, true, skippedCountKeys)
        }
      }
      for (const current of [...items.value.values()]) {
        if (!matchesScope(current, scope) || snapshotIDs.has(current.item_id)) continue
        const baselineRevision = baselineRevisions.get(current.item_id)
        if (baselineRevision !== undefined && current.revision <= baselineRevision) {
          remove(current.item_id, undefined, skippedCountKeys)
        } else {
          adjustCount(key, undefined, current)
        }
      }
      const snapshotRecoveryIDs = new Set(snapshotRecoveryItems.map(item => item.recovery_id))
      for (const recovery of snapshotRecoveryItems) {
        const removedRevision = removedRecoveryRevisions.get(recovery.recovery_id)
        if (removedRevision !== undefined && removedRevision >= recovery.revision) {
          adjustRecoveryCount(key, recovery, undefined)
          continue
        }
        const current = recoveryItems.value.get(recovery.recovery_id)
        if (current && current.revision > recovery.revision) {
          adjustRecoveryCount(key, recovery, current)
        } else {
          upsertRecovery(recovery, skippedCountKeys)
        }
      }
      for (const current of [...recoveryItems.value.values()]) {
        if (!recoveryMatchesScope(current, scope) || snapshotRecoveryIDs.has(current.recovery_id)) continue
        const baselineRevision = baselineRecoveryRevisions.get(current.recovery_id)
        if (baselineRevision !== undefined && current.revision <= baselineRevision) {
          removeRecovery(current.recovery_id, undefined, skippedCountKeys)
        } else {
          adjustRecoveryCount(key, undefined, current)
        }
      }
      syncLiveUpdates()
      errorMessage.value = ''
    } catch (error) {
      errorMessage.value = error instanceof AttentionInboxApiError ? error.message : 'Attention Inbox is unavailable'
    } finally {
      isLoading.value = false
    }
  }

  async function loadMore(scope: AttentionInboxScope = { type: 'global' }): Promise<void> {
    const requestGeneration = generation
    const key = scopeKey(scope)
    const cursor = cursors.get(key)
    if (!cursor || inFlight.has(`page:${key}`)) return
    const requestID = ++requestSequence
    latestScopeRequest.set(key, requestID)
    inFlight.add(`page:${key}`)
    try {
      const snapshot = await dependencies.api.list({ scope, states: [...allStates], cursor, limit: 50 })
      if (requestGeneration !== generation || latestScopeRequest.get(key) !== requestID) return
      capabilities.value = snapshot.capabilities
      counts.set(key, snapshot.counts)
      cursors.set(key, snapshot.next_cursor)
      const skippedCountKeys = new Set([key])
      for (const item of snapshot.items) {
        const removedRevision = removedRevisions.get(item.item_id)
        if (removedRevision !== undefined && removedRevision >= item.revision) {
          adjustCount(key, item, undefined)
          continue
        }
        const current = items.value.get(item.item_id)
        if (current && current.revision > item.revision) adjustCount(key, item, current)
        else upsert(item, true, skippedCountKeys)
      }
      for (const recovery of snapshot.recovery_items ?? []) {
        const removedRevision = removedRecoveryRevisions.get(recovery.recovery_id)
        if (removedRevision !== undefined && removedRevision >= recovery.revision) {
          adjustRecoveryCount(key, recovery, undefined)
          continue
        }
        const current = recoveryItems.value.get(recovery.recovery_id)
        if (current && current.revision > recovery.revision) adjustRecoveryCount(key, recovery, current)
        else upsertRecovery(recovery, skippedCountKeys)
      }
      errorMessage.value = ''
    } catch (error) {
      errorMessage.value = error instanceof AttentionInboxApiError ? error.message : 'Unable to load more items'
    } finally {
      inFlight.delete(`page:${key}`)
    }
  }

  function onEvent(event: any): void {
    if (event?.type === 'attention_item_changed' && event.item) {
      const item = event.item as AttentionInboxItem
      const existing = items.value.get(item.item_id)
      const uncertainScopes = new Map<string, AttentionInboxScope>()
      if (!existing) {
        for (const [key, scope] of scopes) {
          if (counts.has(key) && cursors.get(key) && matchesScope(item, scope)) uncertainScopes.set(key, scope)
        }
      }
      upsert(item, true, new Set(uncertainScopes.keys()))
      for (const scope of uncertainScopes.values()) void refresh(scope)
      return
    }
    if (event?.type === 'attention_item_removed' && typeof event.item_id === 'string') {
      const wasLoaded = items.value.has(event.item_id)
      remove(event.item_id, typeof event.last_revision === 'number' ? event.last_revision : undefined)
      if (!wasLoaded) {
        for (const [key, scope] of scopes) {
          if (counts.has(key) && cursors.get(key)) void refresh(scope)
        }
      }
      return
    }
    if (event?.type === 'attention_recovery_changed' && event.recovery) {
      upsertRecovery(event.recovery as AttentionRecoveryItem)
      return
    }
    if (event?.type === 'attention_recovery_removed' && typeof event.recovery_id === 'string') {
      removeRecovery(
        event.recovery_id,
        typeof event.last_revision === 'number' ? event.last_revision : undefined,
      )
      return
    }
    if (event?.type === 'connection_restored') {
      const loadedScopes = [...scopes.values()]
      void (async () => {
        for (const scope of loadedScopes) await refresh(scope)
      })()
    }
  }

  async function start(): Promise<void> {
    if (started) return
    started = true
    await refresh({ type: 'global' })
  }

  function stop(): void {
    unsubscribe?.()
    unsubscribe = null
    started = false
    generation += 1
    capabilities.value = disabledCapabilities
    items.value = new Map()
    recoveryItems.value = new Map()
    cursors.clear()
    counts.clear()
    scopes.clear()
    latestScopeRequest.clear()
    inFlight.clear()
    removedRevisions.clear()
    removedRecoveryRevisions.clear()
    isLoading.value = false
    errorMessage.value = ''
  }

  function allowedActions(item: AttentionInboxItem): AttentionInboxAction[] {
    if (item.state !== 'open' && item.state !== 'result_unknown') return []
    if (!capabilities.value.remote_response_enabled) return []
    if (!capabilities.value.providers[item.provider]?.remote_response) return []
    return item.allowed_actions
  }

  function itemsFor(scope: AttentionInboxScope, filter: AttentionLifecycleFilter): AttentionInboxItem[] {
    return [...items.value.values()]
      .filter(item => scope.type === 'global' || item.daemon.id === scope.daemonId)
      .filter(item => lifecycleMatches(item, filter))
      .sort(prioritySort)
  }

  function itemById(itemID: string): AttentionInboxItem | undefined {
    return items.value.get(itemID)
  }

  function recoveryItemsFor(scope: AttentionInboxScope, filter: AttentionLifecycleFilter): AttentionRecoveryItem[] {
    return [...recoveryItems.value.values()]
      .filter(item => recoveryMatchesScope(item, scope))
      .filter(item => recoveryLifecycleMatches(item, filter))
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
        || right.recovery_id.localeCompare(left.recovery_id))
  }

  function recoveryById(recoveryID: string): AttentionRecoveryItem | undefined {
    return recoveryItems.value.get(recoveryID)
  }

  function actionableCount(scope: AttentionInboxScope): number {
    const exact = counts.get(scopeKey(scope))
    if (exact) return exact.actionable
    return [...items.value.values()].filter(item =>
      (scope.type === 'global' || item.daemon.id === scope.daemonId)
      && (item.state === 'open' || item.state === 'result_unknown')
      && allowedActions(item).length > 0,
    ).length
  }

  function attentionCount(scope: AttentionInboxScope): number {
    const exact = counts.get(scopeKey(scope))
    if (exact) return exact.attention_required ?? exact.actionable + (exact.recovery_open ?? 0)
    return actionableCount(scope) + recoveryItemsFor(scope, 'active').length
  }

  function hasMore(scope: AttentionInboxScope): boolean {
    return Boolean(cursors.get(scopeKey(scope)))
  }

  function acceptError(error: unknown): void {
    if (error instanceof AttentionInboxApiError && error.item) upsert(error.item)
    errorMessage.value = error instanceof Error ? error.message : 'Attention Inbox request failed'
  }

  async function mutate(itemID: string, operation: AttentionMetadataOperation, snoozedUntil?: string): Promise<boolean> {
    const current = itemById(itemID)
    if (!current || inFlight.has(itemID)) return false
    const requestGeneration = generation
    inFlight.add(itemID)
    try {
      const response = await dependencies.api.mutate({
        itemId: itemID, expectedRevision: current.revision, operation, snoozedUntil,
      })
      if (requestGeneration !== generation) return false
      upsert(response.item)
      errorMessage.value = ''
      return true
    } catch (error) {
      if (requestGeneration !== generation) return false
      acceptError(error)
      return false
    } finally {
      inFlight.delete(itemID)
    }
  }

  async function submit(itemID: string, actionID: AttentionActionID, answers?: string[][]): Promise<boolean> {
    const current = itemById(itemID)
    if (!current || inFlight.has(itemID) || !allowedActions(current).some(action => action.id === actionID)) return false
    if (current.state !== 'open' && current.state !== 'result_unknown') return false
    const requestGeneration = generation
    inFlight.add(itemID)
    try {
      const response = await dependencies.api.submit({
        itemId: itemID,
        expectedRevision: current.revision,
        actionId: actionID,
        answers,
        idempotencyKey: dependencies.uuid(),
      })
      if (requestGeneration !== generation) return false
      upsert(response.item)
      errorMessage.value = ''
      return true
    } catch (error) {
      if (requestGeneration !== generation) return false
      acceptError(error)
      return false
    } finally {
      inFlight.delete(itemID)
    }
  }

  async function mutateRecovery(
    recoveryID: string,
    operation: AttentionMetadataOperation,
    snoozedUntil?: string,
  ): Promise<boolean> {
    const current = recoveryById(recoveryID)
    if (!current || !dependencies.api.mutateRecovery || inFlight.has(`recovery:${recoveryID}`)) return false
    const requestGeneration = generation
    inFlight.add(`recovery:${recoveryID}`)
    try {
      const response = await dependencies.api.mutateRecovery({
        recoveryId: recoveryID, expectedRevision: current.revision, operation, snoozedUntil,
      })
      if (requestGeneration !== generation) return false
      upsertRecovery(response.recovery)
      errorMessage.value = ''
      return true
    } catch (error) {
      if (requestGeneration !== generation) return false
      if (error instanceof AttentionInboxApiError && error.recovery) upsertRecovery(error.recovery)
      errorMessage.value = error instanceof Error ? error.message : 'Attention Inbox request failed'
      return false
    } finally {
      inFlight.delete(`recovery:${recoveryID}`)
    }
  }

  return {
    capabilities, isAvailable, isLoading, errorMessage,
    start, stop, refresh, loadMore, hasMore, itemsFor, itemById,
    recoveryItemsFor, recoveryById, actionableCount, attentionCount, allowedActions,
    markSeen: itemID => mutate(itemID, 'mark_seen'),
    snooze: (itemID, until) => mutate(itemID, 'snooze', until.toISOString()),
    restore: itemID => mutate(itemID, 'restore'),
    markRecoverySeen: recoveryID => mutateRecovery(recoveryID, 'mark_seen'),
    snoozeRecovery: (recoveryID, until) => mutateRecovery(recoveryID, 'snooze', until.toISOString()),
    restoreRecovery: recoveryID => mutateRecovery(recoveryID, 'restore'),
    submit,
  }
}

let singleton: AttentionInboxStore | null = null

export function useAttentionInbox(): AttentionInboxStore {
  if (!singleton) {
    const socket = useWebSocket()
    singleton = createAttentionInboxStore({
      api: {
        list: listAttentionInbox,
        mutate: mutateAttentionItem,
        mutateRecovery: mutateAttentionRecovery,
        submit: submitAttentionAction,
      },
      webSocket: { connect: socket.connect, onEvent: socket.onEvent as (handler: (event: any) => void) => () => unknown },
      uuid: createClientId,
    })
  }
  return singleton
}
