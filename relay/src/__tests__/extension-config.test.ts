import { describe, expect, test } from 'vitest'
import { resolveExtensionConfig } from '../extensions/config.js'

const PRODUCTION_KEYS = {
  EXTENSION_PROVIDER_JWT_SECRET: 'p'.repeat(48),
  EXTENSION_CURSOR_SECRET: 'c'.repeat(48),
  EXTENSION_GRANT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0test\n-----END PRIVATE KEY-----\n',
  EXTENSION_PROVIDER_PUBLIC_ORIGINS: '{"pocketctl-memory": "https://memory.example"}',
} as const

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

describe('extension feature flag (RELAY_EXTENSIONS)', () => {
  test('defaults to off outside production', () => {
    expect(resolveExtensionConfig(env({ NODE_ENV: 'development' })).mode).toBe('off')
    expect(resolveExtensionConfig(env({})).mode).toBe('off')
  })

  test('production requires an explicit value', () => {
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'production' })))
      .toThrow('RELAY_EXTENSIONS')
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'production', RELAY_EXTENSIONS: '' })))
      .toThrow('RELAY_EXTENSIONS')
  })

  test('accepts exactly off, shadow and enabled', () => {
    expect(resolveExtensionConfig(env({ NODE_ENV: 'development', RELAY_EXTENSIONS: 'off' })).mode).toBe('off')
    expect(resolveExtensionConfig(env({ NODE_ENV: 'development', RELAY_EXTENSIONS: 'shadow' })).mode).toBe('shadow')
    expect(resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      ...PRODUCTION_KEYS,
    })).mode).toBe('enabled')
  })

  test('rejects any other value in every environment', () => {
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'development', RELAY_EXTENSIONS: 'verbose' })))
      .toThrow('RELAY_EXTENSIONS')
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'development', RELAY_EXTENSIONS: 'on' })))
      .toThrow('RELAY_EXTENSIONS')
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'production', RELAY_EXTENSIONS: 'ENABLED' })))
      .toThrow('RELAY_EXTENSIONS')
  })
})

describe('extension numeric bounds', () => {
  test('projector batch accepts 1..500 and defaults bounded', () => {
    expect(resolveExtensionConfig(env({})).projectorBatchSize).toBeGreaterThan(0)
    expect(resolveExtensionConfig(env({ RELAY_EXTENSION_PROJECTOR_BATCH: '1' })).projectorBatchSize).toBe(1)
    expect(resolveExtensionConfig(env({ RELAY_EXTENSION_PROJECTOR_BATCH: '500' })).projectorBatchSize).toBe(500)
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_PROJECTOR_BATCH: '0' }))).toThrow()
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_PROJECTOR_BATCH: '501' }))).toThrow()
  })

  test('feed retention accepts 1..90 days', () => {
    expect(resolveExtensionConfig(env({})).feedRetentionDays).toBe(7)
    expect(resolveExtensionConfig(env({ RELAY_EXTENSION_FEED_RETENTION_DAYS: '1' })).feedRetentionDays).toBe(1)
    expect(resolveExtensionConfig(env({ RELAY_EXTENSION_FEED_RETENTION_DAYS: '90' })).feedRetentionDays).toBe(90)
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_FEED_RETENTION_DAYS: '0' }))).toThrow()
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_FEED_RETENTION_DAYS: '91' }))).toThrow()
  })

  test('lease ttl accepts 10..300 seconds', () => {
    expect(resolveExtensionConfig(env({})).leaseTtlSeconds).toBeGreaterThanOrEqual(10)
    expect(resolveExtensionConfig(env({ RELAY_EXTENSION_LEASE_TTL_SECONDS: '10' })).leaseTtlSeconds).toBe(10)
    expect(resolveExtensionConfig(env({ RELAY_EXTENSION_LEASE_TTL_SECONDS: '300' })).leaseTtlSeconds).toBe(300)
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_LEASE_TTL_SECONDS: '9' }))).toThrow()
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_LEASE_TTL_SECONDS: '301' }))).toThrow()
  })

  test('numeric parsing is strict and rejects trailing junk', () => {
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_PROJECTOR_BATCH: '12junk' }))).toThrow()
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_FEED_RETENTION_DAYS: '7.5' }))).toThrow()
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_LEASE_TTL_SECONDS: ' 60' }))).toThrow()
    expect(() => resolveExtensionConfig(env({ RELAY_EXTENSION_PROJECTOR_BATCH: '-5' }))).toThrow()
  })
})

