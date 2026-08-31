import { describe, expect, test } from 'vitest'
import { loadMemoryConfig } from '../config.js'

const BASE_ENV: Record<string, string | undefined> = {
  MEMORY_MODE: 'off',
  MEMORY_DATABASE_URL: 'postgres://memory:memory@localhost:5433/memory',
  MEMORY_RELAY_URL: 'http://relay:8080',
  MEMORY_RELAY_ISSUER: 'http://localhost:8080',
  MEMORY_PROVIDER_CLIENT_ID: 'client-1',
  MEMORY_PROVIDER_CLIENT_SECRET: 'secret-1',
  MEMORY_HMAC_KEY: 'hmac-key-0123456789abcdef0123456789abcdef',
}

const TEXT_ENV = {
  MEMORY_TEXT_PROVIDER: 'openai-compatible',
  MEMORY_TEXT_BASE_URL: 'https://api.model.example/v1',
  MEMORY_TEXT_MODEL: 'extractor-small',
  MEMORY_TEXT_API_KEY: 'text-api-key-0123456789',
}

const EMBEDDING_ENV = {
  MEMORY_EMBEDDING_PROVIDER: 'openai-compatible',
  MEMORY_EMBEDDING_BASE_URL: 'https://api.model.example/v1',
  MEMORY_EMBEDDING_MODEL: 'embed-small',
  MEMORY_EMBEDDING_API_KEY: 'embed-api-key-0123456789',
  MEMORY_EMBEDDING_DIMENSIONS: '1536',
}

function configWith(overrides: Record<string, string | undefined>) {
  return loadMemoryConfig({ ...BASE_ENV, ...overrides })
}

