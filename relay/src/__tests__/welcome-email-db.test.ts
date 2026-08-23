import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  claimWelcomeEmails,
  createUserWithWelcomeEmail,
  markWelcomeEmailSent,
  rescheduleWelcomeEmail,
} from '../db.js'

function transactionClient(handler?: (sql: string, params?: any[]) => any) {
  const calls: Array<{ sql: string; params?: any[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params })
      if (handler) return handler(sql, params)
      if (/INSERT INTO users/i.test(sql)) return { rows: [{ id: 7, email: 'person@example.com' }] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return { calls, client, pool: { connect: vi.fn().mockResolvedValue(client) } as any }
}

describe('welcome email transactional outbox', () => {
  test('schema restricts type to welcome and indexes active processing leases', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/db.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/email_type VARCHAR\(32\) NOT NULL[^\n]*CHECK \(email_type = 'welcome'\)/)
    expect(source).toMatch(/ALTER TABLE email_outbox[\s\S]*ADD CONSTRAINT email_outbox_email_type_check CHECK \(email_type = 'welcome'\)/)
    expect(source).toMatch(/CREATE INDEX IF NOT EXISTS idx_email_outbox_processing_locked[\s\S]*ON email_outbox \(locked_at\)[\s\S]*WHERE status = 'processing'/)
  })
  test('creates a normalized user and welcome intent in one transaction', async () => {
    const { calls, client, pool } = transactionClient()

    await createUserWithWelcomeEmail(pool, ' Person@Example.COM ', 'hash', 'Person', 'zh')

    expect(calls.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'BEGIN', 'INSERT INTO users', 'INSERT INTO email_outbox', 'COMMIT',
    ])
    expect(calls[1].params).toEqual(['person@example.com', 'hash', 'Person'])
    expect(calls[2].sql).toMatch(/INSERT INTO email_outbox \(user_id, email_type, recipient_email, locale\)\s+VALUES \(\$1, 'welcome', \$2, \$3\)\s+ON CONFLICT \(user_id, email_type\) DO NOTHING/i)
    expect(calls[2].params).toEqual([7, 'person@example.com', 'zh'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  test.each(['user', 'outbox'] as const)('rolls back and releases when the %s insert fails', async failure => {
    const { client, pool } = transactionClient(sql => {
      if (failure === 'user' && /INSERT INTO users/i.test(sql)) throw new Error('user failed')
      if (/INSERT INTO users/i.test(sql)) return { rows: [{ id: 7, email: 'person@example.com' }] }
      if (failure === 'outbox' && /INSERT INTO email_outbox/i.test(sql)) throw new Error('outbox failed')
      return { rows: [] }
    })

    await expect(createUserWithWelcomeEmail(pool, 'person@example.com', 'hash', 'Person', 'en'))
      .rejects.toThrow(`${failure} failed`)
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('preserves the insert error when rollback also fails and still releases', async () => {
    const original = new Error('outbox failed')
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/INSERT INTO users/i.test(sql)) return { rows: [{ id: 7, email: 'person@example.com' }] }
        if (/INSERT INTO email_outbox/i.test(sql)) throw original
        if (sql === 'ROLLBACK') throw new Error('rollback failed')
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn().mockResolvedValue(client) }

    await expect(createUserWithWelcomeEmail(pool, 'person@example.com', 'hash', 'Person', 'en'))
      .rejects.toBe(original)
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('claims due pending and stale processing jobs without blocking other workers', async () => {
    const pool: any = { query: vi.fn().mockResolvedValue({ rows: [{
      id: '11', userId: 7, recipientEmail: 'person@example.com', locale: 'en', attemptCount: 2,
    }] }) }
    const cutoff = new Date('2026-07-13T01:00:00Z')

    const jobs = await claimWelcomeEmails(pool, 5, cutoff)

    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i)
    expect(sql).toMatch(/status = 'pending'.*next_attempt_at <= NOW\(\)/is)
    expect(sql).toMatch(/status = 'processing'.*locked_at < \$2/is)
    expect(sql).toMatch(/LIMIT \$1/i)
    expect(sql).toMatch(/SET status = 'processing'.*attempt_count = .*attempt_count \+ 1.*locked_at = NOW\(\)/is)
    expect(sql).toMatch(/user_id AS "userId".*recipient_email AS "recipientEmail".*attempt_count AS "attemptCount"/is)
    expect(params).toEqual([5, cutoff])
    expect(jobs).toEqual([{
      id: '11', userId: 7, recipientEmail: 'person@example.com', locale: 'en', attemptCount: 2,
    }])
  })

  test('marks a claimed job sent and clears its lease and error', async () => {
    const pool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await markWelcomeEmailSent(pool, '11', 2, 'message-123')
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/status = 'sent'/i)
    expect(sql).toMatch(/message_id = \$3/i)
    expect(sql).toMatch(/sent_at = NOW\(\)/i)
    expect(sql).toMatch(/locked_at = NULL/i)
    expect(sql).toMatch(/last_error = NULL/i)
    expect(sql).toMatch(/WHERE id = \$1.*attempt_count = \$2.*status = 'processing'/is)
    expect(params).toEqual(['11', 2, 'message-123'])
  })

  test('reschedules a failed job, clears its lease, and bounds its stored error', async () => {
    const pool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const next = new Date('2026-07-13T02:00:00Z')
    await rescheduleWelcomeEmail(pool, '11', 2, next, 'x'.repeat(1200))
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/status = 'pending'/i)
    expect(sql).toMatch(/next_attempt_at = \$3/i)
    expect(sql).toMatch(/last_error = \$4/i)
    expect(sql).toMatch(/locked_at = NULL/i)
    expect(sql).toMatch(/WHERE id = \$1.*attempt_count = \$2.*status = 'processing'/is)
    expect(params).toEqual(['11', 2, next, 'x'.repeat(1000)])
  })

  test.each(['complete', 'reschedule'] as const)('%s with stale generation N cannot update claim N+1, while N+1 can', async action => {
    const state = { status: 'processing', attemptCount: 3 }
    const pool: any = { query: vi.fn(async (sql: string, params: any[]) => {
      const fenced = /status = 'processing'/i.test(sql)
        && /attempt_count = \$2/i.test(sql)
        && params[1] === state.attemptCount
      if (!fenced) return { rows: [], rowCount: 0 }
      state.status = action === 'complete' ? 'sent' : 'pending'
      return { rows: [], rowCount: 1 }
    }) }

    if (action === 'complete') {
      await markWelcomeEmailSent(pool, '11', 2, 'stale-message')
    } else {
      await rescheduleWelcomeEmail(pool, '11', 2, new Date('2026-07-13T02:00:00Z'), 'stale error')
    }

    await expect(pool.query.mock.results[0].value).resolves.toMatchObject({ rowCount: 0 })
    expect(state).toEqual({ status: 'processing', attemptCount: 3 })

    if (action === 'complete') {
      await markWelcomeEmailSent(pool, '11', 3, 'current-message')
    } else {
      await rescheduleWelcomeEmail(pool, '11', 3, new Date('2026-07-13T02:00:00Z'), 'current error')
    }
    await expect(pool.query.mock.results[1].value).resolves.toMatchObject({ rowCount: 1 })
    expect(state.status).toBe(action === 'complete' ? 'sent' : 'pending')
  })
})
