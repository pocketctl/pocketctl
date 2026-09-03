import type pg from 'pg'

/**
 * Present one already-open transaction as a Pool to repositories that own an
 * inner transaction. BEGIN/COMMIT/ROLLBACK become a savepoint, so their work
 * remains part of the API idempotency transaction.
 */
export function createTransactionBoundPool(client: pg.PoolClient): pg.Pool {
  let sequence = 0
  const commandOf=(input:unknown)=>{
    const sql=typeof input==='string'?input:input&&typeof input==='object'&&'text' in input&&typeof input.text==='string'?input.text:''
    return sql.trim().toUpperCase()
  }
  const control=/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SET\s+(?:LOCAL\s+)?TRANSACTION)\b/
  const query = (async(text:unknown,values?:unknown[])=>{
    if(control.test(commandOf(text)))throw new Error('unsupported_transaction_control')
    return client.query(text as never,values as never)
  }) as pg.Pool['query']
  return {
    query,
    async connect() {
      const savepoint = `memory_api_${++sequence}`
      let active = false
      return {
        query: (async (text: unknown, values?: unknown[]) => {
          {
            const command = commandOf(text)
            if (command === 'BEGIN' || command === 'BEGIN ISOLATION LEVEL READ COMMITTED') {
              if (active) throw new Error('nested_transaction_active')
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
            if (control.test(command)) {
              throw new Error('unsupported_transaction_control')
            }
          }
          return client.query(text as never, values as never)
        }) as pg.PoolClient['query'],
        release() {},
      } as pg.PoolClient
    },
  } as unknown as pg.Pool
}
