import { describe, expect, test } from 'vitest'
import { loadMemoryConfig } from '../config.js'

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    MEMORY_MODE: 'enabled',
    MEMORY_PORT: '8090',
    MEMORY_DATABASE_URL: 'postgresql://memory:memory@localhost:5433/memory',
    MEMORY_RELAY_URL: 'http://relay:8080',
    MEMORY_RELAY_ISSUER: 'http://relay:8080',
    MEMORY_PROVIDER_CLIENT_ID: 'client-1',
    MEMORY_PROVIDER_CLIENT_SECRET: 'secret-0123456789abcdef',
    MEMORY_HMAC_KEY: 'hmac-key-0123456789abcdef-0123456789abcdef',
    ...overrides,
  }
}

describe('memory config', () => {
  test('parses the full environment with defaults', () => {
    const config = loadMemoryConfig(baseEnv())
    expect(config.mode).toBe('enabled')
    expect(config.port).toBe(8090)
    expect(config.apiBind).toBe('all')
    expect(config.dbPoolMax).toBe(12)
    expect(config.providerId).toBe('pocketctl-memory')
    expect(config.providerVersion).toBe('0.1.0')
    expect(config.workerId).toBe('memory-worker-1')
    expect(config.pollIntervalMs).toBe(1000)
    expect(config.httpTimeoutMs).toBe(10000)
    expect(config.jobLeaseMs).toBe(30000)
    expect(config.episodeStabilizationMs).toBe(30000)
    expect(config.extractionDebounceMs).toBe(120000)
    expect(config.extractionMaxRunsPerEpisode).toBe(1)
    expect(config.extractionNotBefore).toBeNull()
    expect(config.providerBudget).toBeUndefined()
    expect(config.logLevel).toBe('info')
  })

  test('accepts only off, shadow and enabled modes', () => {
    expect(loadMemoryConfig(baseEnv({ MEMORY_MODE: 'off' })).mode).toBe('off')
    expect(loadMemoryConfig(baseEnv({ MEMORY_MODE: 'shadow' })).mode).toBe('shadow')
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_MODE: 'verbose' }))).toThrow(/MEMORY_MODE/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_MODE: '' }))).toThrow(/MEMORY_MODE/)
  })

  test('loads the independent shared-scope mode into the runtime config', () => {
    expect(loadMemoryConfig(baseEnv()).sharedScopesMode).toBe('off')
    expect(loadMemoryConfig(baseEnv({ MEMORY_SHARED_SCOPES: 'shadow' })).sharedScopesMode).toBe('shadow')
    expect(loadMemoryConfig(baseEnv({ MEMORY_SHARED_SCOPES: 'enabled' })).sharedScopesMode).toBe('enabled')
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_SHARED_SCOPES: 'invalid' })))
      .toThrow(/MEMORY_SHARED_SCOPES/)
  })

  test('pins the provider id to pocketctl-memory', () => {
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_PROVIDER_ID: 'other-memory' })))
      .toThrow(/MEMORY_PROVIDER_ID/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_PROVIDER_ID: 'pocketctl-memory' })))
      .not.toThrow()
  })

  test('production requires database, relay, credentials and hmac key', () => {
    for (const missing of [
      'MEMORY_DATABASE_URL',
      'MEMORY_RELAY_URL',
      'MEMORY_RELAY_ISSUER',
      'MEMORY_PROVIDER_CLIENT_ID',
      'MEMORY_PROVIDER_CLIENT_SECRET',
      'MEMORY_HMAC_KEY',
    ]) {
      const env = baseEnv({ NODE_ENV: 'production' })
      delete env[missing]
      expect(() => loadMemoryConfig(env), missing).toThrow(missing)
    }
    // The same incomplete environment is fine outside production.
    const env = baseEnv({ NODE_ENV: 'development' })
    delete env.MEMORY_RELAY_URL
    delete env.MEMORY_PROVIDER_CLIENT_ID
    expect(() => loadMemoryConfig(env)).not.toThrow()
  })

  test('rejects hmac keys shorter than 32 bytes', () => {
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_HMAC_KEY: 'short' }))).toThrow(/MEMORY_HMAC_KEY/)
  })

  test('clamps and validates numeric bounds', () => {
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_PORT: '0' }))).toThrow(/MEMORY_PORT/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_PORT: '70000' }))).toThrow(/MEMORY_PORT/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_PORT: 'abc' }))).toThrow(/MEMORY_PORT/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_DB_POOL_MAX: '0' }))).toThrow(/MEMORY_DB_POOL_MAX/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_DB_POOL_MAX: '4096' }))).toThrow(/MEMORY_DB_POOL_MAX/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_POLL_INTERVAL_MS: '10' }))).toThrow(/MEMORY_POLL_INTERVAL_MS/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_HTTP_TIMEOUT_MS: '1' }))).toThrow(/MEMORY_HTTP_TIMEOUT_MS/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_JOB_LEASE_MS: '10' }))).toThrow(/MEMORY_JOB_LEASE_MS/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_EPISODE_STABILIZATION_MS: '-1' }))).toThrow(/MEMORY_EPISODE_STABILIZATION_MS/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_EXTRACTION_DEBOUNCE_MS: '-1' }))).toThrow(/MEMORY_EXTRACTION_DEBOUNCE_MS/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_EXTRACTION_MAX_RUNS_PER_EPISODE: '0' }))).toThrow(/MEMORY_EXTRACTION_MAX_RUNS_PER_EPISODE/)
  })

  test('parses the extraction cutoff and rejects ambiguous timestamps', () => {
    expect(loadMemoryConfig(baseEnv({
      MEMORY_EXTRACTION_NOT_BEFORE: '2026-08-31T00:00:00.000Z',
    })).extractionNotBefore?.toISOString()).toBe('2026-08-31T00:00:00.000Z')
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_EXTRACTION_NOT_BEFORE: '2026-08-31' })))
      .toThrow(/MEMORY_EXTRACTION_NOT_BEFORE/)
  })

  test('provider budget configuration is all-or-nothing and bounded', () => {
    const budget = {
      MEMORY_PROVIDER_BUDGET_KEY: 'phase3-pilot-b',
      MEMORY_TEXT_BUDGET_MAX_REQUESTS: '8',
      MEMORY_TEXT_BUDGET_MAX_INPUT_TOKENS: '100000',
      MEMORY_TEXT_BUDGET_MAX_OUTPUT_TOKENS: '50000',
      MEMORY_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '4096',
      MEMORY_EMBEDDING_BUDGET_MAX_REQUESTS: '20',
      MEMORY_EMBEDDING_BUDGET_MAX_TOKENS: '20000',
    }
    expect(loadMemoryConfig(baseEnv(budget)).providerBudget).toEqual({
      key: 'phase3-pilot-b',
      textMaxRequests: 8,
      textMaxInputTokens: 100000,
      textMaxOutputTokens: 50000,
      textMaxOutputTokensPerRequest: 4096,
      embeddingMaxRequests: 20,
      embeddingMaxTokens: 20000,
    })
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_PROVIDER_BUDGET_KEY: 'phase3-pilot-b' })))
      .toThrow(/MEMORY_TEXT_BUDGET_MAX_REQUESTS/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_TEXT_BUDGET_MAX_REQUESTS: '8' })))
      .toThrow(/MEMORY_PROVIDER_BUDGET_KEY/)
  })

  test('bounds the worker id to 64 characters', () => {
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_WORKER_ID: 'x'.repeat(64) }))).not.toThrow()
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_WORKER_ID: 'x'.repeat(65) }))).toThrow(/MEMORY_WORKER_ID/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_WORKER_ID: '' }))).toThrow(/MEMORY_WORKER_ID/)
  })

  test('error messages never echo secrets', () => {
    const secret = 'super-secret-value-0123456789'
    const hmac = 'hmac-key-0123456789abcdef-0123456789abcdef'
    const attempts: Array<() => unknown> = [
      () => loadMemoryConfig(baseEnv({
        NODE_ENV: 'production', MEMORY_PROVIDER_CLIENT_SECRET: secret, MEMORY_HMAC_KEY: hmac,
      })),
      () => loadMemoryConfig(baseEnv({ MEMORY_PROVIDER_CLIENT_SECRET: secret, MEMORY_HMAC_KEY: 'tiny' })),
      () => loadMemoryConfig(baseEnv({
        NODE_ENV: 'production',
        MEMORY_PROVIDER_CLIENT_ID: '',
        MEMORY_PROVIDER_CLIENT_SECRET: secret,
      })),
    ]
    for (const attempt of attempts) {
      try {
        attempt()
        expect.unreachable('expected a config error')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).not.toContain(secret)
        expect(message).not.toContain(hmac)
      }
    }
  })

  test('validates relay url and issuer as http origins without credentials', () => {
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_RELAY_URL: 'ftp://relay:8080' }))).toThrow(/MEMORY_RELAY_URL/)
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_RELAY_ISSUER: 'not a url' }))).toThrow(/MEMORY_RELAY_ISSUER/)
    const withPath = loadMemoryConfig(baseEnv({ MEMORY_RELAY_URL: 'http://relay:8080/api' }))
    expect(withPath.relayUrl).toBe('http://relay:8080')
  })

  test('accepts only known log levels', () => {
    expect(loadMemoryConfig(baseEnv({ MEMORY_LOG_LEVEL: 'debug' })).logLevel).toBe('debug')
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_LOG_LEVEL: 'verbose' }))).toThrow(/MEMORY_LOG_LEVEL/)
  })

  test('supports an explicit loopback-only API bind for native production', () => {
    expect(loadMemoryConfig(baseEnv({ MEMORY_API_BIND: 'loopback' })).apiBind).toBe('loopback')
    expect(loadMemoryConfig(baseEnv({ MEMORY_API_BIND: 'all' })).apiBind).toBe('all')
    expect(() => loadMemoryConfig(baseEnv({ MEMORY_API_BIND: 'public' }))).toThrow(/MEMORY_API_BIND/)
  })
})
