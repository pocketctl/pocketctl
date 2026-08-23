import { describe, test, expect, vi } from 'vitest'
import { addSubagentUsage, listSubagentsByParent } from '../db.js'

describe('db subagent token (P1a)', () => {
  test('addSubagentUsage: 4 列累加含 cache_create', async () => {
    const pool: any = { query: vi.fn(() => Promise.resolve({ rowCount: 1 })) }
    await addSubagentUsage(pool, 'p1', 'a1', 100, 200, 50, 30)
    const [sql, params] = pool.query.mock.calls[0]
    expect(params).toEqual(['p1', 'a1', 100, 200, 50, 30])
    expect(sql).toMatch(/INSERT INTO subagents/i)
    expect(sql).toMatch(/token_cache_create/i)
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i)
  })

  test('listSubagentsByParent: 返回 tokenCacheCreate', async () => {
    const pool: any = {
      query: vi.fn(() => Promise.resolve({
        rows: [{
          agent_id: 'a1', kind: 'claude_subagent', agent_type: 'Explore', title: 't',
          status: 'completed', token_in: 100, token_out: 200, token_cache: 50, token_cache_create: 30,
        }],
      })),
    }
    const list = await listSubagentsByParent(pool, 'p1')
    expect(list[0]).toMatchObject({ agentId: 'a1', tokenIn: 100, tokenOut: 200, tokenCache: 50, tokenCacheCreate: 30 })
    const sql = pool.query.mock.calls[0][0]
    expect(sql).toMatch(/token_cache_create/i)
  })
})
