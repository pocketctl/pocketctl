import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  resolveBuildInfo,
  resolveCorsOrigin,
  resolvePublicIssuer,
} from '../runtime-config.js'

describe('production runtime configuration', () => {
  test('rejects an empty production CORS allowlist', () => {
    expect(() => resolveCorsOrigin('production', [])).toThrow('ALLOWED_ORIGINS')
  })

  test('allows the documented permissive fallback only outside production', () => {
    expect(resolveCorsOrigin('development', [])).toBe(true)
    expect(resolveCorsOrigin('production', ['https://www.pocketctl.me']))
      .toEqual(['https://www.pocketctl.me'])
  })

  test('requires an explicit HTTPS public issuer in production', () => {
    expect(() => resolvePublicIssuer('production', '', 'http://relay:8080'))
      .toThrow('PUBLIC_ISSUER_URL')
    expect(() => resolvePublicIssuer(
      'production',
      'http://www.pocketctl.me',
      'http://relay:8080',
    )).toThrow('HTTPS')
  })

  test('normalizes a configured public issuer', () => {
    expect(resolvePublicIssuer(
      'production',
      'https://www.pocketctl.me/',
      'http://relay:8080',
    )).toBe('https://www.pocketctl.me')
    expect(resolvePublicIssuer('development', '', 'http://localhost:8080/'))
      .toBe('http://localhost:8080')
  })

  test('returns the injected build identity', () => {
    expect(resolveBuildInfo({
      NODE_ENV: 'production',
      RELEASE_VERSION: 'v0.3.4',
      GIT_SHA: 'abc123',
      BUILD_TIME: '2026-07-26T00:00:00Z',
    } as NodeJS.ProcessEnv)).toEqual({
      release_version: 'v0.3.4',
      git_sha: 'abc123',
      build_time: '2026-07-26T00:00:00Z',
    })
  })

  test('rejects missing production build identity', () => {
    expect(() => resolveBuildInfo({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow('RELEASE_VERSION')
  })

  test('rejects development identity sentinels in production', () => {
    expect(() => resolveBuildInfo({
      NODE_ENV: 'production',
      RELEASE_VERSION: 'dev',
      GIT_SHA: 'unknown',
      BUILD_TIME: 'unknown',
    } as NodeJS.ProcessEnv)).toThrow('RELEASE_VERSION')
  })

  test('uses explicit development identity defaults', () => {
    expect(resolveBuildInfo({ NODE_ENV: 'development' } as NodeJS.ProcessEnv))
      .toEqual({
        release_version: 'dev',
        git_sha: 'unknown',
        build_time: 'unknown',
      })
  })

  test('requires the production database password and public issuer in Compose', () => {
    const compose = readFileSync(
      new URL('../../../docker-compose.prod.yml', import.meta.url),
      'utf8',
    )

    expect(compose).not.toContain('POSTGRES_PASSWORD:-')
    expect(compose).toContain('${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}')
    expect(compose).toContain('PUBLIC_ISSUER_URL: "https://www.pocketctl.me"')
  })
})
