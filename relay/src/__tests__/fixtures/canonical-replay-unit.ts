/** Extend existing SQL fakes with immutable canonical rows. Most legacy fakes
 * seed a completed ledger on their first INSERT attempt; freeze that fixture's
 * payload too. Actual identity, authorization, archive and conflict behavior
 * is tested against PostgreSQL, not this deliberately narrow SQL fake. */
export function withCanonicalReplayRows<T extends (sql: string, ...args: any[]) => any>(query: T): T {
  const payloads = new Map<string, unknown>()
  const attempted = new Map<string, unknown>()
  return ((sql: string, ...args: any[]) => {
    const params = args[0] ?? []
    if (sql.includes('INSERT INTO events') && typeof params[2] === 'string') {
      const key = `${params[0]}:${params[3]}`
      if (!payloads.has(key)) payloads.set(key, JSON.parse(params[2]))
      attempted.set(`${params[0]}:${params[1]}`, payloads.get(key))
    }
    if (sql.includes('SELECT events.*,id::text')) {
      const payload = attempted.get(`${params[2]}:${params[3]}`)
      return Promise.resolve({rows: payload ? [{id:String(params[0]),payload,body_storage:'hot'}] : [],rowCount:payload?1:0})
    }
    return query(sql, ...args)
  }) as T
}
