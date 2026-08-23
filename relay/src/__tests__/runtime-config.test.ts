import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  resolveBuildInfo,
  resolveCorsOrigin,
  resolveEmailVerificationConfig,
  resolvePublicIssuer,
  resolveRelayListenHost,
  resolveTrustedProxyConfig,
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

  test('requires the production database passwords and public issuer in Compose', () => {
    const compose = readFileSync(
      new URL('../../../docker-compose.prod.yml', import.meta.url),
      'utf8',
    )

    // M-7 split the single app password into distinct admin/app secrets.
    expect(compose).not.toContain('POSTGRES_PASSWORD:-')
    expect(compose).toContain('${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}')
    expect(compose).toContain('${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}')
    expect(compose).toContain('${JWT_SECRET:?JWT_SECRET is required}')
    expect(compose).toContain('PUBLIC_ISSUER_URL: "https://www.pocketctl.me"')
  })
})

describe('email verification runtime configuration', () => {
  const longPepper = 'a'.repeat(32)

  test('requires AUTH_CODE_PEPPER in production and rejects short peppers', () => {
    expect(() => resolveEmailVerificationConfig({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toThrow('AUTH_CODE_PEPPER')
    expect(() => resolveEmailVerificationConfig({
      NODE_ENV: 'production',
      AUTH_CODE_PEPPER: 'too-short',
    } as NodeJS.ProcessEnv)).toThrow('AUTH_CODE_PEPPER')
  })

  test('rejects any DEV email backdoor variable in production', () => {
    expect(() => resolveEmailVerificationConfig({
      NODE_ENV: 'production',
      AUTH_CODE_PEPPER: longPepper,
      DEV_EMAIL: 'dev@example.test',
    } as NodeJS.ProcessEnv)).toThrow('DEV_EMAIL')
    expect(() => resolveEmailVerificationConfig({
      NODE_ENV: 'production',
      AUTH_CODE_PEPPER: longPepper,
      DEV_EMAIL_CODE: '123456',
    } as NodeJS.ProcessEnv)).toThrow('DEV_EMAIL')
  })

  test('accepts a fully explicit production configuration', () => {
    const config = resolveEmailVerificationConfig({
      NODE_ENV: 'production',
      AUTH_CODE_PEPPER: longPepper,
    } as NodeJS.ProcessEnv)
    expect(config.pepper).toBe(longPepper)
    expect(config.devShortcutEnabled).toBe(false)
  })

  test('dev mode falls back to an explicit insecure default pepper', () => {
    const config = resolveEmailVerificationConfig({
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv)
    expect(config.pepper.length).toBeGreaterThanOrEqual(32)
    expect(config.devShortcutEnabled).toBe(false)
  })

  test('dev shortcut requires both DEV_EMAIL and a 6-digit DEV_EMAIL_CODE', () => {
    expect(() => resolveEmailVerificationConfig({
      NODE_ENV: 'development',
      DEV_EMAIL: 'dev@example.test',
    } as NodeJS.ProcessEnv)).toThrow('DEV_EMAIL')
    expect(() => resolveEmailVerificationConfig({
      NODE_ENV: 'development',
      DEV_EMAIL: 'dev@example.test',
      DEV_EMAIL_CODE: 'not-six-digits',
    } as NodeJS.ProcessEnv)).toThrow('DEV_EMAIL')
    const config = resolveEmailVerificationConfig({
      NODE_ENV: 'development',
      DEV_EMAIL: 'dev@example.test',
      DEV_EMAIL_CODE: '424242',
    } as NodeJS.ProcessEnv)
    expect(config.devShortcutEnabled).toBe(true)
    expect(config.devEmail).toBe('dev@example.test')
    expect(config.devCode).toBe('424242')
  })
})

describe('trusted proxy admission configuration (M-1)', () => {
  test('no configuration trusts no proxy and keeps transport addresses', () => {
    expect(resolveTrustedProxyConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false)
  })

  test('parses an explicit comma-separated IP/CIDR trust list', () => {
    expect(resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/8, ::1/128, 10.0.0.5',
      RELAY_HOST: '0.0.0.0',
    } as NodeJS.ProcessEnv)).toEqual(['127.0.0.1/8', '::1/128', '10.0.0.5'])
  })

  test('rejects malformed CIDR entries by failing closed', () => {
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: 'not-an-ip',
      RELAY_HOST: '127.0.0.1',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/33',
      RELAY_HOST: '127.0.0.1',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: '::1/129',
      RELAY_HOST: '127.0.0.1',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8,banana',
      RELAY_HOST: '127.0.0.1',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
  })

  test('production rejects legacy TRUST_PROXY=true with migration guidance', () => {
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      TRUST_PROXY: 'true',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
  })

  test('non-production tolerates TRUST_PROXY=false but never trusts all proxies for TRUST_PROXY=true', () => {
    expect(resolveTrustedProxyConfig({
      NODE_ENV: 'development',
      TRUST_PROXY: 'false',
    } as NodeJS.ProcessEnv)).toBe(false)
    expect(resolveTrustedProxyConfig({
      NODE_ENV: 'development',
      TRUST_PROXY: 'true',
    } as NodeJS.ProcessEnv)).toBe(false)
  })

  test('production fails closed when publicly listening without a trust list', () => {
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      RELAY_HOST: '0.0.0.0',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
    expect(() => resolveTrustedProxyConfig({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toThrow('TRUSTED_PROXY_CIDRS')
  })

  test('production allows loopback-only listening without trusted proxies', () => {
    expect(resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      RELAY_HOST: '127.0.0.1',
    } as NodeJS.ProcessEnv)).toBe(false)
    expect(resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      RELAY_HOST: '::1',
    } as NodeJS.ProcessEnv)).toBe(false)
  })

  test('production allows public listening with an explicit trust list', () => {
    expect(resolveTrustedProxyConfig({
      NODE_ENV: 'production',
      RELAY_HOST: '0.0.0.0',
      TRUSTED_PROXY_CIDRS: '172.30.0.2/32',
    } as NodeJS.ProcessEnv)).toEqual(['172.30.0.2/32'])
  })

  test('resolves the listen host with a wildcard development default', () => {
    expect(resolveRelayListenHost({} as NodeJS.ProcessEnv)).toBe('0.0.0.0')
    expect(resolveRelayListenHost({ RELAY_HOST: '127.0.0.1' } as NodeJS.ProcessEnv)).toBe('127.0.0.1')
    expect(resolveRelayListenHost({ RELAY_HOST: ' 10.1.2.3 ' } as NodeJS.ProcessEnv)).toBe('10.1.2.3')
  })
})
