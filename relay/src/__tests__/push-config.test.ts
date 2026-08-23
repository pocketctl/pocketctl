import { describe, expect, test } from 'vitest'
import { resolveAPNsConfig } from '../push.js'

describe('resolveAPNsConfig', () => {
  test('rejects production configuration with missing APNs credentials', () => {
    const config = resolveAPNsConfig({ NODE_ENV: 'production' })

    expect(config.enabled).toBe(false)
    expect(config.error).toContain('APNS_KEY_PATH')
    expect(config.error).toContain('APNS_KEY_ID')
    expect(config.error).toContain('APNS_TEAM_ID')
  })

  test('accepts complete production configuration', () => {
    const config = resolveAPNsConfig({
      NODE_ENV: 'production',
      APNS_KEY_PATH: '/run/secrets/AuthKey.p8',
      APNS_KEY_ID: 'KEY123',
      APNS_TEAM_ID: 'TEAM123',
      APNS_BUNDLE_ID: 'com.pocketctl.app',
      APNS_ENVIRONMENT: 'production',
    })

    expect(config).toMatchObject({
      enabled: true,
      keyPath: '/run/secrets/AuthKey.p8',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      bundleId: 'com.pocketctl.app',
      environment: 'production',
    })
  })

  test('defaults production relay to the production APNs endpoint', () => {
    const config = resolveAPNsConfig({
      NODE_ENV: 'production',
      APNS_KEY_PATH: '/keys/AuthKey.p8',
      APNS_KEY_ID: 'KEY123',
      APNS_TEAM_ID: 'TEAM123',
    })

    expect(config.environment).toBe('production')
  })

  test('allows local development without APNs credentials', () => {
    const config = resolveAPNsConfig({ NODE_ENV: 'development' })

    expect(config.enabled).toBe(false)
    expect(config.error).toBeUndefined()
  })
})
