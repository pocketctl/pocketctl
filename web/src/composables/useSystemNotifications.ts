import { ref } from 'vue'
import { AttentionInboxApiError, getSystemNotification, listSystemNotifications, markSystemNotificationRead } from '../services/attentionInboxClient'
import type { AttentionInboxScope, SystemNotification } from '../types/attentionInbox'
import { useWebSocket } from './useWebSocket'
import { deliverReconciledSessionDeletion } from './useWebSocket'
import { getRelayOrigin } from './useEnv'
import { useAuth } from './useAuth'

// Scope-specific, memory-only cache. A new scope/auth generation cannot receive an old response.
export function createSystemNotificationStore(api: { list: typeof listSystemNotifications; read: typeof markSystemNotificationRead; get?: typeof getSystemNotification } = { list: listSystemNotifications, read: markSystemNotificationRead, get: getSystemNotification }) {
  const items = ref<SystemNotification[]>([])
  const unread = ref(0)
  const available = ref(false)
  const error = ref('')
  const loading = ref(false)
  const nextCursor = ref<string | null>(null)
  let scope: AttentionInboxScope = { type: 'global' }
  let generation = 0
  let serial = 0
  let unsubscribe: (() => unknown) | undefined
  let invalidated = false
  const removedRevisions = new Map<string, number>()
  let pinnedID: string | undefined

  async function refresh(nextScope = scope, append = false) {
    if (append && (loading.value || !nextCursor.value)) return
    if (JSON.stringify(nextScope) !== JSON.stringify(scope)) {
      scope = nextScope
      items.value = []; unread.value = 0; nextCursor.value = null; available.value = false
      generation++
      removedRevisions.clear()
      pinnedID = undefined
    }
    const run = ++serial, current = generation
    const cursor = append ? nextCursor.value : null
    loading.value = true
    try {
      const page = await api.list(scope, cursor)
      const rows = [...page.notifications]
      if (!append && pinnedID && api.get && !page.notifications.some(item => item.notification_id === pinnedID)) {
        try { rows.push((await api.get(pinnedID, scope)).notification) }
        catch { /* Missing/revoked selected detail is removed with this snapshot. */ }
      }
      if (current !== generation || run !== serial) return
      const merged = new Map((append ? items.value : []).map(item => [item.notification_id, item]))
      for (const item of rows) {
        if ((removedRevisions.get(item.notification_id) ?? 0) >= item.revision) continue
        const old = merged.get(item.notification_id)
        if (!old || item.revision >= old.revision) merged.set(item.notification_id, item)
      }
      items.value = [...merged.values()]
      unread.value = page.notification_counts.unread
      nextCursor.value = page.next_cursor
      available.value = true; error.value = ''
    } catch (failure) {
      if (current !== generation || run !== serial) return
      // Reauthorization failures must immediately remove titles, previews, and counts.
      items.value = []; unread.value = 0; nextCursor.value = null
      available.value = !(failure instanceof AttentionInboxApiError && [401, 403, 404, 503].includes(failure.status))
      error.value = failure instanceof AttentionInboxApiError ? failure.code : 'request_failed'
    } finally {
      if (current === generation && run === serial) {
        loading.value = false
        if (invalidated) { invalidated = false; void refresh() }
      }
    }
  }

  async function markRead(item: SystemNotification) {
    pinnedID = item.notification_id
    if (item.read_at) return
    const current = generation, currentScope = scope
    try { await api.read(item.notification_id, item.revision, currentScope) }
    catch (failure) {
      if (!(failure instanceof AttentionInboxApiError && [404, 409].includes(failure.status))) {
        if (current === generation) error.value = 'request_failed'
      }
    }
    if (current === generation) await refresh()
  }

  function consume(event: { type?: string; notification_id?: string; last_revision?: number }) {
    if (event.type === 'auth_invalid' || event.type === 'auth_expired') { stop(); return }
    if (event.type === 'attention_notification_removed') {
      if (event.notification_id) removedRevisions.set(event.notification_id, event.last_revision ?? Number.MAX_SAFE_INTEGER)
      items.value = items.value.filter(item => item.notification_id !== event.notification_id)
    }
    if (['attention_notification_changed', 'attention_notification_removed', 'auth_ok', 'connected', 'session_deleted'].includes(event.type ?? '')) {
      if (loading.value) invalidated = true
      else void refresh()
    }
  }
  function start(nextScope: AttentionInboxScope) {
    const ws = useWebSocket()
    if (!unsubscribe) unsubscribe = ws.onEvent(consume)
    ws.connect()
    return refresh(nextScope)
  }
  function stop() {
    unsubscribe?.(); unsubscribe = undefined; generation++; serial++
    items.value = []; unread.value = 0; nextCursor.value = null; available.value = false; loading.value = false
    invalidated = false
    removedRevisions.clear()
    pinnedID = undefined
  }
  function pin(id?: string) { pinnedID = id }
  return { items, unread, available, error, loading, nextCursor, refresh, markRead, start, stop, consume, pin }
}
let globalStore:ReturnType<typeof createSystemNotificationStore>|undefined
export function useSystemNotifications(){return globalStore??=createSystemNotificationStore()}
let reconcileSerial=0
export function cancelDeletionReconciliation(){reconcileSerial++}
export async function reconcileSessionDeletions(){
  const serial=++reconcileSerial,{accessToken}=useAuth(),token=accessToken.value
  if(!token)return
  let cursor:string|null=null
  do{
    const endpoint=new URL(getRelayOrigin()+'/api/session-lifecycle/deletions',window.location.origin)
    if(cursor)endpoint.searchParams.set('cursor',cursor)
    const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(15000)})
    if(!response.ok)throw new Error('deletion reconciliation unavailable')
    const page=await response.json() as {session_ids:string[];next_cursor:string|null}
    if(serial!==reconcileSerial||accessToken.value!==token)return
    if(!Array.isArray(page.session_ids)||page.session_ids.some(id=>typeof id!=='string'||id.length>128))throw new Error('invalid deletion page')
    for(const id of page.session_ids)deliverReconciledSessionDeletion(id)
    if(page.next_cursor===cursor&&cursor!==null)throw new Error('deletion cursor did not advance')
    cursor=page.next_cursor
  }while(cursor)
}
