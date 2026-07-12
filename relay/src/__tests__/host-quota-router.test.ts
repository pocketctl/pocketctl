import { describe, expect, test, vi } from 'vitest'
import { Router } from '../router.js'

process.env.QUOTA_ENFORCEMENT = 'enforce'

function ws(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    _sent: sent,
  }
}

function hostQuotaPool() {
  const bindings = new Map<string, number>()
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('SELECT plan, whitelist')) return { rows: [{ plan: 'free', whitelist: false }] }
    if (sql.includes('SELECT user_id FROM daemons')) {
      const owner = bindings.get(params[0])
      return { rows: owner === undefined ? [] : [{ user_id: owner }] }
    }
    if (sql.includes('COUNT(*)::int AS count') && sql.includes('FROM daemons')) {
      return { rows: [{ count: [...bindings.values()].filter((id) => id === params[0]).length }] }
    }
    if (sql.includes('INSERT INTO daemons') && sql.includes('user_id')) {
      bindings.set(params[0], params[1])
      return { rows: [] }
    }
    if (sql.includes('SELECT 1 FROM daemons')) {
      return { rows: bindings.get(params[0]) === params[1] ? [{ '?column?': 1 }] : [], rowCount: bindings.get(params[0]) === params[1] ? 1 : 0 }
    }
    if (sql.includes('DELETE FROM daemons')) {
      bindings.delete(params[0])
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT alias FROM daemons')) return { rows: [] }
    if (sql.includes('SELECT daemon_id FROM sessions')) return { rows: [] }
    if (sql.includes('UPDATE sessions') && sql.includes('RETURNING session_id')) return { rows: [] }
    return { rows: [], rowCount: 0 }
  })
  const client = { query, release: vi.fn() }
  return {
    pool: { query, connect: vi.fn(async () => client), end: vi.fn() } as any,
    bindings,
  }
}

describe('Router bound-host quota', () => {
  test('allows two bound hosts and rejects the third without evicting either host', async () => {
    const { pool, bindings } = hostQuotaPool()
    const router = new Router(pool)
    const first = ws()
    const second = ws()
    const third = ws()

    await router.registerDaemon(first, { type: 'register', daemon_id: 'd1', hostname: 'one', agents: [], supports_quota_grant: true }, 7)
    await router.registerDaemon(second, { type: 'register', daemon_id: 'd2', hostname: 'two', agents: [], supports_quota_grant: true }, 7)
    await router.registerDaemon(third, { type: 'register', daemon_id: 'd3', hostname: 'three', agents: [], supports_quota_grant: true }, 7)

    expect(first._sent).toContainEqual(expect.objectContaining({ type: 'register_ack' }))
    expect(second._sent).toContainEqual(expect.objectContaining({ type: 'register_ack' }))
    expect(first._sent.some((event: any) => event.type === 'kicked')).toBe(false)
    expect(second._sent.some((event: any) => event.type === 'kicked')).toBe(false)
    expect(third._sent).toContainEqual(expect.objectContaining({
      type: 'register_rejected',
      reason: 'host_quota_exceeded',
      resource: 'bound_hosts',
      used: 2,
      limit: 2,
    }))
    expect(bindings.has('d3')).toBe(false)
  })

  test('treats an existing daemon id as a reconnect without consuming another slot', async () => {
    const { pool, bindings } = hostQuotaPool()
    bindings.set('d1', 7)
    bindings.set('d2', 7)
    const router = new Router(pool)
    const reconnect = ws()

    await router.registerDaemon(reconnect, { type: 'register', daemon_id: 'd1', hostname: 'one', agents: [], supports_quota_grant: true }, 7)

    expect(reconnect._sent).toContainEqual(expect.objectContaining({ type: 'register_ack' }))
    expect(reconnect._sent.some((event: any) => event.type === 'register_rejected')).toBe(false)
    expect(bindings.size).toBe(2)
  })

  test('force disconnect keeps a binding while delete disconnects and releases it', async () => {
    const { pool, bindings } = hostQuotaPool()
    const router = new Router(pool)
    const daemon = ws()
    await router.registerDaemon(daemon, { type: 'register', daemon_id: 'd1', hostname: 'one', agents: [], supports_quota_grant: true }, 7)

    await router.handleForceKick('d1', 7)
    expect(bindings.has('d1')).toBe(true)

    // Re-register the same bound host, then explicitly delete it.
    const reconnected = ws()
    await router.registerDaemon(reconnected, { type: 'register', daemon_id: 'd1', hostname: 'one', agents: [], supports_quota_grant: true }, 7)
    const result = await router.handleDeleteDaemon('d1', 7)

    expect(result.success).toBe(true)
    expect(reconnected._sent).toContainEqual(expect.objectContaining({ type: 'kicked', reason: 'host_unbound' }))
    expect(bindings.has('d1')).toBe(false)
  })
})
