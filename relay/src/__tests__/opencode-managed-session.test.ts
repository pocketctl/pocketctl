import { describe, expect, test, vi } from 'vitest'
import { initDB, listSessionsWithChildren, updateSessionControl, upsertSession } from '../db.js'

describe('OpenCode managed session persistence', () => {
  test('migration adds nullable control mode and durable capabilities', async () => {
    const queries: string[] = []
    const pool: any = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 } }) }

    await initDB(pool)

    expect(queries.some((sql) => /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS control_mode/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS capabilities JSONB/i.test(sql))).toBe(true)
    expect(queries.some((sql) => /UPDATE sessions SET control_mode = 'managed'/i.test(sql))).toBe(false)
  })

  test('session list restores managed capabilities and defaults old OpenCode rows to legacy read-only', async () => {
    const pool: any = {
      query: vi.fn(async (sql: string) => {
        if (/FROM subagents/i.test(sql)) return { rows: [] }
        expect(sql).toMatch(/s\.control_mode/)
        expect(sql).toMatch(/s\.capabilities/)
        return { rows: [
          {
            session_id: 'ses_managed', daemon_id: 'd1', agent_type: 'opencode', cwd: '/repo', status: 'idle',
            control_mode: 'managed', capabilities: ['shared_runtime', 'terminal_coapproval', 'questions'], total_tokens: 0,
          },
          {
            session_id: 'ses_legacy', daemon_id: 'd1', agent_type: 'opencode', cwd: '/old', status: 'idle',
            control_mode: null, capabilities: null, total_tokens: 0,
          },
        ] }
      }),
    }

    const sessions = await listSessionsWithChildren(pool)

    expect(sessions[0]).toMatchObject({
      session_id: 'ses_managed', control_mode: 'managed',
      capabilities: ['shared_runtime', 'terminal_coapproval', 'questions'],
    })
    expect(sessions[1]).toMatchObject({
      session_id: 'ses_legacy', control_mode: 'legacy_read_only', capabilities: [],
    })
  })

  test('upsert persists daemon control claims without promoting missing claims', async () => {
    const pool: any = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }

    await upsertSession(
      pool, 'ses_1', 'd1', 'opencode', '/repo', 'idle', undefined, 'terminal', undefined, 7, undefined,
      'managed', ['shared_runtime', 'terminal_coapproval'],
    )

    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/control_mode, capabilities/)
    expect(sql).toMatch(/\$12::jsonb/)
    expect(sql).toMatch(/control_mode = COALESCE\(\$11, sessions\.control_mode\)/)
    expect(params[10]).toBe('managed')
    expect(params[11]).toBe(JSON.stringify(['shared_runtime', 'terminal_coapproval']))
  })

  test('session metadata can refresh the durable control claim', async () => {
    const pool: any = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }

    await updateSessionControl(pool, 'ses_1', 'managed', ['shared_runtime', 'questions'])

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE sessions SET control_mode = \$1, capabilities = \$2::jsonb/i),
      ['managed', JSON.stringify(['shared_runtime', 'questions']), 'ses_1'],
    )
  })
})
