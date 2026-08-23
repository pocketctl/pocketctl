import { describe, test, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { upsertSubagent, addSubagentUsage, listSubagentsByParent, listSessionsWithChildren, reconcileSubagent, recordSubagentUsage } from '../db.js'

describe('db subagent layer', () => {
  test('recordSubagentUsage preserves the exact legacy Claude fingerprint', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params })
        if (/INSERT INTO subagent_usage_seen/i.test(sql)) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn().mockResolvedValue(client) }
    const applied = await recordSubagentUsage(pool, {
      daemonId: 'd1', seq: 9, eventId: '', parentSessionId: 'root', agentId: 'claude-child',
      inputTokens: 100, outputTokens: 20, cacheRead: 50, cacheCreate: 5,
    })
    const oldHash = createHash('md5').update('root:claude-child:100:20:50:5').digest('hex').slice(0, 16)
    expect(calls.find((c) => /subagent_usage_seen/i.test(c.sql))?.params?.[1]).toBe(oldHash)
    expect(calls.some((c) => /token_in = subagents\.token_in \+ \$3/i.test(c.sql))).toBe(false)
    expect(applied).toBe(false)
  })

  test('recordSubagentUsage commits seen identity and aggregate atomically', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params })
        if (/INSERT INTO subagent_usage_seen/i.test(sql)) return { rows: [{ usage_hash: 'hash' }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn().mockResolvedValue(client) }

    const applied = await recordSubagentUsage(pool, {
      daemonId: 'd1', seq: 7, eventId: 'jsonl:file:3:0:usage',
      parentSessionId: 'root', agentId: 'child',
      inputTokens: 100, outputTokens: 20, cacheRead: 50, cacheCreate: 5,
    })

    expect(applied).toBe(true)
    expect(calls[0].sql).toBe('BEGIN')
    expect(calls.at(-1)?.sql).toBe('COMMIT')
    expect(calls.find((c) => /subagent_usage_seen/i.test(c.sql))?.params).toEqual([
      'd1', expect.any(String), 7, 'child',
    ])
    expect(calls.some((c) => /token_in = subagents\.token_in \+ \$3/i.test(c.sql))).toBe(true)
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('recordSubagentUsage rolls back without ackable success when aggregate fails', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ usage_hash: 'hash' }], rowCount: 1 })
        .mockRejectedValueOnce(new Error('aggregate failed'))
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn().mockResolvedValue(client) }
    await expect(recordSubagentUsage(pool, {
      daemonId: 'd1', seq: 7, eventId: 'event-1', parentSessionId: 'root', agentId: 'child',
      inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheCreate: 4,
    })).rejects.toThrow('aggregate failed')
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('reconcileSubagent atomically hides legacy child and recounts', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn().mockResolvedValue(client) }

    await reconcileSubagent(pool, {
      parentSessionId: 'root',
      agentId: 'child',
      rootSessionId: 'root',
      kind: 'codex_subagent',
      agentType: 'codex',
      title: 'Newton',
    })

    expect(calls[0].sql).toBe('BEGIN')
    expect(calls.at(-1)?.sql).toBe('COMMIT')
    expect(calls.some((c) => /INSERT INTO subagents/i.test(c.sql))).toBe(true)
    expect(calls.some((c) => /is_subagent\s*=\s*true/i.test(c.sql))).toBe(true)
    expect(calls.some((c) => /DELETE FROM events/i.test(c.sql) && /event_id/i.test(c.sql))).toBe(true)
    expect(calls.some((c) => /tok_input|tok_output|tok_cache_read|tok_cache_create/i.test(c.sql))).toBe(false)
    expect(calls.some((c) => /COUNT\(\*\)/i.test(c.sql))).toBe(true)
    expect(calls.some((c) => /subagent_count\s*=\s*subagent_count\s*\+/i.test(c.sql))).toBe(false)
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('reconcileSubagent rolls back and releases on failure', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('db failed'))
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    }
    const pool: any = { connect: vi.fn().mockResolvedValue(client) }

    await expect(reconcileSubagent(pool, {
      parentSessionId: 'root', agentId: 'child', rootSessionId: 'root',
      kind: 'codex_subagent', agentType: 'codex', title: 'Newton',
    })).rejects.toThrow('db failed')

    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

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
    const calls: any[] = []
    const pool: any = {
      query: vi.fn((sql: string) => {
        calls.push({ sql })
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
    expect(calls[0].sql).toMatch(/COALESCE\(s\.is_subagent, false\) = false/i)
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
          { session_id: 'parent-1', title: 'main', subagent_count: 0 },
        ] })
        if (sql.includes('FROM subagents')) return Promise.resolve({ rows: [
          { parent_session_id: 'parent-1', agent_id: 'agent-a', kind: 'claude_subagent', agent_type: 'Explore', title: 't', status: 'completed', token_in: 1, token_out: 2, token_cache: 3 },
        ] })
        return Promise.resolve({ rows: [] })
      }),
    }
    const out = await listSessionsWithChildren(pool)
    const child = out[0].children[0]
    expect(out[0].subagent_count).toBe(1)
    expect(child).toEqual({
      agentId: 'agent-a',
      kind: 'claude_subagent',
      agentType: 'Explore',
      title: 't',
      status: 'completed',
      tokenIn: 1,
      tokenOut: 2,
      tokenCache: 3,
      tokenCacheCreate: 0,
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
