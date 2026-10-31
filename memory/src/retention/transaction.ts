import type pg from 'pg'

/** Lifecycle order: retention/migration barrier -> Session -> Installation ->
 * resource rows. Source writers take Session/Installation and never this key.
 * Change-log GC takes this key plus its own short table barrier, no source rows. */
export async function lockRetentionLifecycle(client: Pick<pg.PoolClient, 'query'>): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('memory:retention:migrations',0))")
}

export async function retentionTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'; SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'")
    await lockRetentionLifecycle(client)
    await client.query(`INSERT INTO memory_retention_control(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING`)
    const result = await fn(client)
    await client.query('UPDATE memory_retention_control SET generation=generation+1 WHERE singleton')
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function assertMigrationOpen(client: Pick<pg.PoolClient, 'query'>, runId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM memory_governance_migration_runs
    WHERE run_id=$1 AND sealed_at IS NULL AND abandoned_at IS NULL AND details_reclaimed_at IS NULL FOR SHARE`, [runId])
  if (!result.rowCount) throw new Error('migration_run_not_resumable')
}

/** Previews have no DDL/startup side effects and bounded server execution. */
export async function readRetentionPlan<T>(pool:pg.Pool,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect()
 try{await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='5s'");const result=await fn(c);await c.query('COMMIT');return result}
 catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}
}
