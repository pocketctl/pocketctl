import { afterEach, describe, expect, test } from 'vitest'
import { createPool } from '../db.js'

const baseConfig = {
  host: 'localhost', port: 5432, database: 'pocketctl', user: 'postgres', password: '',
}

const originalTimeout = process.env.DB_CONNECTION_TIMEOUT_MS

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.DB_CONNECTION_TIMEOUT_MS
  else process.env.DB_CONNECTION_TIMEOUT_MS = originalTimeout
})

describe('production PostgreSQL pool checkout timeout', () => {
  test('uses a finite safe default and supports a shorter configured timeout', async () => {
    delete process.env.DB_CONNECTION_TIMEOUT_MS
    const defaultPool = createPool(baseConfig)
    expect((defaultPool as any).options.connectionTimeoutMillis).toBe(5_000)
    await defaultPool.end()

    process.env.DB_CONNECTION_TIMEOUT_MS = '20'
    const configuredPool = createPool(baseConfig)
    expect((configuredPool as any).options.connectionTimeoutMillis).toBe(20)
    await configuredPool.end()
  })

  test('clamps a positive sub-millisecond timeout to one millisecond instead of disabling it', async () => {
    const pool = createPool({ ...baseConfig, connectionTimeoutMillis: 0.5 })
    expect((pool as any).options.connectionTimeoutMillis).toBe(1)
    await pool.end()
  })

  test('removes every full-pool checkout waiter after the driver timeout', async () => {
    process.env.DB_CONNECTION_TIMEOUT_MS = '20'
    const pool = createPool(baseConfig) as any
    pool.options.max = 1
    // Saturate without opening a real network connection. pg-pool's checkout
    // path only needs the client count to decide that new callers must wait.
    pool._clients.push({})

    const outcomes = Array.from({ length: 3 }, () => pool.connect().then(
      () => 'connected',
      (error: Error) => error.message,
    ))
    expect(pool.waitingCount).toBe(3)
    const settled = await Promise.race([
      Promise.all(outcomes),
      new Promise<string[]>((resolve) => setTimeout(() => resolve(['still pending']), 80)),
    ])

    expect(settled).toEqual([
      'timeout exceeded when trying to connect',
      'timeout exceeded when trying to connect',
      'timeout exceeded when trying to connect',
    ])
    expect(pool.waitingCount).toBe(0)
    pool._clients.length = 0
    await pool.end()
  })
})
