import { describe, test, expect, vi } from 'vitest'
import { listSessionsWithChildren, getSessionTokenBreakdown } from '../db.js'

describe('db subagent token API (P1a)', () => {
  test('listSessionsWithChildren: returns parent token + children tokenCacheCreate', async () => {
    const pool: any = {
      query: vi.fn(async (sql: string) => {
        if (/FROM sessions s/i.test(sql)) {
          return { rows: [{ session_id: 'p1', daemon_id: 'd1', agent_type: 'claude-code', cwd: '/', title: 't', source: 'daemon', status: 'running', subagent_count: 1, pinned: false, model: 'm', total_tokens: 1000, tok_input: 400, tok_output: 300, tok_cache_read: 200, tok_cache_create: 100, daemon_status: 'online', hostname: 'h', daemon_alias: null }] }
        }
        if (/FROM subagents/i.test(sql)) {
          return { rows: [{ parent_session_id: 'p1', agent_id: 'a1', kind: 'claude_subagent', agent_type: 'Explore', title: '探索', status: 'completed', token_in: 100, token_out: 200, token_cache: 50, token_cache_create: 30 }] }
        }
        return { rows: [] }
      }),
    }
    const list = await listSessionsWithChildren(pool)
    const parent = list[0]
    expect(parent).toMatchObject({ totalTokens: 1000, tokInput: 400, tokOutput: 300, tokCacheRead: 200, tokCacheCreate: 100 })
    // Verify raw snake_case columns are NOT leaked
    expect(parent.total_tokens).toBeUndefined()
    expect(parent.tok_input).toBeUndefined()
    expect(parent.tok_output).toBeUndefined()
    expect(parent.tok_cache_read).toBeUndefined()
    expect(parent.tok_cache_create).toBeUndefined()
    expect(parent.children[0]).toMatchObject({ agentId: 'a1', tokenIn: 100, tokenOut: 200, tokenCache: 50, tokenCacheCreate: 30 })
  })

  test('getSessionTokenBreakdown: returns parent + children structure', async () => {
    const pool: any = {
      query: vi.fn(async (sql: string) => {
        if (/FROM sessions WHERE/i.test(sql)) {
          return { rowCount: 1, rows: [{ total_tokens: 1000, tok_input: 400, tok_output: 300, tok_cache_read: 200, tok_cache_create: 100, user_id: 42 }] }
        }
        if (/FROM subagents WHERE/i.test(sql)) {
          return { rowCount: 1, rows: [{ agent_id: 'a1', agent_type: 'Explore', title: '探索', token_in: 100, token_out: 200, token_cache: 50, token_cache_create: 30 }] }
        }
        return { rows: [] }
      }),
    }
    const bd = await getSessionTokenBreakdown(pool, 42, 'p1')
    expect(bd).not.toBeNull()
    expect(bd!.parent).toMatchObject({ totalTokens: 1000, tokCacheCreate: 100 })
    expect(bd!.children[0]).toMatchObject({ agentId: 'a1', agentType: 'Explore', tokenCacheCreate: 30 })
  })

  test('getSessionTokenBreakdown: unknown session returns null', async () => {
    const pool: any = { query: vi.fn(async () => ({ rows: [] })) }
    expect(await getSessionTokenBreakdown(pool, 42, 'unknown')).toBeNull()
  })
})
