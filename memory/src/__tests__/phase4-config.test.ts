import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { loadMemoryConfig, phase4ModeForScope } from '../config.js'

const REPOSITORY_ROOT = resolve(__dirname, '../../..')

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    MEMORY_MODE: 'off',
    MEMORY_DATABASE_URL: 'postgresql://memory:memory@localhost:5433/memory',
    MEMORY_RELAY_URL: 'http://relay:8080',
    MEMORY_RELAY_ISSUER: 'http://relay:8080',
    MEMORY_PROVIDER_CLIENT_ID: 'client-1',
    MEMORY_PROVIDER_CLIENT_SECRET: 'secret-0123456789abcdef',
    MEMORY_HMAC_KEY: 'hmac-key-0123456789abcdef-0123456789abcdef',
    ...overrides,
  }
}

describe('phase4 configuration', () => {
  test('defaults both independent features off with frozen safe bounds', () => {
    const config = loadMemoryConfig(baseEnv())
    expect(config.codegraphMode).toBe('off')
    expect(config.wikiMode).toBe('off')
    expect(config.codegraphMaxConcurrency).toBe(1)
    expect(config.wikiMaxConcurrency).toBe(1)
    expect(config.wikiMaxPages).toBe(32)
    expect(config.wikiMaxSections).toBe(256)
    expect(config.wikiMaxSourceChars).toBe(200_000)
    expect(config.codeSnapshotRetentionDays).toBe(30)
  })

  test.each(['off', 'shadow', 'enabled'] as const)('accepts the %s feature mode', mode => {
    const config = loadMemoryConfig(baseEnv({
      MEMORY_CODEGRAPH_MODE: mode,
      MEMORY_WIKI_MODE: mode,
    }))
    expect(config.codegraphMode).toBe(mode)
    expect(config.wikiMode).toBe(mode)
  })

  test('intersects a shared feature mode without weakening personal mode', () => {
    expect(phase4ModeForScope('enabled', 'off', 'personal')).toBe('enabled')
    expect(phase4ModeForScope('enabled', 'shadow', 'shared')).toBe('shadow')
    expect(phase4ModeForScope('shadow', 'enabled', 'shared')).toBe('shadow')
    expect(phase4ModeForScope('enabled', 'off', 'shared')).toBe('off')
  })

  test('uses a separate all-or-nothing positive Wiki budget and never borrows extraction budget', () => {
    const extractionOnly = loadMemoryConfig(baseEnv({
      MEMORY_PROVIDER_BUDGET_KEY: 'phase3-extraction',
      MEMORY_TEXT_BUDGET_MAX_REQUESTS: '5',
      MEMORY_TEXT_BUDGET_MAX_INPUT_TOKENS: '5000',
      MEMORY_TEXT_BUDGET_MAX_OUTPUT_TOKENS: '2000',
      MEMORY_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '500',
      MEMORY_EMBEDDING_BUDGET_MAX_REQUESTS: '0',
      MEMORY_EMBEDDING_BUDGET_MAX_TOKENS: '0',
    }))
    expect(extractionOnly.wikiProviderBudget).toBeUndefined()

    const config = loadMemoryConfig(baseEnv({
      MEMORY_WIKI_PROVIDER_BUDGET_KEY: 'phase4-wiki-approved',
      MEMORY_WIKI_TEXT_REQUEST_LIMIT: '3',
      MEMORY_WIKI_TEXT_INPUT_TOKEN_LIMIT: '3000',
      MEMORY_WIKI_TEXT_OUTPUT_TOKEN_LIMIT: '1200',
      MEMORY_WIKI_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '500',
    }))
    expect(config.wikiProviderBudget).toEqual({
      key: 'phase4-wiki-approved',
      textRequestLimit: 3,
      textInputTokenLimit: 3000,
      textOutputTokenLimit: 1200,
      textMaxOutputTokensPerRequest: 500,
    })

    expect(() => loadMemoryConfig(baseEnv({
      MEMORY_WIKI_PROVIDER_BUDGET_KEY: 'phase4-wiki-approved',
    }))).toThrow(/MEMORY_WIKI_TEXT_REQUEST_LIMIT/)
    expect(() => loadMemoryConfig(baseEnv({
      MEMORY_WIKI_PROVIDER_BUDGET_KEY: 'phase4-wiki-approved',
      MEMORY_WIKI_TEXT_REQUEST_LIMIT: '0',
      MEMORY_WIKI_TEXT_INPUT_TOKEN_LIMIT: '3000',
      MEMORY_WIKI_TEXT_OUTPUT_TOKEN_LIMIT: '1200',
      MEMORY_WIKI_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '500',
    }))).toThrow(/MEMORY_WIKI_TEXT_REQUEST_LIMIT/)
    expect(() => loadMemoryConfig(baseEnv({
      MEMORY_WIKI_PROVIDER_BUDGET_KEY: 'phase4-wiki-approved',
      MEMORY_WIKI_TEXT_REQUEST_LIMIT: '3',
      MEMORY_WIKI_TEXT_INPUT_TOKEN_LIMIT: '3000',
      MEMORY_WIKI_TEXT_OUTPUT_TOKEN_LIMIT: '1200',
      MEMORY_WIKI_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '1201',
    }))).toThrow(/MEMORY_WIKI_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST/)
  })

  test('rejects unsafe concurrency, content, and retention bounds', () => {
    for (const [name, value] of [
      ['MEMORY_CODEGRAPH_MAX_CONCURRENCY', '0'],
      ['MEMORY_CODEGRAPH_MAX_CONCURRENCY', '2'],
      ['MEMORY_WIKI_MAX_CONCURRENCY', '0'],
      ['MEMORY_WIKI_MAX_CONCURRENCY', '2'],
      ['MEMORY_WIKI_MAX_PAGES', '33'],
      ['MEMORY_WIKI_MAX_SECTIONS', '257'],
      ['MEMORY_WIKI_MAX_SOURCE_CHARS', '200001'],
      ['MEMORY_CODE_SNAPSHOT_RETENTION_DAYS', '0'],
      ['MEMORY_CODE_SNAPSHOT_RETENTION_DAYS', '366'],
    ]) {
      expect(() => loadMemoryConfig(baseEnv({ [name]: value })), name).toThrow(name)
    }
  })

  test('production feature activation fails closed unless every relevant bound is explicit', () => {
    const production = baseEnv({
      NODE_ENV: 'production',
      MEMORY_CODEGRAPH_MODE: 'shadow',
      MEMORY_WIKI_MODE: 'shadow',
      MEMORY_TOMBSTONE_HMAC_KEYS: 'v1=tombstone-key-0123456789abcdef-0123456789abcdef',
    })
    expect(() => loadMemoryConfig(production)).toThrow(/MEMORY_CODEGRAPH_MAX_CONCURRENCY/)

    Object.assign(production, {
      MEMORY_CODEGRAPH_MAX_CONCURRENCY: '1',
      MEMORY_CODE_SNAPSHOT_RETENTION_DAYS: '30',
      MEMORY_WIKI_MAX_CONCURRENCY: '1',
      MEMORY_WIKI_MAX_PAGES: '32',
      MEMORY_WIKI_MAX_SECTIONS: '256',
      MEMORY_WIKI_MAX_SOURCE_CHARS: '200000',
    })
    expect(() => loadMemoryConfig(production)).not.toThrow()
  })

  test.each(['docker-compose.yml', 'docker-compose.prod.yml'])('%s propagates all Phase 4 settings to API and worker', file => {
    const output = execFileSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORY_MODE: 'off',
        POSTGRES_ADMIN_PASSWORD: 'compose-admin-contract-only',
        POSTGRES_APP_PASSWORD: 'compose-app-contract-only',
        JWT_SECRET: 'compose-jwt-contract-only',
        AUTH_CODE_PEPPER: 'compose-pepper-contract-only',
        RELAY_EXTENSIONS: 'off',
        TLS_CERT_PATH: '/run/secrets/compose-cert-contract-only',
        TLS_KEY_PATH: '/run/secrets/compose-key-contract-only',
        MEMORY_POSTGRES_PASSWORD: 'compose-contract-only',
        MEMORY_RELAY_URL: 'https://relay.example',
        MEMORY_RELAY_ISSUER: 'https://relay.example',
        MEMORY_PROVIDER_CLIENT_ID: 'compose-client',
        MEMORY_PROVIDER_CLIENT_SECRET: 'compose-secret',
        MEMORY_HMAC_KEY: 'compose-hmac-key-0123456789abcdef0123456789',
      },
    })
    const compose = JSON.parse(output) as { services: Record<string, { environment: Record<string, string> }> }
    const required = [
      'MEMORY_CODEGRAPH_MODE', 'MEMORY_WIKI_MODE',
      'MEMORY_CODEGRAPH_MAX_CONCURRENCY', 'MEMORY_WIKI_MAX_CONCURRENCY',
      'MEMORY_WIKI_MAX_PAGES', 'MEMORY_WIKI_MAX_SECTIONS',
      'MEMORY_WIKI_MAX_SOURCE_CHARS', 'MEMORY_CODE_SNAPSHOT_RETENTION_DAYS',
      'MEMORY_WIKI_PROVIDER_BUDGET_KEY', 'MEMORY_WIKI_TEXT_REQUEST_LIMIT',
      'MEMORY_WIKI_TEXT_INPUT_TOKEN_LIMIT', 'MEMORY_WIKI_TEXT_OUTPUT_TOKEN_LIMIT',
      'MEMORY_WIKI_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST',
    ]
    for (const serviceName of ['memory-api', 'memory-worker']) {
      const environment = compose.services[serviceName]!.environment
      for (const name of required) expect(environment, `${serviceName}:${name}`).toHaveProperty(name)
    }
  })
})
