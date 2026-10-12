import pg from 'pg'
import {MEMORY_WRITER_STARTUP_OPTIONS} from './migrations/governance-v2/compatibility.js'
import type { MemoryConfig } from './config.js'

/**
 * PostgreSQL pool factory. Both processes share one database; the pool bound
 * is config-owned so tests and production cannot accidentally oversubscribe
 * connections.
 */
export function createMemoryPool(config: Pick<MemoryConfig, 'databaseUrl' | 'dbPoolMax'>): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    // Startup packet applies to every connection before its first query;
    // an asynchronous pool connect listener would race the first mutation.
    options: MEMORY_WRITER_STARTUP_OPTIONS,
  })
}

/**
 * Run work inside a single transaction. The callback owns the client only for
 * the transaction's lifetime; a thrown error rolls back and rethrows.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    client.release()
  }
}
