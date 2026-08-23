import { describe, expect, test, vi } from 'vitest'

import { initAttentionInboxSchema } from '../attention-inbox/schema.js'
import { initDB } from '../db.js'

describe('Attention Inbox schema bootstrap', () => {
  test('creates product tables and an independent events projection cursor', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await initAttentionInboxSchema({ query } as never)

    expect(query).toHaveBeenCalledOnce()
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS attention_items')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS attention_action_receipts')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS attention_projection_cursor')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS attention_recovery_items')
    expect(sql).toContain('registration_generation VARCHAR(64) NOT NULL')
    expect(sql).toContain('UNIQUE (user_id, daemon_id, registration_generation)')
    expect(sql).toContain("CHECK (state IN ('open', 'snoozed', 'resolved'))")
    expect(sql).toContain('idx_attention_recovery_user_state_order')
    expect(sql).toContain('idx_attention_recovery_snooze_due')
    expect(sql).toContain("risk_reasons JSONB NOT NULL DEFAULT '[]'::jsonb")
    expect(sql).toContain('ALTER TABLE attention_items ADD COLUMN IF NOT EXISTS risk_reasons')
    expect(sql).toContain("SELECT 'attention-inbox-v1', COALESCE(MAX(id), 0) FROM events")
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS event_inbox ')
  })

  test('is included in the main Relay database bootstrap', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await initDB({ query } as never)

    const statements = query.mock.calls.map((call) => String(call[0])).join('\n')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS attention_items')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS attention_recovery_items')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS attention_projection_cursor')
  })
})
