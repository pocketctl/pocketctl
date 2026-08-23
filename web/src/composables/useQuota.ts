import { computed, ref } from 'vue'

export type QuotaResourceName = 'bound_hosts' | 'concurrent_sessions'

export interface QuotaResource {
  used: number
  reserved?: number
  limit: number | null
  over_limit: boolean
}

export interface QuotaStatus {
  plan: string
  resources: Record<QuotaResourceName, QuotaResource>
}

export const quotaStatus = ref<QuotaStatus | null>(null)

export function applyQuotaPayload(payload: any): void {
  const source = payload?.quota ?? payload
  const resources = source?.resources
  if (!resources?.bound_hosts || !resources?.concurrent_sessions) return
  quotaStatus.value = {
    plan: payload?.plan || source?.plan || 'free',
    resources: {
      bound_hosts: resources.bound_hosts,
      concurrent_sessions: resources.concurrent_sessions,
    },
  }
}

export function quotaReached(resource: QuotaResourceName): boolean {
  const value = quotaStatus.value?.resources[resource]
  return !!value && value.limit !== null && value.used + (value.reserved || 0) >= value.limit
}

export function useQuota() {
  return {
    quotaStatus,
    boundHosts: computed(() => quotaStatus.value?.resources.bound_hosts ?? null),
    concurrentSessions: computed(() => quotaStatus.value?.resources.concurrent_sessions ?? null),
    quotaReached,
    applyQuotaPayload,
  }
}
