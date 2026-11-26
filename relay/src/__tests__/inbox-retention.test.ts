import { describe, expect, test, vi } from 'vitest'
import { cleanStaleEvents } from '../db.js'
import { InboxRetention } from '../inbox-retention.js'

function retentionPool(failInbox=false) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({sql,params})
      if (sql.includes('SELECT i.inbox_id FROM event_inbox')) return {rows:[{inbox_id:'1'}],rowCount:1}
      if (sql.includes('DELETE FROM event_inbox i')) {
        if (failInbox) throw Object.assign(new Error('sensitive detail'),{code:'57014'})
        return {rows:[],rowCount:1}
      }
      if (sql.includes('DELETE FROM realtime_outbox') || sql.includes('DELETE FROM event_inbox_receipt')) return {rows:[],rowCount:1}
      if (sql.includes('GROUP BY reason')) return {rows:[{reason:'undelivered',count:1}],rowCount:1}
      return {rows:[],rowCount:0}
    }),
    release:vi.fn(),
  }
  return {calls,client,pool:{connect:vi.fn().mockResolvedValue(client)} as any}
}

describe('InboxRetention', () => {
  test('commits stages separately and records results without business payloads', async () => {
    const {calls,client,pool}=retentionPool()
    await expect(new InboxRetention(pool).runOnce()).resolves.toMatchObject({
      deletedCompleted:1,deletedOutbox:1,deletedReceipts:1,blockedUndelivered:1,failures:[],moreWork:false,
    })
    expect(calls.filter(x=>x.sql==='COMMIT')).toHaveLength(6)
    expect(client.release).toHaveBeenCalledTimes(6)
    expect(calls.filter(x=>x.sql.includes('DELETE FROM')&&!x.sql.includes('DELETE FROM event_inbox i')).every(x=>x.params?.[0]===1000)).toBe(true)
  })
  test('reports a failed stage, retains previous successes, and still attempts later stages', async () => {
    const {calls,pool}=retentionPool(true)
    await expect(new InboxRetention(pool).runOnce()).resolves.toMatchObject({
      deletedCompleted:0,deletedOutbox:1,deletedReceipts:1,
      failures:[{stage:'inbox',code:'57014',receiptPersisted:true}],
    })
    expect(calls.filter(x=>x.sql==='ROLLBACK')).toHaveLength(1)
    expect(calls.filter(x=>x.sql==='COMMIT')).toHaveLength(6)
    expect(calls.some(x=>x.sql.includes('DELETE FROM session_document_uploads'))).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('sensitive detail')
  })
  test('backs off only the failed stage while independent stages keep running', async () => {
    vi.useFakeTimers()
    try {
      const {calls,pool}=retentionPool(true)
      const retention=new InboxRetention(pool)
      await retention.runOnce()
      await retention.runOnce()
      expect(calls.filter(x=>x.sql.includes('DELETE FROM event_inbox i'))).toHaveLength(1)
      expect(calls.filter(x=>x.sql.includes('DELETE FROM realtime_outbox'))).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(60000)
      await retention.runOnce()
      expect(calls.filter(x=>x.sql.includes('DELETE FROM event_inbox i'))).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
  test('a connection failure cannot claim cleanup success', async () => {
    const pool={connect:vi.fn().mockRejectedValue(Object.assign(new Error('offline'),{code:'08006'}))} as any
    const result=await new InboxRetention(pool).runOnce()
    expect(result.failures).toHaveLength(6)
    expect(result.failures.every(x=>x.code==='08006'&&!x.receiptPersisted)).toBe(true)
    expect(result.deletedCompleted).toBe(0)
  })
  test('retired event-age retention never removes canonical history', async () => {
    const pool={query:vi.fn().mockResolvedValue({rows:[],rowCount:4})} as any
    await expect(cleanStaleEvents(pool,90)).resolves.toBe(0)
    expect(pool.query).not.toHaveBeenCalled()
  })
})
