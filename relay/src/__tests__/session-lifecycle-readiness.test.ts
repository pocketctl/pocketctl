import { describe, expect, test,vi } from 'vitest'
import { sessionLifecycleReadiness } from '../session-lifecycle/readiness.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { systemNotificationsEnabled } from '../attention-inbox/notification-routes.js'

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
})
