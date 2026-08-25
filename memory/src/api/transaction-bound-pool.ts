import type pg from 'pg'

/**
 * Present one already-open transaction as a Pool to repositories that own an
 * inner transaction. BEGIN/COMMIT/ROLLBACK become a savepoint, so their work
 * remains part of the API idempotency transaction.
 */
export function createTransactionBoundPool(client: pg.PoolClient): pg.Pool {
  let sequence = 0
  const query = client.query.bind(client) as pg.Pool['query']
  return {
    query,
    async connect() {
      const savepoint = `memory_api_${++sequence}`
      let active = false
      return {
        query: (async (text: unknown, values?: unknown[]) => {
          if (typeof text === 'string') {
            const command = text.trim().toUpperCase()
            if (command === 'BEGIN') {
              await client.query(`SAVEPOINT ${savepoint}`)
              active = true
              return { rows: [], rowCount: null }
            }
            if (command === 'COMMIT') {
              if (active) await client.query(`RELEASE SAVEPOINT ${savepoint}`)
              active = false
              return { rows: [], rowCount: null }
            }
            if (command === 'ROLLBACK') {
              if (active) {
                await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
                await client.query(`RELEASE SAVEPOINT ${savepoint}`)
              }
              active = false
              return { rows: [], rowCount: null }
            }
          }
          return client.query(text as never, values as never)
        }) as pg.PoolClient['query'],
        release() {},
      } as pg.PoolClient
    },
  } as unknown as pg.Pool
}
