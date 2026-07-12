import { afterEach, describe, expect, test } from 'vitest'
import { quotaEnforcementMode, resolveEntitlements } from '../entitlements.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('resolveEntitlements', () => {
  test('defaults quota rollout to off and accepts observe/enforce only', () => {
    delete process.env.QUOTA_ENFORCEMENT
    expect(quotaEnforcementMode()).toBe('off')
    process.env.QUOTA_ENFORCEMENT = 'observe'
    expect(quotaEnforcementMode()).toBe('observe')
    process.env.QUOTA_ENFORCEMENT = 'enforce'
    expect(quotaEnforcementMode()).toBe('enforce')
    process.env.QUOTA_ENFORCEMENT = 'invalid'
    expect(quotaEnforcementMode()).toBe('off')
  })
  test('limits SaaS free users to two hosts and two active sessions', () => {
    expect(resolveEntitlements('free', false, 'saas')).toEqual({
      maxBoundDaemons: 2,
      maxConcurrentSessions: 2,
    })
  })

  test('treats non-free, whitelisted, and self-hosted users as unlimited', () => {
    expect(resolveEntitlements('pro', false, 'saas')).toEqual({
      maxBoundDaemons: null,
      maxConcurrentSessions: null,
    })
    expect(resolveEntitlements('free', true, 'saas').maxBoundDaemons).toBeNull()
    expect(resolveEntitlements('free', false, 'self-hosted').maxConcurrentSessions).toBeNull()
  })

  test('accepts positive environment overrides and rejects invalid ones', () => {
    process.env.FREE_MAX_BOUND_DAEMONS = '4'
    process.env.FREE_MAX_CONCURRENT_SESSIONS = '6'
    expect(resolveEntitlements('free', false, 'saas')).toEqual({
      maxBoundDaemons: 4,
      maxConcurrentSessions: 6,
    })

    process.env.FREE_MAX_BOUND_DAEMONS = '0'
    process.env.FREE_MAX_CONCURRENT_SESSIONS = 'not-a-number'
    expect(resolveEntitlements('free', false, 'saas')).toEqual({
      maxBoundDaemons: 2,
      maxConcurrentSessions: 2,
    })
  })
})
