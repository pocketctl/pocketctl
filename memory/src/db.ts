import {detachRetainedSourceGuards} from './sources/retained-authority.js'
import pg from 'pg'
import {detachPreparedSources} from './sources/prepared-sources.js'
import {detachPreparedEvidence} from './sources/evidence-sources.js'
import {createSourceArchiveReader} from './sources/archive-reader.js'
import {bindSourcePool,inheritSourcePool,registerPhysicalSourcePool} from './sources/pool-context.js'
import {MEMORY_WRITER_STARTUP_OPTIONS} from './migrations/governance-v2/compatibility.js'
import type { MemoryConfig } from './config.js'

/**
 * PostgreSQL pool factory. Both processes share one database; the pool bound
 * is config-owned so tests and production cannot accidentally oversubscribe
 * connections.
 */
export function createMemoryPool(
  config: Pick<MemoryConfig, 'databaseUrl' | 'dbPoolMax' | 'databaseNamespace' | 'sourceArchive'>,
  options: { retainIdleConnections?: number } = {},
): pg.Pool {
  const pool=new pg.Pool({
    connectionString: config.databaseUrl,
    application_name:'pocketctl-memory',
    max: config.dbPoolMax,
    min: Math.min(config.dbPoolMax, options.retainIdleConnections ?? 0),
    // Startup packet applies to every connection before its first query;
    // an asynchronous pool connect listener would race the first mutation.
    options: MEMORY_WRITER_STARTUP_OPTIONS+(config.databaseNamespace==='memory'?' -c search_path=pg_catalog,memory,shared':' -c search_path=pg_catalog,public'),
  })
  registerPhysicalSourcePool(pool)
  bindSourcePool(pool,{namespace:config.databaseNamespace??'public',...(config.sourceArchive?{archive:{storage:createSourceArchiveReader(config.sourceArchive.directory,config.sourceArchive.namespace),limits:{maxRawBytes:32*1024*1024,maxCompressedBytes:16*1024*1024,maxRecords:10000}}}:{})})
  pool.on('acquire',client=>{detachPreparedSources(client);detachPreparedEvidence(client);detachRetainedSourceGuards(client);inheritSourcePool(client,pool)})
  pool.on('release',(_error,client)=>{detachPreparedSources(client);detachPreparedEvidence(client);detachRetainedSourceGuards(client)})
  return pool
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