describe('phase one model provider configuration', () => {
  test('absent model configuration resolves with no adapters', () => {
    const config = configWith({})
    expect(config.textModel).toBeUndefined()
    expect(config.embeddingModel).toBeUndefined()
  })

  test('production may start without model configuration', () => {
    const config = loadMemoryConfig({ ...BASE_ENV, NODE_ENV: 'production' })
    expect(config.textModel).toBeUndefined()
    expect(config.embeddingModel).toBeUndefined()
  })

  test('production shadow and enabled modes require a versioned tombstone keyring', () => {
    for (const mode of ['shadow', 'enabled']) {
      expect(() => loadMemoryConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        MEMORY_MODE: mode,
      })).toThrow('MEMORY_TOMBSTONE_HMAC_KEYS')
    }
    expect(() => loadMemoryConfig({
      ...BASE_ENV,
      NODE_ENV: 'production',
      MEMORY_MODE: 'off',
    })).not.toThrow()
  })

  test('non-production fallback keyring uses the configured legacy hmac key', () => {
    const config = configWith({ MEMORY_TOMBSTONE_HMAC_KEYS: undefined })
    expect(config.tombstoneHmacKeys).toEqual([
      { version: 'legacy', key: BASE_ENV.MEMORY_HMAC_KEY },
    ])
  })

  test('a complete text model configuration resolves', () => {
    const config = configWith({ ...TEXT_ENV })
    expect(config.textModel).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.model.example/v1',
      model: 'extractor-small',
      apiKey: 'text-api-key-0123456789',
      pricingConfigured: false,
      inputCostMicrosPerMillionTokens: 0,
      outputCostMicrosPerMillionTokens: 0,
    })
  })

  test('an explicit text thinking mode resolves for the provider adapter', () => {
    const config = configWith({ ...TEXT_ENV, MEMORY_TEXT_THINKING: 'disabled' })
    expect(config.textModel).toMatchObject({ thinking: 'disabled' })
  })

  test('an unknown text thinking mode fails closed', () => {
    expect(() => configWith({ ...TEXT_ENV, MEMORY_TEXT_THINKING: 'sometimes' }))
      .toThrow('MEMORY_TEXT_THINKING')
  })

  test('model identifiers and explicit token prices match Relay usage bounds', () => {
    expect(() => configWith({ ...TEXT_ENV, MEMORY_TEXT_MODEL: 'm'.repeat(129) }))
      .toThrow('MEMORY_TEXT_MODEL')
    const config = configWith({
      ...TEXT_ENV,
      MEMORY_TEXT_INPUT_COST_MICROS_PER_MILLION_TOKENS: '2500000',
      MEMORY_TEXT_OUTPUT_COST_MICROS_PER_MILLION_TOKENS: '7500000',
    })
    expect(config.textModel).toMatchObject({
      pricingConfigured: true,
      inputCostMicrosPerMillionTokens: 2_500_000,
      outputCostMicrosPerMillionTokens: 7_500_000,
    })
  })

  test('unknown providers are rejected', () => {
    expect(() => configWith({ ...TEXT_ENV, MEMORY_TEXT_PROVIDER: 'vendor-sdk' }))
      .toThrow('MEMORY_TEXT_PROVIDER')
    expect(() => configWith({ ...EMBEDDING_ENV, MEMORY_EMBEDDING_PROVIDER: 'vendor-sdk' }))
      .toThrow('MEMORY_EMBEDDING_PROVIDER')
  })

  test('partial text configuration fails closed naming the missing variable', () => {
    for (const missing of ['MEMORY_TEXT_BASE_URL', 'MEMORY_TEXT_MODEL', 'MEMORY_TEXT_API_KEY'] as const) {
      const rest: Record<string, string | undefined> = { ...TEXT_ENV }
      delete rest[missing]
      expect(() => configWith(rest)).toThrow(missing)
    }
  })

  test('partial embedding configuration fails closed naming the missing variable', () => {
    for (const missing of [
      'MEMORY_EMBEDDING_BASE_URL', 'MEMORY_EMBEDDING_MODEL',
      'MEMORY_EMBEDDING_API_KEY', 'MEMORY_EMBEDDING_DIMENSIONS',
    ] as const) {
      const rest: Record<string, string | undefined> = { ...EMBEDDING_ENV }
      delete rest[missing]
      expect(() => configWith(rest)).toThrow(missing)
    }
  })

  test('model base URLs must be http(s) without credentials or query strings', () => {
    for (const bad of [
      'ftp://api.model.example',
      'https://user:pass@api.model.example/v1',
      'https://api.model.example/v1?key=secret',
      'not-a-url',
    ]) {
      expect(() => configWith({ ...TEXT_ENV, MEMORY_TEXT_BASE_URL: bad }))
        .toThrow('MEMORY_TEXT_BASE_URL')
    }
  })

  test('embedding dimensions are positive and bounded', () => {
    for (const bad of ['0', '-4', '5000', 'abc']) {
      expect(() => configWith({ ...EMBEDDING_ENV, MEMORY_EMBEDDING_DIMENSIONS: bad }))
        .toThrow('MEMORY_EMBEDDING_DIMENSIONS')
    }
    const config = configWith({ ...EMBEDDING_ENV })
    expect(config.embeddingModel!.dimensions).toBe(1536)
  })

  test('model timeouts and extraction bound are bounded integers', () => {
    for (const [name, bad] of [
      ['MEMORY_MODEL_TIMEOUT_MS', '999'],
      ['MEMORY_MODEL_TIMEOUT_MS', '360000'],
      ['MEMORY_RECALL_EMBEDDING_TIMEOUT_MS', '0'],
      ['MEMORY_EXTRACTION_MAX_CHARS', '1000'],
      ['MEMORY_EXTRACTION_MAX_CHARS', 'not-a-number'],
    ] as const) {
      const overrides = name === 'MEMORY_EXTRACTION_MAX_CHARS'
        ? { MEMORY_EXTRACTION_MAX_CHARS: bad }
        : { [name]: bad }
      expect(() => configWith(overrides)).toThrow(name)
    }
    const config = configWith({})
    expect(config.modelTimeoutMs).toBeGreaterThanOrEqual(1000)
    expect(config.recallEmbeddingTimeoutMs).toBeGreaterThanOrEqual(100)
    expect(config.extractionMaxChars).toBeGreaterThan(0)
  })

  test('allowed origins and hosts parse as bounded allowlists', () => {
    const config = configWith({
      MEMORY_ALLOWED_ORIGINS: 'https://web.example, https://console.example:8443',
      MEMORY_ALLOWED_HOSTS: 'memory.example, LOCALHOST',
    })
    expect([...config.allowedOrigins]).toEqual(['https://web.example', 'https://console.example:8443'])
    expect([...config.allowedHosts]).toEqual(['memory.example', 'localhost'])
    expect(() => configWith({ MEMORY_ALLOWED_ORIGINS: 'https://ok.example, banana' }))
      .toThrow('MEMORY_ALLOWED_ORIGINS')
    expect(() => configWith({ MEMORY_ALLOWED_HOSTS: 'host.example;drop' }))
      .toThrow('MEMORY_ALLOWED_HOSTS')
  })

  test('tombstone hmac keys parse as a versioned ring', () => {
    const key = 'a'.repeat(44)
    const config = configWith({ MEMORY_TOMBSTONE_HMAC_KEYS: `v1=${key},v2=${'b'.repeat(44)}` })
    expect(config.tombstoneHmacKeys).toEqual([
      { version: 'v1', key },
      { version: 'v2', key: 'b'.repeat(44) },
    ])
    for (const bad of ['v1', `v1=${'short'}`, `v1=${key},v1=${key}`]) {
      expect(() => configWith({ MEMORY_TOMBSTONE_HMAC_KEYS: bad }))
        .toThrow('MEMORY_TOMBSTONE_HMAC_KEYS')
    }
  })

  test('error messages never echo secret values', () => {
    const secret = 'super-secret-api-key-value'
    let message = ''
    try {
      configWith({ ...TEXT_ENV, MEMORY_TEXT_BASE_URL: 'https://api.model.example/v1', MEMORY_TEXT_API_KEY: secret, MEMORY_TEXT_MODEL: '' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('MEMORY_TEXT_MODEL')
    expect(message).not.toContain(secret)
  })
})
