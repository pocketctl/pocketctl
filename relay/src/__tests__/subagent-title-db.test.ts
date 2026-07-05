import { describe, test, expect, vi } from 'vitest'
import { hasDefaultSubagentTitle, updateSubagentTitleIfDefault } from '../db.js'

describe('db subagent title', () => {
  test('hasDefaultSubagentTitle: true when title IS NULL', async () => {
    const pool: any = { query: vi.fn(() => Promise.resolve({ rows: [{ parent_session_id: 'p1', agent_id: 'a1' }], rowCount: 1 })) }
    expect(await hasDefaultSubagentTitle(pool, 'p1', 'a1')).toBe(true)
    expect(pool.query.mock.calls[0][1]).toEqual(['p1', 'a1'])
    expect(pool.query.mock.calls[0][0]).toMatch(/title IS NULL/i)
  })

  test('hasDefaultSubagentTitle: false when no row (unknown subagent)', async () => {
    const pool: any = { query: vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 })) }
    expect(await hasDefaultSubagentTitle(pool, 'p1', 'a1')).toBe(false)
  })

  test('updateSubagentTitleIfDefault: updates only when title IS NULL, returns true', async () => {
    const pool: any = { query: vi.fn(() => Promise.resolve({ rowCount: 1 })) }
    const ok = await updateSubagentTitleIfDefault(pool, 'p1', 'a1', '审查 · compose.prod.yml')
    expect(ok).toBe(true)
    expect(pool.query.mock.calls[0][1]).toEqual(['审查 · compose.prod.yml', 'p1', 'a1'])
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE subagents SET title/i)
    expect(pool.query.mock.calls[0][0]).toMatch(/title IS NULL/i)
  })

  test('updateSubagentTitleIfDefault: returns false when already set (0 rows)', async () => {
    const pool: any = { query: vi.fn(() => Promise.resolve({ rowCount: 0 })) }
    expect(await updateSubagentTitleIfDefault(pool, 'p1', 'a1', 'x')).toBe(false)
  })
})
