import { describe, expect, test, vi } from 'vitest'
import { initDB, listSessionsWithChildren, updateSessionActiveAgent } from '../db.js'

describe('OpenCode interaction DB state', () => {
  test('initDB adds active_agent without replacing agent_type', async () => {
    const queries: string[] = []
    const pool: any = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 } }) }
    await initDB(pool)
    expect(queries.some((sql) => /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_agent/i.test(sql))).toBe(true)
  })

  test('initDB adds the durable event effect ledger columns', async () => {
    const queries: string[] = []
    const pool: any = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 } }) }
    await initDB(pool)
    expect(queries.some((sql) => /ALTER TABLE events ADD COLUMN IF NOT EXISTS effect_status/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /ALTER TABLE events ADD COLUMN IF NOT EXISTS effect_step/i.test(sql))).toBe(true)
  })

  test('updateSessionActiveAgent writes only confirmed active agent', async () => {
    const pool: any = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }
    await updateSessionActiveAgent(pool, 'ses_1', 'build')
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE sessions SET active_agent = \$1/i),
      ['build', 'ses_1'],
    )
  })

  test('session lists expose active_agent alongside agent_type', async () => {
    const pool: any = {
      query: vi.fn(async (sql: string) => {
        if (/FROM subagents/i.test(sql)) return { rows: [] }
        expect(sql).toMatch(/s\.active_agent/)
        return { rows: [{
          session_id: 'ses_1', daemon_id: 'd1', agent_type: 'opencode', active_agent: 'build',
          cwd: '/repo', status: 'idle', total_tokens: 0,
        }] }
      }),
    }
    const sessions = await listSessionsWithChildren(pool)
    expect(sessions[0]).toMatchObject({ agent_type: 'opencode', active_agent: 'build' })
  })
})
