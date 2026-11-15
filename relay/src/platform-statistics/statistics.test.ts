import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import type { Pool } from 'pg'
import { parseStatisticsRange } from './range.js'
import { platformStatisticsConfig } from './config.js'
import { registerPlatformStatisticsRoutes } from './routes.js'

describe('statistics bounded Shanghai dates', () => {
  const now = new Date('2026-11-07T04:30:00Z')
  it('defaults to seven completed Shanghai dates', () => {
    const range = parseStatisticsRange({}, now)
    expect(range.from).toBe('2026-10-31')
    expect(range.to).toBe('2026-11-06')
    expect(range.start).toBe('2026-10-30T16:00:00.000Z')
    expect(range.end).toBe('2026-11-06T16:00:00.000Z')
    expect(range.previousFrom).toBe('2026-10-24')
  })
  it('matches current-day elapsed cutoff to the previous period', () => {
    const range = parseStatisticsRange({ from: '2026-11-01', to: '2026-11-07' }, now)
    expect(range.end).toBe(now.toISOString())
    expect(range.previousEnd).toBe('2026-10-31T04:30:00.000Z')
  })
  it.each([
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-01-01', to: '2026-11-01' },
    { from: '2026-11-07', to: '2026-11-06' },
    { from: '2026-11-07', to: '2026-11-08' },
    { from: '2026-11-07' },
    { timezone: 'UTC' },
    { userId: '1' },
  ])('rejects invalid/unbounded/client-scope query %j', query => {
    expect(() => parseStatisticsRange(query, now)).toThrow()
  })
})

describe('statistics owner authorization', () => {
  const pool = { query: async (sql: string, values: unknown[]) => {
    if (sql === 'SELECT email FROM users WHERE id=$1') return { rows: [{ email: values[0] === 42 ? 'james_2001_2001@163.com' : 'other@example.test' }] }
    throw new Error('must not query statistics without authorization')
  } } as unknown as Pool
  async function app(env: Record<string, string> = {}) {
    const instance = Fastify()
    registerPlatformStatisticsRoutes(instance, {
      pool, env: { PLATFORM_STATS_ENABLED: 'true', ...env },
      verifyAccessToken: async token => token === 'owner' ? { userId: 42 } : token === 'other' ? { userId: 3 } : null,
    })
    return instance
  }
  it('validates an optional positive account-id restriction', () => {
    for (const value of ['', '0', '-1', '1.2', '1e2', ' 42 ', 'invalid']) {
      expect(platformStatisticsConfig({ PLATFORM_STATS_ENABLED: 'true', PLATFORM_STATS_OWNER_USER_ID: value }).ownerUserId).toBeNull()
    }
  })
  it('never treats a valid nonowner as owner and capability returns only allowed', async () => {
    const instance = await app({ PLATFORM_STATS_OWNER_USER_ID: '42' })
    for (const endpoint of ['/api/admin/statistics', '/api/admin/statistics/export.csv']) {
      const denied = await instance.inject({ url: endpoint, headers: { authorization: 'Bearer other' } })
      expect(denied.statusCode).toBe(403)
      expect(denied.headers['cache-control']).toContain('no-store')
    }
    const access = await instance.inject({ url: '/api/admin/statistics/access', headers: { authorization: 'Bearer owner' } })
    expect(access.json()).toEqual({ allowed: true })
    await instance.close()
  })
  it('rejects missing/forged credentials, including capability, on every request', async () => {
    const instance = await app({ PLATFORM_STATS_OWNER_USER_ID: '42' })
    for (const url of ['/api/admin/statistics/access', '/api/admin/statistics', '/api/admin/statistics/export.csv']) {
      for (const headers of [{}, { authorization: 'Bearer forged' }]) {
        const response = await instance.inject({ url, headers })
        expect(response.statusCode).toBe(401)
        expect(response.headers['cache-control']).toContain('no-store')
      }
    }
    await instance.close()
  })
  it('denies an authenticated user while the feature is disabled', async () => {
    const instance = await app({ PLATFORM_STATS_ENABLED: 'false' })
    expect((await instance.inject({ url: '/api/admin/statistics/access', headers: { authorization: 'Bearer owner' } })).json()).toEqual({ allowed: false })
    expect((await instance.inject({ url: '/api/admin/statistics/export.csv', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(403)
    await instance.close()
  })
})
