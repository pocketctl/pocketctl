import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { updateCodexDesktopTitle, updateSessionTitle, updateTitleIfDefault } from '../db.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && !!process.env.TEST_DATABASE_URL

// A connection-local temporary table shadows sessions. No application rows or
// schema are changed, even when validating against a local development server.
;(enabled ? describe : describe.skip)('native Desktop title synchronization', () => {
  let client: pg.Client
  let pool: pg.Pool
  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    pool = client as unknown as pg.Pool
    await client.query(`CREATE TEMP TABLE sessions (
      session_id text PRIMARY KEY, user_id integer, title text, title_source text,
      title_source_updated_at timestamptz, updated_at timestamptz,
      agent_type text DEFAULT 'codex-desktop', source text DEFAULT 'observer'
    )`)
    await client.query(`INSERT INTO sessions (session_id,user_id,title) VALUES
      ('native',1,'Terminal Session-native'), ('manual',1,'Terminal Session-manual'),
      ('old-custom',1,'My existing title'), ('ai',1,'Terminal Session-ai')`)
  })
  afterAll(async () => { await client?.end() })

  test('syncs and renames, ignores retries and stale updates, preserves user titles', async () => {
    const first = '2026-09-06T09:40:00Z'
    const second = '2026-09-06T09:50:00Z'
    expect(await updateCodexDesktopTitle(pool, 'native', '原生标题', first)).toBe(true)
    expect(await updateCodexDesktopTitle(pool, 'native', '原生标题', first)).toBe(false)
    expect(await updateCodexDesktopTitle(pool, 'native', '新标题', second)).toBe(true)
    expect(await updateCodexDesktopTitle(pool, 'native', '旧标题', first)).toBe(false)
    expect(await updateSessionTitle(pool, 1, 'native', '手动标题')).toBe(true)
    expect(await updateCodexDesktopTitle(pool, 'native', '覆盖', '2026-09-06T10:00:00Z')).toBe(false)
    expect(await updateSessionTitle(pool, 1, 'manual', 'Terminal Session-custom')).toBe(true)
    expect(await updateCodexDesktopTitle(pool, 'manual', '覆盖', first)).toBe(false)
    expect(await updateTitleIfDefault(pool, 'manual', 'AI override')).toBe(false)
    expect(await updateCodexDesktopTitle(pool, 'old-custom', '覆盖', first)).toBe(false)
    expect(await updateTitleIfDefault(pool, 'ai', 'AI fallback')).toBe(true)
    expect(await updateCodexDesktopTitle(pool, 'ai', 'Desktop arrives later', first)).toBe(true)
    expect(await updateCodexDesktopTitle(pool, 'ai', 'Terminal Session-native-name', second)).toBe(true)
    expect(await updateTitleIfDefault(pool, 'ai', 'AI override')).toBe(false)
    expect(await updateCodexDesktopTitle(pool, 'native', '', first)).toBe(false)
    expect(await updateCodexDesktopTitle(pool, 'native', 'invalid', 'not-a-date')).toBe(false)
    const row = await client.query(`SELECT title FROM sessions WHERE session_id='native'`)
    expect(row.rows[0].title).toBe('手动标题')
  })
})
