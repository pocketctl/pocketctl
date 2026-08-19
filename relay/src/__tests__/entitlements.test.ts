import { afterEach, describe, expect, test } from 'vitest'
import { quotaEnforcementMode, resolveEntitlements, resolveQuotaEnforcementMode } from '../entitlements.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('resolveEntitlements', () => {
  test('defaults quota rollout to off in development and validates values strictly (M-4)', () => {
    delete process.env.QUOTA_ENFORCEMENT
    expect(quotaEnforcementMode()).toBe('off')
    process.env.QUOTA_ENFORCEMENT = 'observe'
    expect(quotaEnforcementMode()).toBe('observe')
    process.env.QUOTA_ENFORCEMENT = 'enforce'
    expect(quotaEnforcementMode()).toBe('enforce')
    // An invalid value no longer silently downgrades to off anywhere.
    process.env.QUOTA_ENFORCEMENT = 'invalid'
    expect(() => quotaEnforcementMode()).toThrow('QUOTA_ENFORCEMENT')
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


describe('quota enforcement startup contract (M-4)', () => {
  const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
    ({ NODE_ENV: 'development', POCKETCTL_MODE: 'saas', ...overrides }) as NodeJS.ProcessEnv

  test('development defaults to off and accepts every valid mode', () => {
    expect(resolveQuotaEnforcementMode(env({ QUOTA_ENFORCEMENT: undefined }))).toBe('off')
    expect(resolveQuotaEnforcementMode(env({ QUOTA_ENFORCEMENT: 'off' }))).toBe('off')
    expect(resolveQuotaEnforcementMode(env({ QUOTA_ENFORCEMENT: 'observe' }))).toBe('observe')
    expect(resolveQuotaEnforcementMode(env({ QUOTA_ENFORCEMENT: 'enforce' }))).toBe('enforce')
  })

  test('invalid values fail startup in every environment', () => {
    for (const bad of ['invalid', 'OFF', '1', 'true', ' ']) {
      expect(() => resolveQuotaEnforcementMode(env({ QUOTA_ENFORCEMENT: bad }))).toThrow('QUOTA_ENFORCEMENT')
    }
  })

  test('production SaaS accepts only enforce', () => {
    expect(resolveQuotaEnforcementMode(env({
      NODE_ENV: 'production', QUOTA_ENFORCEMENT: 'enforce',
    }))).toBe('enforce')
    for (const bad of [undefined, '', 'off', 'observe', 'enforce ']) {
      expect(() => resolveQuotaEnforcementMode(env({
        NODE_ENV: 'production', QUOTA_ENFORCEMENT: bad,
      }))).toThrow('QUOTA_ENFORCEMENT')
    }
  })

  test('production SaaS fails closed with an unset POCKETCTL_MODE too', () => {
    expect(() => resolveQuotaEnforcementMode({
      NODE_ENV: 'production',
      QUOTA_ENFORCEMENT: 'off',
    } as NodeJS.ProcessEnv)).toThrow('QUOTA_ENFORCEMENT')
    expect(() => resolveQuotaEnforcementMode({
      NODE_ENV: 'production',
      QUOTA_ENFORCEMENT: undefined as unknown as string,
    } as NodeJS.ProcessEnv)).toThrow('QUOTA_ENFORCEMENT')
  })

  test('production self-hosted may explicitly choose off, observe or enforce; missing still fails', () => {
    for (const mode of ['off', 'observe', 'enforce']) {
      expect(resolveQuotaEnforcementMode(env({
        NODE_ENV: 'production', POCKETCTL_MODE: 'self-hosted', QUOTA_ENFORCEMENT: mode,
      }))).toBe(mode)
    }
    expect(() => resolveQuotaEnforcementMode(env({
      NODE_ENV: 'production', POCKETCTL_MODE: 'self-hosted', QUOTA_ENFORCEMENT: undefined,
    }))).toThrow('QUOTA_ENFORCEMENT')
  })
})
