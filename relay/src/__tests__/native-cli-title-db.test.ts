import { describe, expect, test, vi } from 'vitest'
import { hasDefaultTitle, updateNativeCLITitle, updateTitleIfDefault } from '../db.js'

describe('native CLI title policy', () => {
  test('rejects invalid source, empty name and untimestamped Codex updates', async () => {
    const pool: any = { query: vi.fn() }
    expect(await updateNativeCLITitle(pool, 'sid', '', 'claude-code')).toBe(false)
    expect(await updateNativeCLITitle(pool, 'sid', 'name', 'manual')).toBe(false)
    expect(await updateNativeCLITitle(pool, 'sid', 'name', 'codex', 'invalid')).toBe(false)
    expect(await updateNativeCLITitle(pool, 'sid', 'name', 'codex')).toBe(false)
    expect(pool.query).not.toHaveBeenCalled()
  })

  test.each(['codex', 'claude-code', 'claude-code-manual'])('guards manual names and agent ownership for %s', async (source) => {
    const pool: any = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) }
    expect(await updateNativeCLITitle(pool, 'sid', ' name ', source, '2026-09-08T10:00:00Z')).toBe(true)
    const [sql, args] = pool.query.mock.calls[0]
    expect(sql).toContain("title_source IS DISTINCT FROM 'manual'")
    expect(sql).toContain("title_source IS DISTINCT FROM 'claude-code-manual' OR $3 = 'claude-code-manual'")
    expect(sql).toContain('agent_type = CASE')
    expect(sql).toContain('title_source_updated_at <= $4::timestamptz')
    expect(args).toEqual(['name', 'sid', source, source === 'codex' ? '2026-09-08T10:00:00Z' : null])
    pool.query.mockResolvedValue({ rowCount: 0 })
    expect(await updateNativeCLITitle(pool, 'sid', 'name', source, '2026-09-08T10:00:00Z')).toBe(false)
  })

  test('fallback accepts blank titles but protects every native/manual source', async () => {
    const pool: any = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) }
    await hasDefaultTitle(pool, 'sid')
    await updateTitleIfDefault(pool, 'sid', 'fallback')
    for (const [sql] of pool.query.mock.calls) {
      expect(sql).toContain("BTRIM(title) = ''")
      expect(sql).toContain("'manual', 'codex-desktop', 'codex', 'claude-code', 'claude-code-manual'")
    }
  })
})