describe('production enabled key requirements', () => {
  test('enabled without provider jwt secret fails startup', () => {
    const { EXTENSION_PROVIDER_JWT_SECRET: _omit, ...rest } = PRODUCTION_KEYS
    expect(() => resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      ...rest,
    }))).toThrow('EXTENSION_PROVIDER_JWT_SECRET')
  })

  test('enabled without cursor secret fails startup', () => {
    const { EXTENSION_CURSOR_SECRET: _omit, ...rest } = PRODUCTION_KEYS
    expect(() => resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      ...rest,
    }))).toThrow('EXTENSION_CURSOR_SECRET')
  })

  test('enabled without grant private key fails startup', () => {
    const { EXTENSION_GRANT_PRIVATE_KEY: _omit, ...rest } = PRODUCTION_KEYS
    expect(() => resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      ...rest,
    }))).toThrow('EXTENSION_GRANT_PRIVATE_KEY')
  })

  test('enabled without provider public origins fails startup', () => {
    const { EXTENSION_PROVIDER_PUBLIC_ORIGINS: _omit, ...rest } = PRODUCTION_KEYS
    expect(() => resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      ...rest,
    }))).toThrow('EXTENSION_PROVIDER_PUBLIC_ORIGINS')
  })

  test('enabled with all keys resolves', () => {
    const config = resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      ...PRODUCTION_KEYS,
    }))
    expect(config.mode).toBe('enabled')
    expect(config.providerJwtSecret).toBe(PRODUCTION_KEYS.EXTENSION_PROVIDER_JWT_SECRET)
    expect(config.cursorSecret).toBe(PRODUCTION_KEYS.EXTENSION_CURSOR_SECRET)
  })

  test('enabled accepts a base64-encoded grant private key for EnvironmentFile deployment', () => {
    const rawPrivateKey = PRODUCTION_KEYS.EXTENSION_GRANT_PRIVATE_KEY
    const config = resolveExtensionConfig(env({
      NODE_ENV: 'production',
      RELAY_EXTENSIONS: 'enabled',
      EXTENSION_PROVIDER_JWT_SECRET: PRODUCTION_KEYS.EXTENSION_PROVIDER_JWT_SECRET,
      EXTENSION_CURSOR_SECRET: PRODUCTION_KEYS.EXTENSION_CURSOR_SECRET,
      EXTENSION_PROVIDER_PUBLIC_ORIGINS: PRODUCTION_KEYS.EXTENSION_PROVIDER_PUBLIC_ORIGINS,
      EXTENSION_GRANT_PRIVATE_KEY_B64: Buffer.from(rawPrivateKey, 'utf8').toString('base64'),
    }))
    expect(config.grantPrivateKey).toBe(rawPrivateKey.trim())
  })

  test('short secrets are rejected even outside production when provided', () => {
    expect(() => resolveExtensionConfig(env({
      NODE_ENV: 'development',
      RELAY_EXTENSIONS: 'shadow',
      EXTENSION_PROVIDER_JWT_SECRET: 'short',
    }))).toThrow('EXTENSION_PROVIDER_JWT_SECRET')
  })

  test('off and shadow do not require provider-facing keys', () => {
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'production', RELAY_EXTENSIONS: 'off' }))).not.toThrow()
    expect(() => resolveExtensionConfig(env({ NODE_ENV: 'production', RELAY_EXTENSIONS: 'shadow' }))).not.toThrow()
  })

  test('returned config is immutable', () => {
    const config = resolveExtensionConfig(env({})) as { mode: string }
    expect(() => { config.mode = 'enabled' }).toThrow()
  })
})
