import { describe, expect, test, vi } from 'vitest'
import { deleteSession } from '../db.js'

function poolWithQueries(ownerUserId?: number) {
  const statements: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql)
      if (/SELECT user_id FROM sessions/.test(sql) && ownerUserId !== undefined) {
        return { rows: [{ user_id: ownerUserId }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as any, statements }
}

describe('session deletion token accounting', () => {
  test('does not create legacy daily compensation when immutable facts are authoritative', async () => {
    const { pool, statements } = poolWithQueries()

    await deleteSession(pool, 'session-1', { usageFactsAuthoritative: true })

    expect(statements.some((sql) => sql.includes('INSERT INTO token_daily_stats'))).toBe(false)
    expect(statements.some((sql) => sql.includes('DELETE FROM token_session_daily_stats'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM events'))).toBe(true)
  })

  test('projects pending durable usage to idempotent inbox facts before deleting session content', async () => {
    const { pool, statements } = poolWithQueries()

    await deleteSession(pool, 'session-1', {
      usageFactsAuthoritative: true,
      writeUsageFacts: true,
    })

    const projection = statements.findIndex((sql) => sql.includes('INSERT INTO token_usage_facts'))
    const inboxDelete = statements.findIndex((sql) => sql.includes('DELETE FROM event_inbox'))
    expect(projection).toBeGreaterThan(0)
    expect(projection).toBeLessThan(inboxDelete)
    expect(statements[projection]).toContain("'inbox:' || inbox_id")
    expect(statements[projection]).toContain('status IN (0, 1)')
    expect(statements[projection]).toContain('inbox.status = 2')
    expect(statements[projection]).toContain("event_type = 'agent_text'")
    expect(statements.some((sql) => sql.includes('token-usage-accounting-global'))).toBe(true)
    expect(statements.some((sql) => sql.includes('session_attribution_revoked = true'))).toBe(true)
  })

  test('keeps legacy compensation while the facts feature is disabled', async () => {
    const { pool, statements } = poolWithQueries()

    await deleteSession(pool, 'session-1')

    const compensation = statements.find((sql) => sql.includes('INSERT INTO token_daily_stats')) ?? ''
    expect(compensation).toContain("NOW() AT TIME ZONE 'UTC'")
    expect(compensation).toContain("e.created_at AT TIME ZONE 'UTC'")
  })

  test('off mode purges extension content without appending a deletion tombstone', async () => {
    const { pool, statements } = poolWithQueries(42)

    await deleteSession(pool, 'session-1', { extensionMode: 'off' })

    expect(statements.some(sql => sql.includes('DELETE FROM extension_source_outbox'))).toBe(true)
    expect(statements.some(sql => sql.includes('DELETE FROM extension_feed'))).toBe(true)
    expect(statements.some(sql => sql.includes('INSERT INTO extension_source_outbox'))).toBe(false)
  })
})
