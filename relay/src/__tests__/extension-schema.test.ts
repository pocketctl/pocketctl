import { describe, expect, test, vi } from 'vitest'

import { initExtensionSchema } from '../extensions/schema.js'
import { initDB } from '../db.js'

describe('extension platform schema bootstrap', () => {
  test('creates all nine extension tables in one idempotent statement batch', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await initExtensionSchema({ query } as never)

    expect(query).toHaveBeenCalledOnce()
    const sql = String(query.mock.calls[0]?.[0])
    for (const table of [
      'extension_providers',
      'extension_installations',
      'extension_source_outbox',
      'extension_feed',
      'extension_checkpoints',
      'extension_provider_credentials',
      'extension_provider_status',
      'extension_provider_usage_facts',
      'extension_purge_requests',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  test('enforces the frozen unique constraints', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await initExtensionSchema({ query } as never)
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_installations_live_owner_provider')
    expect(sql).toContain("WHERE status IN ('pending', 'active', 'paused', 'revoking')")
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS extension_installations_owner_user_id_provider_id_key')
    expect(sql).toContain('UNIQUE (source_kind, source_id)')
    expect(sql).toContain('UNIQUE (source_kind, source_id, topic, envelope_version)')
    expect(sql).toContain('UNIQUE (provider_id, client_id)')
    expect(sql).toContain('PRIMARY KEY (installation_id, usage_id)')
  })

  test('keeps source outbox and feed free of user-cascading foreign keys', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await initExtensionSchema({ query } as never)
    const sql = String(query.mock.calls[0]?.[0]).replace(/\s+/g, ' ')

    const outbox = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_source_outbox'),
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_feed'),
    )
    expect(outbox).toContain('owner_user_id INT NOT NULL')
    expect(outbox).not.toContain('REFERENCES users')

    const feed = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_feed'),
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_checkpoints'),
    )
    expect(feed).toContain('owner_user_id INT NOT NULL')
    expect(feed).not.toContain('REFERENCES users')
  })

  test('uses explicit foreign keys for control tables and cascade-owned children', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await initExtensionSchema({ query } as never)
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain(
      'REFERENCES extension_providers(provider_id)',
    )
    // ADR-0005: installation owners detach on account deletion instead of
    // cascading, so shared-scope evidence survives the user row.
    expect(sql).toContain('REFERENCES users(id) ON DELETE SET NULL')
    expect(sql).toContain(
      'REFERENCES extension_installations(installation_id) ON DELETE CASCADE',
    )
    // Purge evidence survives account deletion: no FK on provider/installation.
    const normalized = sql.replace(/\s+/g, ' ')
    const purgeStart = normalized.indexOf('CREATE TABLE IF NOT EXISTS extension_purge_requests')
    const purge = normalized.slice(purgeStart, normalized.indexOf(');', purgeStart) + 2)
    expect(purge).toContain('installation_id UUID NOT NULL')
    expect(purge).not.toContain('REFERENCES')
  })

  test('creates the bounded check constraints', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await initExtensionSchema({ query } as never)
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain("CHECK (trust_level IN ('first_party'))")
    expect(sql).toContain("CHECK (status IN ('enabled', 'disabled'))")
    expect(sql).toContain("CHECK (manifest_version > 0)")
    expect(sql).toContain(
      "CHECK (status IN ('pending', 'active', 'paused', 'revoking', 'revoked'))",
    )
    expect(sql).toContain("CHECK (start_policy IN ('from_now', 'retained_history'))")
    expect(sql).toContain("CHECK (state IN ('ready', 'syncing', 'degraded', 'error'))")
    expect(sql).toContain("CHECK (status IN ('active', 'revoked'))")
    expect(sql).toContain(
      "CHECK (reason IN ('uninstall', 'account_deleted', 'admin_revoke'))",
    )
    expect(sql).toContain("CHECK (status IN ('pending', 'acked', 'expired'))")
  })

  test('creates the shared-feed query indexes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await initExtensionSchema({ query } as never)
    const sql = String(query.mock.calls[0]?.[0])

    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_extension_feed_owner_id_feed_id')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_extension_feed_owner_topic_feed_id')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_extension_feed_session_id_feed_id')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_extension_feed_created_at_feed_id')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_extension_source_outbox_session_id')
  })

  test('is included in the main Relay database bootstrap for every flag mode', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await initDB({ query } as never)

    const statements = query.mock.calls.map((call) => String(call[0])).join('\n')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS extension_source_outbox')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS extension_feed')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS extension_installations')
  })
})
