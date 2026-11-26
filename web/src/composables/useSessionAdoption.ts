import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useWebSocket } from './useWebSocket'

type Action = 'adopt' | 'wait' | 'cancel' | 'unarchive' | 'query'
interface Receipt {
  version: number
  session_id: string
  operation_id?: string
  revision: number
  phase: string
  reason: string
  allowed_actions?: Action[]
  local_managed?: boolean
  remote_ready?: boolean
  start_enabled?: boolean
  archive_changed?: boolean
}

// Scope contains account, Relay, original host and session. Losing any of
// these identities clears confirmations and rejects late replies immediately.
export function useSessionAdoption(scope: Ref<string>, session: Ref<string>, writable: Ref<boolean>,
  refresh: () => void, fresh: Ref<boolean>) {
  const { send, onEvent, connected } = useWebSocket()
  const online = computed(() => connected.value && fresh.value)
  const receipt = ref<Receipt>()
  const pending = ref('')
  const error = ref('')
  const confirmed = ref(false)
  const notice = ref(false)
  const requiresProof = ref(false)
  const verified = computed(() => receipt.value?.phase === 'managed' && receipt.value.reason === 'managed'
    && receipt.value.local_managed === true && receipt.value.remote_ready === true && !error.value)
  const blocksComposer = computed(() => requiresProof.value && !verified.value)
  const ready = computed(() => writable.value && !blocksComposer.value)
  const unresolvedRequest = '?'
  // Only opaque IDs for this tab are retained; the host owns deadlines and work.
  const trackingKey = () => 'session-adoption-v1:' + scope.value
  function trackedOperation() {
    try { return sessionStorage.getItem(trackingKey()) || '' } catch { return '' }
  }
  function track(operation: string) {
    try {
      if (operation) sessionStorage.setItem(trackingKey(), operation)
      else sessionStorage.removeItem(trackingKey())
    } catch { /* in-memory receipt still permits reconciliation */ }
  }
  let expectedOperation = ''
  let operationStarted = false
  let backgroundProofChecks = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  const denied = computed(() => ['forbidden','unsupported_source','subsession'].includes(error.value || receipt.value?.reason || ''))
  const state = computed(() => {
    if (error.value) return error.value
    if (pending.value && !receipt.value) return 'checking'
    const r = receipt.value
    if (!r) return 'checking'
    if (r.start_enabled === false && r.phase === 'available') return 'remote_start_paused'
    if (['waiting','checking','binding','managed','cancelled','expired'].includes(r.phase)) return r.phase
    return r.reason
  })
  const actions = computed<Action[]>(() => {
    if (!scope.value || !online.value || ready.value || denied.value || (pending.value && mutating)) return []
    if (error.value) return ['query']
    if (writable.value && blocksComposer.value) return pending.value ? [] : ['query']
    if (!receipt.value) return []
    if (receipt.value.phase === 'managed') return ['query']
    const allowed = receipt.value.allowed_actions || []
    if (receipt.value.phase === 'waiting' && receipt.value.operation_id && allowed.includes('cancel')) return ['cancel']
    if (receipt.value.start_enabled === false)
      return ['checking','binding','waiting'].includes(receipt.value.phase) ? [] : ['query']
    if (receipt.value.reason === 'archived' && allowed.includes('unarchive')) return ['unarchive']
    if (receipt.value.reason === 'active_writer' && allowed.includes('wait')) return ['wait']
    if (['available','blocked','failed','cancelled','expired'].includes(receipt.value.phase) && allowed.includes('adopt')) return ['adopt']
    return ['checking','binding','waiting'].includes(receipt.value.phase) ? [] : ['query']
  })
  let mutating = false
  function schedule(ms: number, callback: () => void) {
    clearTimeout(timer)
    timer = setTimeout(callback, ms)
  }
  function issue(action: Action) {
    if (!scope.value || !online.value || ready.value) return
    if (action !== 'query' && !actions.value.includes(action)) return
    if (pending.value && (mutating || action === 'query')) return
    clearTimeout(timer)
    if (action !== 'query') confirmed.value = false
    const requestId = crypto.randomUUID()
    expectedOperation = action === 'cancel' ? receipt.value?.operation_id || ''
      : action === 'query' ? trackedOperation() || (receipt.value && ['waiting','checking','binding'].includes(receipt.value.phase) ? receipt.value.operation_id || '' : '') : ''
    if (expectedOperation === unresolvedRequest) expectedOperation = ''
    if (action === 'cancel' && !expectedOperation) return
    mutating = action !== 'query'
    if (mutating) {
      operationStarted = true
      requiresProof.value = true
      track(expectedOperation || unresolvedRequest)
      receipt.value = undefined
    }
    pending.value = requestId
    error.value = ''
    const sent = send({ type: action === 'query' ? 'session_adopt_status' : action === 'cancel' ? 'session_adopt_cancel' : 'session_adopt',
      session_id:session.value, request_id:requestId, ...(expectedOperation ? { operation_id:expectedOperation } : {}),
      ...(action === 'wait' ? {wait_ms:120000} : {}), ...(action === 'unarchive' ? {unarchive:true} : {}) })
    if (sent) schedule(16500, () => { pending.value = ''; mutating = false; error.value = 'unverified' })
    else { pending.value = ''; mutating = false; error.value = 'unverified' }
  }
  const off = onEvent('session_adoption_result', (frame: any) => {
    if (!scope.value || frame.session_id !== session.value || !pending.value || frame.request_id !== pending.value) return
    clearTimeout(timer)
    pending.value = ''
    mutating = false
    const r = frame.adoption as Receipt | undefined
    if (frame.error || !r || r.version !== 1 || r.session_id !== session.value || !Number.isSafeInteger(r.revision)
      || (r.phase === 'managed' && (r.reason !== 'managed' || r.local_managed !== true))
      || (expectedOperation && expectedOperation !== r.operation_id)) {
      confirmed.value = false
      error.value = ['forbidden','unsupported_source','daemon_offline','daemon_upgrade_required','remote_start_paused'].includes(frame.error) ? frame.error : 'unverified'
      // A missing host grant and revoked read access share the same envelope.
      // Refresh the normal scoped session summary to apply its read decision.
      if (error.value === 'forbidden') refresh()
      // Older daemons still own valid managed sessions. Their normal fresh
      // capabilities may arrive after an initially incomplete session row.
      if (error.value === 'daemon_upgrade_required' && !operationStarted && !trackedOperation())
        requiresProof.value = false
      return
    }
    const previous = receipt.value
    if (!previous || !previous.operation_id || previous.operation_id !== r.operation_id || r.revision >= previous.revision) {
      if (previous?.operation_id !== r.operation_id || previous?.revision !== r.revision || !r.allowed_actions?.includes('unarchive')) confirmed.value = false
      const active = ['checking','binding','waiting'].includes(r.phase) || (r.phase === 'managed' && r.remote_ready !== true)
      track(active ? r.operation_id || unresolvedRequest : '')
      receipt.value = r
      error.value = ''
    }
    if (receipt.value?.phase === 'managed' && (!writable.value || !verified.value)) refresh()
    if (!denied.value && !ready.value && scope.value) {
      const needsProof = writable.value && blocksComposer.value
      // A different client can finish a new adoption while an exact query for
      // the previous wait is in flight. Its terminal receipt releases that ID.
      if (needsProof && expectedOperation && ['cancelled','expired','blocked','failed'].includes(receipt.value?.phase || '')) {
        issue('query')
        return
      }
      const fast = needsProof || ['checking','waiting','binding','managed'].includes(receipt.value?.phase || '')
      schedule(fast ? 1500 : 15000, () => {
        if (document.visibilityState !== 'visible') {
          if (!writable.value || !blocksComposer.value || backgroundProofChecks === 0) return
          backgroundProofChecks--
        }
        issue('query')
      })
    }
  })
  function reset() {
    clearTimeout(timer)
    clearTimeout(feedbackTimer)
    receipt.value = undefined
    expectedOperation = ''
    pending.value = ''
    mutating = false
    operationStarted = false
    backgroundProofChecks = 0
    requiresProof.value = false
    confirmed.value = false
    notice.value = false
    error.value = ''
  }
  watch(scope, () => {
    reset()
    if (scope.value && (!writable.value || trackedOperation())) {
      requiresProof.value = true
      if (online.value) issue('query')
    }
  }, {immediate:true, flush:'sync'})
  watch(online, isOnline => {
    clearTimeout(timer)
    confirmed.value = false
    pending.value = ''
    mutating = false
    if (isOnline) issue('query')
    else {
      receipt.value = undefined
      error.value = 'unverified'
    }
  })
  watch(writable, write => {
    if (!scope.value) return
    // A newly writable row warrants a short read-only reconciliation even
    // when this tab is behind the client that initiated the newer operation.
    backgroundProofChecks = write ? 3 : 0
    if (!write) {
      if (verified.value) receipt.value = undefined
      requiresProof.value = true
    }
    if (!ready.value && !pending.value) issue('query')
  })
  watch(ready, nowReady => {
    if (!scope.value || !nowReady) return
    clearTimeout(timer)
    requiresProof.value = false
    track('')
    confirmed.value = false
    if (operationStarted || receipt.value?.operation_id) {
      notice.value = true
      feedbackTimer = setTimeout(() => { notice.value = false }, 3000)
    }
  })
  function focus() { if (document.visibilityState === 'visible' && !pending.value && !confirmed.value) issue('query') }
  function visibilityChanged() {
    if (document.visibilityState === 'hidden') confirmed.value = false
    else focus()
  }
  document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('focus', focus)
  onBeforeUnmount(() => { reset(); off(); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('focus', focus) })
  return { receipt, state, actions, confirmed, denied, notice, blocksComposer, issue }
}
