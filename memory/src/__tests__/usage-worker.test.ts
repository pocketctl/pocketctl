import { describe, expect, test, vi } from 'vitest'
import { createUsageWorker } from '../reporting/usage-worker.js'

const FACT = {
  usage_id: 'u1', operation: 'candidate_extract', model: 'm',
  input_tokens: '1', output_tokens: '2', embedding_tokens: '0', cached_tokens: '0',
  cost_micros: '3', occurred_at: new Date('2026-08-25T00:00:00Z'), attempts: 0,
}

describe('usage worker isolation and retry accounting', () => {
  test('a failed installation records attempts and does not starve the next installation', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT installation_id')) return { rows: [
        { ...FACT, installation_id: '11111111-1111-4111-8111-111111111111' },
        { ...FACT, usage_id: 'u2', installation_id: '22222222-2222-4222-8222-222222222222' },
      ] }
      if (sql.includes('last_error_code=$4')) return { rows: [{ attempts: 1 }] }
      return { rows: [], rowCount:1 }
    })
    const reportUsage = vi.fn(async (installationId: string) => {
      if (installationId.startsWith('1')) throw Object.assign(new Error('no'), { code: 'relay_unavailable' })
      return 1
    })
    const worker = createUsageWorker({ pool: { query } as never, reportUsage })
    expect(await worker.runOnce()).toBe(1)
    expect(reportUsage).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('last_error_code'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('reported_at = NOW()'))).toBe(true)
  })

  test('an exhausted transient failure is deferred for a probe using its original ID', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT installation_id')) return { rows: [
        { ...FACT, attempts: 9, installation_id: '11111111-1111-4111-8111-111111111111' },
      ] }
      if (sql.includes('last_error_code=$4')) return { rows: [{ attempts: 10 }] }
      return { rows: [], rowCount:1 }
    })
    const worker = createUsageWorker({
      pool: { query } as never,
      reportUsage: vi.fn(async () => { throw new Error('still failing') }),
    })
    expect(await worker.runOnce()).toBe(0)
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WHEN attempts>=9 THEN 'probe'"))).toBe(true)
  })
  test('isolates a rejected fact without charging valid siblings a failed attempt', async () => {
    const updates: Array<{sql:string; args:unknown[]}> = []
    const query = vi.fn(async (sql:string,args:unknown[] = []) => {
      if(sql.includes('SELECT installation_id'))return {rows:['bad','good'].map(usage_id=>({...FACT,usage_id,installation_id:'11111111-1111-4111-8111-111111111111'}))}
      updates.push({sql,args});return {rows:[],rowCount:1}
    })
    const reportUsage = vi.fn(async (_id:string,facts:Array<Record<string,unknown>>) => {
      if(facts.some(f=>f.usage_id==='bad'))throw Object.assign(new Error('rejected'),{code:'invalid_request',status:400})
      return facts.length
    })
    const worker=createUsageWorker({pool:{query} as never,reportUsage})
    expect(await worker.runOnce()).toBe(1)
    expect(updates.filter(u=>u.sql.includes('last_error_code=$4')).map(u=>u.args[1])).toEqual(['bad'])
    expect(updates.filter(u=>u.sql.includes('reported_at = NOW()')).map(u=>u.args[1])).toEqual(['good'])
  })
  test('does not split rate limits even when their code is invalid_request', async () => {
    const query=vi.fn(async (sql:string)=>({rows:sql.includes('SELECT installation_id')
      ? ['one','two'].map(usage_id=>({...FACT,usage_id,installation_id:'11111111-1111-4111-8111-111111111111'})):[{attempts:1}]}))
    const reportUsage=vi.fn(async()=>{throw Object.assign(new Error('rate limit'),{code:'invalid_request',status:429})})
    await createUsageWorker({pool:{query} as never,reportUsage}).runOnce()
    expect(reportUsage).toHaveBeenCalledTimes(1)
  })

  test('bounds poison-batch isolation while leaving unvisited facts untouched',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT installation_id')
      ? Array.from({length:100},(_,i)=>({...FACT,usage_id:`bad-${i}`,installation_id:'11111111-1111-4111-8111-111111111111'})):[{attempts:1}]}))
    const reportUsage=vi.fn(async()=>{throw Object.assign(new Error('bad fact'),{code:'invalid_request',status:400})})
    await createUsageWorker({pool:{query} as never,reportUsage}).runOnce()
    expect(reportUsage).toHaveBeenCalledTimes(15)
    const attempts=query.mock.calls.filter(([sql])=>sql.includes('last_error_code=$4')).length
    expect(attempts).toBeGreaterThan(0);expect(attempts).toBeLessThan(15)
    expect(query.mock.calls.some(([sql])=>sql.includes('dead_lettered_at = NOW()'))).toBe(false)
  })

})
