import { describe, expect, test } from 'vitest'
import { AuthLeaseManager } from '../ingress/auth-lease.js'

describe('AuthLeaseManager', () => {
  test('keeps a confirmed daemon during a short control-db outage', () => {
    let now = 1_000
    const lease = new AuthLeaseManager({
      leaseMs: 30_000,
      refreshMs: 10_000,
      now: () => now,
      jitter: () => 0,
    })

    lease.confirm('generation-1', now)
    now += 15_000

    expect(lease.onLookupUnavailable('generation-1', now)).toBe('keep')
  })

  test('expires fail closed after 30 seconds without authority', () => {
    let now = 1_000
    const lease = new AuthLeaseManager({
      leaseMs: 30_000,
      refreshMs: 10_000,
      now: () => now,
      jitter: () => 0,
    })

    lease.confirm('generation-1', now)
    now += 30_001

    expect(lease.onLookupUnavailable('generation-1', now)).toBe('expire')
  })

  test('refreshes at most once per refresh window after an unavailable lookup', () => {
    let now = 1_000
    const lease = new AuthLeaseManager({
      leaseMs: 30_000,
      refreshMs: 10_000,
      now: () => now,
      jitter: () => 0,
    })

    lease.confirm('generation-1', now)
    now += 10_000
    expect(lease.shouldRefresh('generation-1', now)).toBe(true)
    expect(lease.onLookupUnavailable('generation-1', now)).toBe('keep')
    expect(lease.shouldRefresh('generation-1', now)).toBe(false)
    now += 9_999
    expect(lease.shouldRefresh('generation-1', now)).toBe(false)
  })

  test('does not let a former registration authenticate a successor generation', () => {
    let now = 1_000
    const lease = new AuthLeaseManager({
      leaseMs: 30_000,
      refreshMs: 10_000,
      now: () => now,
      jitter: () => 0,
    })

    lease.confirm('former-generation', now)
    lease.remove('former-generation')

    expect(lease.onLookupUnavailable('former-generation', now)).toBe('expire')
  })

  test('never schedules an unavailable lookup refresh after authority expires', () => {
    let now = 0
    const lease = new AuthLeaseManager({ leaseMs: 30_000, refreshMs: 10_000, now: () => now, jitter: () => 20_000 })
    lease.confirm('generation-1')
    now = 15_000
    expect(lease.onLookupUnavailable('generation-1')).toBe('keep')
    now = 30_000
    expect(lease.shouldRefresh('generation-1')).toBe(true)
    expect(lease.isUsable('generation-1')).toBe(false)
  })
})
