import type pg from 'pg'

export type HealthPool = Pick<pg.Pool,'query'> & Partial<Pick<pg.Pool,'connect'>>

/** A bad plan or a long history must fail health polling, not tie up a pool
 * connection indefinitely. Server-side timeout actually cancels the query. */
export async function queryHealth<Row extends pg.QueryResultRow>(pool: HealthPool, text: string): Promise<pg.QueryResult<Row>> {
  // Query-only test adapters do not own a connection on which to set a timeout.
  if (!pool.connect) return pool.query<Row>(text)
  const client=await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SET LOCAL statement_timeout='3s'`)
    const result=await client.query<Row>(text)
    await client.query('COMMIT')
    return result
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined)
    throw error
  } finally {client.release()}
}
