import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadMemoryConfig } from '../config.js'
import { loadSkillConfig, skillModeForScope } from '../skills/config.js'

const budget = {
  MEMORY_SKILL_PROVIDER_BUDGET_KEY: 'phase5-fixture',
  MEMORY_SKILL_TEXT_REQUEST_LIMIT: '2', MEMORY_SKILL_TEXT_INPUT_TOKEN_LIMIT: '4000',
  MEMORY_SKILL_TEXT_OUTPUT_TOKEN_LIMIT: '2000', MEMORY_SKILL_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '1000',
}
const bounds = {
  MEMORY_SKILL_MAX_CONCURRENCY: '1', MEMORY_SKILL_MAX_INPUT_CHARS: '64000',
  MEMORY_SKILL_MAX_CANDIDATE_CHARS: '32000',
}

describe('Phase 5 configuration', () => {
  test('main config exposes an independent default-off skill config', () => {
    const config = loadMemoryConfig({ MEMORY_MODE: 'enabled' })
    expect(config.skill.mode).toBe('off')
    expect(config.skill.autoPublishMode).toBe('off')
    expect(config.skill.canaryMode).toBe('off')
    expect(config.skill.providerBudget).toBeUndefined()
    expect(config.skill.maxConcurrency).toBe(1)
    expect(config.skill.maxInputChars).toBe(64000)
  })

  test('effective scope mode takes the strictest global/skill/shared setting', () => {
    expect(skillModeForScope('off', 'enabled', 'enabled', 'personal')).toBe('off')
    expect(skillModeForScope('enabled', 'enabled', 'off', 'team')).toBe('off')
    expect(skillModeForScope('enabled', 'enabled', 'shadow', 'organization')).toBe('shadow')
    expect(skillModeForScope('enabled', 'shadow', 'enabled', 'personal')).toBe('shadow')
  })
  test('active Skill rejects pools too small for its advisory connection and transactions', () => {
    for (const size of ['1', '2']) expect(() => loadMemoryConfig({ MEMORY_SKILL_MODE: 'shadow', MEMORY_DB_POOL_MAX: size })).toThrow(/MEMORY_DB_POOL_MAX/)
    expect(loadMemoryConfig({ MEMORY_SKILL_MODE: 'shadow', MEMORY_DB_POOL_MAX: '3' }).dbPoolMax).toBe(3)
    expect(loadMemoryConfig({ MEMORY_DB_POOL_MAX: '1' }).dbPoolMax).toBe(1)
  })

  test('does not allow enabled Canary or automatic publication under the deferred product gate', () => {
    for (const name of ['MEMORY_SKILL_AUTO_PUBLISH_MODE', 'MEMORY_SKILL_CANARY_MODE']) {
      expect(() => loadSkillConfig({ [name]: 'enabled' })).toThrow(name)
      expect(() => loadSkillConfig({ [name]: 'shadow' })).not.toThrow()
    }
    expect(() => loadSkillConfig({ MEMORY_SKILL_MODE: 'enabled' })).not.toThrow()
  })

  test('invalid settings fail closed without echoing potentially secret values', () => {
    for (const name of ['MEMORY_SKILL_MODE', 'MEMORY_SKILL_AUTO_PUBLISH_MODE', 'MEMORY_SKILL_MAX_CONCURRENCY']) {
      try { loadSkillConfig({ [name]: 'fixture-secret-value' }); expect.unreachable() } catch (error) {
        expect(String(error)).toContain(name)
        expect(String(error)).not.toContain('fixture-secret-value')
      }
    }
    for (const [name, value] of [
      ['MEMORY_SKILL_MAX_CONCURRENCY', '2'], ['MEMORY_SKILL_MAX_INPUT_CHARS', '64001'],
      ['MEMORY_SKILL_MAX_CANDIDATE_CHARS', '0'], ['MEMORY_SKILL_MAX_INPUT_CHARS', '1e3'],
    ]) expect(() => loadSkillConfig({ [name]: value })).toThrow(name)
  })

  test('production activation requires explicit bounds', () => {
    expect(() => loadSkillConfig({ NODE_ENV: 'production', MEMORY_SKILL_MODE: 'shadow' })).toThrow(/MEMORY_SKILL_MAX_CONCURRENCY/)
    expect(() => loadSkillConfig({ NODE_ENV: 'production', MEMORY_SKILL_MODE: 'shadow', ...bounds })).not.toThrow()
  })

  test('budgets are complete, bounded and independent', () => {
    const parsed = loadSkillConfig(budget).providerBudget!
    expect(parsed.textMaxOutputTokensPerRequest).toBe(1000)
    expect(parsed.textRequestLimit).toBe(2)
    for (const missing of Object.keys(budget)) {
      const partial: Record<string, string> = { ...budget }; delete partial[missing]
      expect(() => loadSkillConfig(partial)).toThrow(missing)
    }
    expect(() => loadSkillConfig({ ...budget, MEMORY_SKILL_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST: '2001' })).toThrow(/MEMORY_SKILL_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST/)
    for (const name of ['MEMORY_PROVIDER_BUDGET_KEY', 'MEMORY_WIKI_PROVIDER_BUDGET_KEY']) {
      expect(() => loadSkillConfig({ ...budget, [name]: budget.MEMORY_SKILL_PROVIDER_BUDGET_KEY })).toThrow(/independent/)
    }
  })

  test.each(['docker-compose.yml', 'docker-compose.prod.yml'])('%s forwards default-off settings to API and worker', file => {
    // Explicit fixture vars: never load a developer's .env or emit resolved credentials.
    const settings = { ...budget, ...bounds, MEMORY_SKILL_MODE: 'shadow',
      MEMORY_SKILL_AUTO_PUBLISH_MODE: 'shadow', MEMORY_SKILL_CANARY_MODE: 'shadow' }
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      POSTGRES_ADMIN_PASSWORD: 'fixture-only', POSTGRES_APP_PASSWORD: 'fixture-only',
      JWT_SECRET: 'fixture-only', AUTH_CODE_PEPPER: 'fixture-only',
      TLS_CERT_PATH: '/fixture/cert', TLS_KEY_PATH: '/fixture/key',
      MEMORY_POSTGRES_PASSWORD: 'fixture-only',
      MEMORY_MODE: 'off', RELAY_EXTENSIONS: 'off',
      MEMORY_RELAY_URL: 'https://relay.example', MEMORY_RELAY_ISSUER: 'https://relay.example',
      MEMORY_PROVIDER_CLIENT_ID: 'fixture-only', MEMORY_PROVIDER_CLIENT_SECRET: 'fixture-only',
      MEMORY_HMAC_KEY: 'fixture-only',
    }
    const config = (values: Record<string, string>) => JSON.parse(execFileSync('docker',
      ['compose', '--env-file', '/dev/null', '-f', file, 'config', '--format', 'json'],
      { cwd: resolve(__dirname, '../../..'), env: { ...env, ...values }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )) as { services: Record<string, { environment: Record<string, string> }> }
    const defaults = config({})
    const explicit = config(settings)
    for (const name of ['memory-api', 'memory-worker']) {
      expect(defaults.services[name]!.environment.MEMORY_SKILL_MODE).toBe('off')
      expect(defaults.services[name]!.environment.MEMORY_SKILL_AUTO_PUBLISH_MODE).toBe('off')
      expect(defaults.services[name]!.environment.MEMORY_SKILL_CANARY_MODE).toBe('off')
      for (const [key, value] of Object.entries(settings)) {
        expect(explicit.services[name]!.environment[key], `${name}:${key}`).toBe(value)
      }
    }
  })
})
