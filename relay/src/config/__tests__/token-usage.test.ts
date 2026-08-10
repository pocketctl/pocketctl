import { afterEach, describe, expect, test } from 'vitest'
import {
  assertTokenUsageFeatureDependencies,
  tokenUsageFeatures,
  useFactAuthoritativeSessionDeletion,
} from '../token-usage.js'

const names = [
  'TOKEN_USAGE_FACTS_WRITE',
  'TOKEN_USAGE_SHADOW_READ',
  'TOKEN_USAGE_DASHBOARD_V2',
] as const

afterEach(() => {
  for (const name of names) delete process.env[name]
})

describe('token usage feature gates', () => {
  test('are all disabled by default and require an explicit true value', () => {
    expect(tokenUsageFeatures()).toEqual({ writeFacts: false, shadowRead: false, dashboardV2: false })

    process.env.TOKEN_USAGE_FACTS_WRITE = 'true'
    process.env.TOKEN_USAGE_SHADOW_READ = 'TRUE'
    process.env.TOKEN_USAGE_DASHBOARD_V2 = ' false '
    expect(tokenUsageFeatures()).toEqual({ writeFacts: true, shadowRead: true, dashboardV2: false })
  })

  test('rejects read or shadow rollout before immutable fact writing is enabled', () => {
    expect(() => assertTokenUsageFeatureDependencies({ writeFacts: false, shadowRead: true, dashboardV2: false }))
      .toThrow('TOKEN_USAGE_FACTS_WRITE=true')
    expect(() => assertTokenUsageFeatureDependencies({ writeFacts: false, shadowRead: false, dashboardV2: true }))
      .toThrow('TOKEN_USAGE_FACTS_WRITE=true')
    expect(() => assertTokenUsageFeatureDependencies({ writeFacts: true, shadowRead: true, dashboardV2: true }))
      .not.toThrow()
  })

  test('requires fully durable ingress before immutable fact writing can start', () => {
    const features = { writeFacts: true, shadowRead: false, dashboardV2: false }
    expect(() => assertTokenUsageFeatureDependencies(features, 'off'))
      .toThrow('RELAY_DURABLE_INGRESS=on')
    expect(() => assertTokenUsageFeatureDependencies(features, 'canary'))
      .toThrow('RELAY_DURABLE_INGRESS=on')
    expect(() => assertTokenUsageFeatureDependencies(features, 'on')).not.toThrow()
  })

  test('keeps legacy deletion compensation through write and shadow stages', () => {
    expect(useFactAuthoritativeSessionDeletion({ writeFacts: true, shadowRead: false, dashboardV2: false })).toBe(false)
    expect(useFactAuthoritativeSessionDeletion({ writeFacts: true, shadowRead: true, dashboardV2: false })).toBe(false)
    expect(useFactAuthoritativeSessionDeletion({ writeFacts: true, shadowRead: false, dashboardV2: true })).toBe(true)
  })
})
