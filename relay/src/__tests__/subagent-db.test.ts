import { describe, test, expect, vi } from 'vitest'
import { upsertSubagent, addSubagentUsage, listSubagentsByParent, listSessionsWithChildren } from '../db.js'

describe('db subagent layer', () => {
  test('upsertSubagent inserts with toolUseId/agentType', async () => {
    const calls: any[] = []
    const pool: any = { query: vi.fn((sql: string, params: any[]) => { calls.push({ sql, params }); return Promise.resolve({ rows: [] }) }) }
    await upsertSubagent(pool, 'parent-1', 'agent-abc', 'claude_subagent', 'call_xyz', 'Explore', 'find foo')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('subagents')
    expect(calls[0].sql).toMatch(/ON CONFLICT.*DO UPDATE/i)
    expect(calls[0].params).toEqual(['parent-1', 'agent-abc', 'claude_subagent', 'call_xyz', 'Explore', 'find foo'])
  })

  test('addSubagentUsage accumulates token columns (INSERT ON CONFLICT)', async () => {
    const calls: any[] = []
    const pool: any = { query: vi.fn((sql: string, params: any[]) => { calls.push({ sql, params }); return Promise.resolve({ rows: [] }) }) }
    await addSubagentUsage(pool, 'parent-1', 'agent-abc', 100, 200, 50, 30)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('INSERT INTO subagents')
    expect(calls[0].sql).toMatch(/ON CONFLICT.*DO UPDATE/i)
    expect(calls[0].sql).toMatch(/subagents\.token_in\s*\+\s*\$3/i)
    expect(calls[0].sql).toMatch(/subagents\.token_out\s*\+\s*\$4/i)
    expect(calls[0].params).toEqual(['parent-1', 'agent-abc', 100, 200, 50, 30])
  })

  test('listSubagentsByParent maps rows', async () => {
    const pool: any = { query: vi.fn(() => Promise.resolve({ rows: [
      { parent_session_id: 'parent-1', agent_id: 'agent-a', agent_type: 'Explore', title: 't1', status: 'completed', token_in: 10, token_out: 20, token_cache: 5 }
    ] })) }
    const out = await listSubagentsByParent(pool as any, 'parent-1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ agentId: 'agent-a', agentType: 'Explore', tokenIn: 10, tokenOut: 20 })
  })
})

describe('db listSessions children aggregation', () => {
  test('attaches children grouped by parent_session_id', async () => {
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('FROM sessions s')) return Promise.resolve({ rows: [
          { session_id: 'parent-1', title: 'main', subagent_count: 1 },
          { session_id: 'parent-2', title: 'other', subagent_count: 0 },
        ] })
        if (sql.includes('FROM subagents')) return Promise.resolve({ rows: [
          { parent_session_id: 'parent-1', agent_id: 'agent-a', kind: 'claude_subagent', agent_type: 'Explore', title: 't', status: 'completed', token_in: 1, token_out: 2, token_cache: 3 },
        ] })
        return Promise.resolve({ rows: [] })
      }),
    }
    const out = await listSessionsWithChildren(pool)
    expect(out).toHaveLength(2)
    expect(out[0].children).toHaveLength(1)
    expect(out[0].children[0]).toMatchObject({ agentId: 'agent-a', agentType: 'Explore' })
    expect(out[1].children).toEqual([])
  })

  test('supports whereUser filter', async () => {
    const calls: any[] = []
    const pool: any = {
      query: vi.fn((sql: string, params: any[]) => {
        calls.push({ sql, params })
        if (sql.includes('FROM sessions s')) return Promise.resolve({ rows: [
          { session_id: 'parent-1', title: 'main', subagent_count: 0 },
        ] })
        if (sql.includes('FROM subagents')) return Promise.resolve({ rows: [] })
        return Promise.resolve({ rows: [] })
      }),
    }
    const out = await listSessionsWithChildren(pool, 42)
    expect(out).toHaveLength(1)
    // Verify the SQL contains the user filter
    expect(calls[0].sql).toContain('$1')
    expect(calls[0].params).toEqual([42])
  })

  test('children have all SubagentSummary fields', async () => {
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('FROM sessions s')) return Promise.resolve({ rows: [
          { session_id: 'parent-1', title: 'main', subagent_count: 1 },
        ] })
        if (sql.includes('FROM subagents')) return Promise.resolve({ rows: [
          { parent_session_id: 'parent-1', agent_id: 'agent-a', kind: 'claude_subagent', agent_type: 'Explore', title: 't', status: 'completed', token_in: 1, token_out: 2, token_cache: 3 },
        ] })
        return Promise.resolve({ rows: [] })
      }),
    }
    const out = await listSessionsWithChildren(pool)
    const child = out[0].children[0]
    expect(child).toEqual({
      agentId: 'agent-a',
      kind: 'claude_subagent',
      agentType: 'Explore',
      title: 't',
      status: 'completed',
      tokenIn: 1,
      tokenOut: 2,
      tokenCache: 3,
    })
  })

  test('totalTokens 含子代理：父 total_tokens + Σ各子 token 四列之和', async () => {
    // 父自己 1000，两个子：a=(100+200+50+30=380)，b=(10+20+5+0=35)
    // 期望 totalTokens = 1000 + 380 + 35 = 1415
    const pool: any = {
      query: vi.fn((sql: string) => {
        if (sql.includes('FROM sessions s')) return Promise.resolve({ rows: [
          { session_id: 'parent-1', title: 'main', subagent_count: 2, total_tokens: 1000 },
          { session_id: 'parent-2', title: 'nochildren', subagent_count: 0, total_tokens: 500 },
        ] })
        if (sql.includes('FROM subagents')) return Promise.resolve({ rows: [
          { parent_session_id: 'parent-1', agent_id: 'a', kind: 'claude_subagent', agent_type: 'Explore', title: 'ta', status: 'completed', token_in: 100, token_out: 200, token_cache: 50, token_cache_create: 30 },
          { parent_session_id: 'parent-1', agent_id: 'b', kind: 'claude_subagent', agent_type: 'Explore', title: 'tb', status: 'completed', token_in: 10, token_out: 20, token_cache: 5, token_cache_create: 0 },
        ] })
        return Promise.resolve({ rows: [] })
      }),
    }
    const out = await listSessionsWithChildren(pool)
    expect(out[0].totalTokens).toBe(1415) // 父 1000 + 子 a 380 + 子 b 35
    expect(out[1].totalTokens).toBe(500)  // 无子，仅父
  })
})
