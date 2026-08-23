import { beforeEach, describe, expect, test } from 'vitest'
import { applyQuotaPayload, quotaStatus, quotaReached } from '../useQuota'

describe('useQuota', () => {
  beforeEach(() => { quotaStatus.value = null })

  test('hydrates free quota from a profile payload', () => {
    applyQuotaPayload({
      plan: 'free',
      quota: {
        resources: {
          bound_hosts: { used: 2, limit: 2, over_limit: false },
          concurrent_sessions: { used: 1, reserved: 0, limit: 2, over_limit: false },
        },
      },
    })
    expect(quotaStatus.value?.resources.bound_hosts.used).toBe(2)
    expect(quotaReached('bound_hosts')).toBe(true)
  })

  test('replaces state from a realtime quota_status payload and exposes over-limit', () => {
    applyQuotaPayload({
      type: 'quota_status', plan: 'free',
      resources: {
        bound_hosts: { used: 3, limit: 2, over_limit: true },
        concurrent_sessions: { used: 3, reserved: 0, limit: 2, over_limit: true },
      },
    })
    expect(quotaStatus.value?.resources.bound_hosts.over_limit).toBe(true)
    expect(quotaReached('concurrent_sessions')).toBe(true)
  })

  test('never reports unlimited resources as reached', () => {
    applyQuotaPayload({
      plan: 'pro',
      quota: {
        resources: {
          bound_hosts: { used: 8, limit: null, over_limit: false },
          concurrent_sessions: { used: 9, reserved: 0, limit: null, over_limit: false },
        },
      },
    })
    expect(quotaReached('bound_hosts')).toBe(false)
    expect(quotaReached('concurrent_sessions')).toBe(false)
  })
})
