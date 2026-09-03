import { describe, expect, test, vi } from 'vitest'
import { withBaselineTestTarget, type BaselineTestTarget } from '../testing/phase6-baseline-target.js'

// Controlled SQL identity boundary only; the real shared guard and its
// orchestration run unchanged. No connection or destructive SQL is executed.
function boundary(identity: { database: string; user: string; superuser: boolean }) {
  const events: string[] = []
  const pool = { query: async (sql: string) => {
    if (!sql.includes('current_database()') || !sql.includes('current_user') || !sql.includes('rolsuper')) throw new Error('unexpected query')
    events.push('identity'); return { rows: [identity] }
  } }
  return { pool, events, reset: async (target: BaselineTestTarget) => { events.push('reset'); return target } }
}
describe('baseline parent and child share the configurable integration target guard', () => {
  test.each([
    ['postgresql://alternate_test@localhost:65432/alternate_test', 'localhost', '65432', 'alternate_test'],
    ['postgres://ipv6_test@[::1]:55432/ipv6_test', '[::1]', '55432', 'ipv6_test'],
    ['postgresql://different_test@127.0.0.1:65096/different_test', '127.0.0.1', '65096', 'different_test'],
  ])('accepts legal alternative %s in both parent and child before reset', async (url, host, port, database) => {
    const f = boundary({ database, user: database, superuser: false })
    const expected = { host, port, database, user: database }
    const accepted = await withBaselineTestTarget(f.pool, url, undefined, f.reset)
    expect(accepted).toEqual(expected)
    expect(await withBaselineTestTarget(f.pool, url, accepted, f.reset)).toEqual(expected)
    expect(f.events).toEqual(['identity', 'reset', 'identity', 'reset'])
  })
  test('normalizes pg default ports identically between omitted and explicit child configuration', async () => {
    vi.stubEnv('PGPORT', '65431')
    const f = boundary({ database: 'default_test', user: 'default_test', superuser: false })
    try {
      const parent = await withBaselineTestTarget(f.pool, 'postgresql://default_test@localhost/default_test', undefined, f.reset)
      expect(parent.port).toBe('65431')
      expect(await withBaselineTestTarget(f.pool, 'postgres://default_test@localhost:65431/default_test', parent, f.reset)).toEqual(parent)
      expect(f.events).toEqual(['identity', 'reset', 'identity', 'reset'])
    } finally { vi.unstubAllEnvs() }
  })
  test('query-parameter target overrides cannot bypass the shared loopback policy before reset', async () => {
    const f = boundary({ database: 'fixture_test', user: 'fixture_test', superuser: false })
    await expect(withBaselineTestTarget(f.pool, 'postgresql://fixture_test@localhost/fixture_test?host=remote.invalid', undefined, f.reset)).rejects.toThrow('baseline_test_target_mismatch')
    expect(f.events).toEqual([])
  })
  test.each([
    'postgresql://fixture_test@remote.invalid/fixture_test',
    'postgresql://wrong_user@localhost/fixture_test',
    'postgresql://production@localhost/production',
    'postgresql://fixture_test@localhost/fixture_test?options=-csearch_path%3Dpublic',
    'not-a-database-url',
  ])('rejects illegal configured target before query/reset: %s', async url => {
    const f = boundary({ database: 'fixture_test', user: 'fixture_test', superuser: false })
    await expect(withBaselineTestTarget(f.pool, url, undefined, f.reset)).rejects.toThrow()
    expect(f.events).toEqual([])
  })
  test.each(['host', 'port', 'database', 'user'] as const)('rejects parent/child %s mismatch before identity query or reset', async field => {
    const f = boundary({ database: 'memory_phase6_test', user: 'memory_phase6_test', superuser: false })
    const expected = { host: '127.0.0.1', port: '65096', database: 'memory_phase6_test', user: 'memory_phase6_test', [field]: 'different' }
    await expect(withBaselineTestTarget(f.pool, 'postgresql://memory_phase6_test@127.0.0.1:65096/memory_phase6_test', expected, f.reset)).rejects.toThrow('baseline_test_target_mismatch')
    expect(f.events).toEqual([])
  })
  test.each([
    { database: 'fixture_test', user: 'fixture_test', superuser: true },
    { database: 'other_test', user: 'other_test', superuser: false },
    { database: 'fixture_test', user: 'wrong_role', superuser: false },
  ])('rejects connected identity mismatch/superuser before reset %#', async identity => {
    const f = boundary(identity)
    await expect(withBaselineTestTarget(f.pool, 'postgresql://fixture_test@localhost/fixture_test', undefined, f.reset)).rejects.toThrow('Refusing memory integration test')
    expect(f.events).toEqual(['identity'])
  })
  test('errors never reflect a URL credential', async () => {
    const f = boundary({ database: 'fixture_test', user: 'fixture_test', superuser: false })
    await expect(withBaselineTestTarget(f.pool, 'postgresql://fixture_test:SYNTHETIC_PASSWORD@remote.invalid/fixture_test', undefined, f.reset)).rejects.not.toThrow('SYNTHETIC_PASSWORD')
    expect(f.events).toEqual([])
  })
})
