import { afterEach, describe, expect, test, vi } from 'vitest'
import { closeRelayPools, createRelayPools } from '../db-pools.js'

const config = {
  host: 'localhost', port: 5432, database: 'pocketctl', user: 'postgres', password: '',
}

const poolMax = (pool: any) => pool.options.max

describe('relay PostgreSQL workload pools', () => {
  test('creates four bounded pools with reserved control capacity', async () => {
    const pools = createRelayPools(config, {
      DB_CONTROL_POOL_MAX: '4', DB_INGEST_POOL_MAX: '8',
      DB_QUERY_POOL_MAX: '8', DB_WORKER_POOL_MAX: '8',
    })

    expect(poolMax(pools.control)).toBe(4)
    expect(poolMax(pools.ingest)).toBe(8)
    expect(poolMax(pools.query)).toBe(8)
    expect(poolMax(pools.worker)).toBe(8)
    expect((pools.control as any).options.connectionTimeoutMillis).toBe(200)
    expect((pools.ingest as any).options.connectionTimeoutMillis).toBe(500)
    expect((pools.query as any).options.connectionTimeoutMillis).toBe(1_000)
    expect((pools.worker as any).options.connectionTimeoutMillis).toBe(1_000)
    expect((pools.control as any).options.application_name).toBe('pocketctl-relay-control')
    expect((pools.ingest as any).options.application_name).toBe('pocketctl-relay-ingest')
    expect((pools.query as any).options.application_name).toBe('pocketctl-relay-query')
    expect((pools.worker as any).options.application_name).toBe('pocketctl-relay-worker')
    // Checkout deadlines protect admission; statement limits protect the work
    // after a connection is acquired. They must be configured independently.
    expect((pools.control as any).options.statement_timeout).toBe(1_000)
    expect((pools.ingest as any).options.statement_timeout).toBe(5_000)
    expect((pools.query as any).options.statement_timeout).toBe(15_000)
    expect((pools.worker as any).options.statement_timeout).toBe(30_000)

    await closeRelayPools(pools)
  })

  test('closes every workload pool', async () => {
    const pools = createRelayPools(config, {})
    await closeRelayPools(pools)
    await Promise.all(Object.values(pools).map((pool: any) => expect(pool.ended).toBe(true)))
  })

  test('uses default total and single-pool budgets when they are unset', async () => {
    const pools = createRelayPools(config, {})
    expect(Object.values(pools).reduce((total, pool: any) => total + pool.options.max, 0)).toBe(28)
    await closeRelayPools(pools)
  })

  test.each(['0', '', '28junk', '1.5', '-1', ' 28', '1e2'])(
    'rejects invalid explicit total budget %j',
    (DB_POOL_TOTAL_MAX) => {
      expect(() => createRelayPools(config, { DB_POOL_TOTAL_MAX })).toThrow('DB_POOL_TOTAL_MAX must be a positive decimal integer')
    },
  )

  test.each(['0', '', '28junk', '1.5'])('rejects invalid explicit single-pool budget %j', (DB_POOL_SINGLE_MAX) => {
    expect(() => createRelayPools(config, { DB_POOL_SINGLE_MAX })).toThrow('DB_POOL_SINGLE_MAX must be a positive decimal integer')
  })

  test('accepts a strict decimal total budget override', async () => {
    const pools = createRelayPools(config, {
      DB_CONTROL_POOL_MAX: '4', DB_INGEST_POOL_MAX: '9',
      DB_QUERY_POOL_MAX: '8', DB_WORKER_POOL_MAX: '8', DB_POOL_TOTAL_MAX: '29',
    })
    expect(Object.values(pools).reduce((total, pool: any) => total + pool.options.max, 0)).toBe(29)
    await closeRelayPools(pools)
  })

  test('allows a bounded override within the declared connection budget', async () => {
    const pools = createRelayPools(config, {
      DB_CONTROL_POOL_MAX: '5', DB_INGEST_POOL_MAX: '9',
      DB_QUERY_POOL_MAX: '9', DB_WORKER_POOL_MAX: '9',
      DB_POOL_TOTAL_MAX: '32', DB_POOL_SINGLE_MAX: '16',
    })
    expect(Object.values(pools).reduce((total, pool: any) => total + pool.options.max, 0)).toBe(32)
    await closeRelayPools(pools)
  })

  test('fails fast when one pool exceeds the declared cap without leaking config secrets', () => {
    expect(() => createRelayPools({ ...config, password: 'super-secret-password' }, {
      DB_INGEST_POOL_MAX: '17', DB_POOL_SINGLE_MAX: '16',
    })).toThrow('DB_INGEST_POOL_MAX exceeds DB_POOL_SINGLE_MAX')
    try {
      createRelayPools({ ...config, password: 'super-secret-password' }, {
        DB_INGEST_POOL_MAX: '17', DB_POOL_SINGLE_MAX: '16',
      })
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-password')
    }
  })

  test('fails fast when pool totals exceed the declared connection budget', () => {
    expect(() => createRelayPools(config, {
      DB_CONTROL_POOL_MAX: '4', DB_INGEST_POOL_MAX: '9',
      DB_QUERY_POOL_MAX: '8', DB_WORKER_POOL_MAX: '8',
    })).toThrow('pool total 29 exceeds DB_POOL_TOTAL_MAX 28')
  })

  test('ends a shared pool only once', async () => {
    const end = async () => undefined
    const shared = { end } as any
    const pools = { control: shared, ingest: shared, query: shared, worker: shared }
    const spy = vi.spyOn(shared, 'end')
    await closeRelayPools(pools)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
