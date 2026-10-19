import { describe, expect, test,vi } from 'vitest'
import { sessionLifecycleReadiness } from '../session-lifecycle/readiness.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { systemNotificationsEnabled } from '../attention-inbox/notification-routes.js'
import { releasedConfig, releaseFixture } from './session-lifecycle-release-fixture.js'

describe('enabled defaults and truthful lifecycle readiness', () => {
  test('notifications default on and retain an explicit off switch', () => {
    expect(systemNotificationsEnabled({})).toBe(true)
    expect(
      systemNotificationsEnabled({ ATTENTION_SYSTEM_NOTIFICATIONS: 'off' }),
    ).toBe(false)
  })
  test('an enabled configuration never attests missing execution/read integrations', () => {
    const status = sessionLifecycleReadiness(sessionLifecycleConfig({}))
    expect(status).toMatchObject({
      configured_mode: 'enforce',
      enabled: true,
      execution_ready: false,
    })
    expect(status.blockers).toContain('policy_not_effective')
    expect(status.blockers).toContain('object_reader_not_configured')
  })
  test('off is distinguishable from enabled but incomplete', () => {
    expect(
      sessionLifecycleReadiness(
        sessionLifecycleConfig({ SESSION_LIFECYCLE_MODE: 'off' }),
      ),
    ).toMatchObject({
      configured_mode: 'off',
      enabled: false,
      execution_ready: false,
    })
  })
  test('production automatic actions remain blocked until release gates are completed',()=>{
    vi.stubEnv('NODE_ENV','production')
    try{
      const status=sessionLifecycleReadiness(sessionLifecycleConfig({SESSION_LIFECYCLE_EFFECTIVE_AT:'2026-01-01T00:00:00Z',SESSION_LIFECYCLE_TRANSITION_DEADLINE:'2026-01-01T00:00:00Z'}),true)
      expect(status.execution_ready).toBe(false)
      expect(status.blockers).toContain('production_release_not_ready')
    }finally{vi.unstubAllEnvs()}
  })
  test('a version-bound published production release becomes executable with installed storage', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const status = sessionLifecycleReadiness(releasedConfig('fixture-storage'), { namespace: 'fixture-storage' })
      expect(status).toMatchObject({ execution_ready: true, production_release_ready: true, blockers: [] })
    } finally { vi.unstubAllEnvs() }
  })
  test.each([
    [{ policyVersion: 'other-policy' }, 'release_policy_mismatch'],
    [{ effectiveAt: '2026-01-02T00:00:00Z' }, 'release_dates_mismatch'],
    [{ transitionDeadline: '2026-02-02T00:00:00Z' }, 'release_dates_mismatch'],
    [{ storageNamespace: 'other-storage' }, 'release_storage_mismatch'],
    [{ publishedAt: '2099-01-01T00:00:00Z' }, 'release_not_published'],
    [{ evidence: { ...releaseFixture('fixture-storage').evidence, legal_publication: '' } }, 'legal_publication'],
  ])('production release rejects inconsistent or incomplete evidence %j', (patch, reason) => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const status = sessionLifecycleReadiness(releasedConfig('fixture-storage', patch), { namespace: 'fixture-storage' })
      expect(status.execution_ready).toBe(false)
      expect(status.release_blockers).toContain(reason)
    } finally { vi.unstubAllEnvs() }
  })
  test('all missing runtime prerequisites are reported even when production release evidence is absent', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      expect(sessionLifecycleReadiness(sessionLifecycleConfig({})).blockers).toEqual([
        'object_reader_not_configured', 'policy_not_effective',
        'historical_transition_not_configured', 'production_release_not_ready',
      ])
    } finally { vi.unstubAllEnvs() }
  })
  test('a published release cannot execute before its effective time', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const config = releasedConfig('fixture-storage', {
        effectiveAt: '2099-01-01T00:00:00Z', transitionDeadline: '2099-02-01T00:00:00Z',
      }, { SESSION_LIFECYCLE_EFFECTIVE_AT: '2099-01-01T00:00:00Z', SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2099-02-01T00:00:00Z' })
      expect(sessionLifecycleReadiness(config, { namespace: 'fixture-storage' }).blockers).toContain('policy_not_effective')
    } finally { vi.unstubAllEnvs() }
  })
  test('production policy cannot predate its formal publication', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const status = sessionLifecycleReadiness(releasedConfig('fixture-storage', { publishedAt: '2026-01-02T00:00:00Z' }), { namespace: 'fixture-storage' })
      expect(status.execution_ready).toBe(false)
      expect(status.release_blockers).toContain('policy_before_publication')
    } finally { vi.unstubAllEnvs() }
  })
  test('published policy supports no additional historical transition while retaining other release gates', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const config = releasedConfig('fixture-storage', { transitionDeadline: '2026-01-01T00:00:00Z' },
        { SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-01-01T00:00:00Z' })
      expect(sessionLifecycleReadiness(config, { namespace: 'fixture-storage' }).execution_ready).toBe(true)
      const missingClient = { ...config, release: { ...config.release!, evidence: { ...config.release!.evidence, production_client_release: undefined } } }
      expect(sessionLifecycleReadiness(missingClient, { namespace: 'fixture-storage' }).release_blockers).toContain('production_client_release')
      const earlier = { ...config, release: { ...config.release!, transitionDeadline: '2025-12-31T23:59:59.999999Z' } }
      expect(sessionLifecycleReadiness(earlier, { namespace: 'fixture-storage' }).release_blockers).toContain('historical_transition_before_effective')
      const delayed = releasedConfig('fixture-storage', { transitionDeadline: '2026-01-31T00:00:00Z' },
        { SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-01-31T00:00:00Z' })
      expect(sessionLifecycleReadiness(delayed, { namespace: 'fixture-storage' }).execution_ready).toBe(true)
    } finally { vi.unstubAllEnvs() }
  })
})
