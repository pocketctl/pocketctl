import { computed, ref, shallowRef, type Ref } from 'vue'
import { useAuth } from './useAuth'
import { getTeamCapabilities, TeamApiError } from '../services/teamClient'
import type { TeamCapabilities } from '../types/team'

export function createTeamAccessController(token: Ref<string>, load: () => Promise<TeamCapabilities>) {
  const snapshot = shallowRef<TeamCapabilities | null>(null)
  const snapshotToken = ref('')
  const checkedToken = ref('')
  let generation = 0
  let pending: { token: string; promise: Promise<boolean> } | undefined
  const capabilities = computed(() => token.value && token.value === snapshotToken.value ? snapshot.value : null)
  const enabled = computed(() => (capabilities.value?.collaboration === true || capabilities.value?.reads_enabled === true))
  // A new token invalidates the old grant, but is not a confirmed denial.
  const denied = computed(() => !!token.value && checkedToken.value === token.value && !enabled.value)
  function refresh(): Promise<boolean> {
    const currentToken = token.value
    if (!currentToken) {
      generation++
      snapshotToken.value = ''; checkedToken.value = ''; snapshot.value = null; pending = undefined
      return Promise.resolve(false)
    }
    if (pending?.token === currentToken) return pending.promise
    const requestGeneration = ++generation
    const promise = (async () => {
      try {
        const response = await load()
        if (generation !== requestGeneration || token.value !== currentToken) return false
        snapshotToken.value = currentToken; snapshot.value = response
        checkedToken.value = currentToken
        return enabled.value
      } catch (failure) {
        // Transport failure is not revocation. Keep only the grant already
        // verified for this exact token; a new account remains unconfirmed.
        if (generation === requestGeneration && token.value === currentToken && failure instanceof TeamApiError && [401, 403, 404].includes(failure.status)) {
          snapshotToken.value = ''; snapshot.value = null
          checkedToken.value = currentToken
        }
        return generation === requestGeneration && token.value === currentToken && enabled.value
      }
    })().finally(() => { if (pending?.promise === promise) pending = undefined })
    pending = { token: currentToken, promise }
    return promise
  }
  return { enabled, denied, capabilities, refresh }
}

let shared: ReturnType<typeof createTeamAccessController> | undefined
export function useTeamAccess() {
  if (!shared) shared = createTeamAccessController(useAuth().accessToken, getTeamCapabilities)
  return shared
}
