import { describe, expect, test, vi } from 'vitest'

import { initExtensionSchema } from '../extensions/schema.js'
import {
  SCOPE_ROLE_PERMISSIONS,
  isScopeRole,
  normalizeScopeRoles,
  permissionsForRoles,
} from '../extensions/scope-types.js'

function schemaSql(): string {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  void initExtensionSchema({ query } as never)
  return String(query.mock.calls[0]?.[0])
}

describe('extension v2 owner-scope schema DDL', () => {
  test('creates the five v2 scope tables idempotently', () => {
    const sql = schemaSql()
    for (const table of [
      'extension_organizations',
      'extension_teams',
      'extension_scope_memberships',
      'extension_scope_outbox',
      'extension_scope_idempotency',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  test('backfills personal installations with owner_scope_id = installation_id', () => {
    const sql = schemaSql().replace(/\s+/g, ' ')
    expect(sql).toContain(
      "UPDATE extension_installations SET owner_scope_id = installation_id WHERE owner_scope_id IS NULL AND owner_scope_kind = 'personal'",
    )
  })

  test('detaches the installation owner FK from account deletion (SET NULL, not CASCADE)', () => {
    const sql = schemaSql().replace(/\s+/g, ' ')
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS extension_installations_owner_user_id_fkey',
    )
    expect(sql).toContain('ALTER COLUMN owner_user_id DROP NOT NULL')
    // Shared rows forbid an owner; live personal rows require one, revoked
    // personal rows survive account deletion with a detached owner.
    expect(sql).toContain('extension_installations_owner_scope_identity_check')
    expect(sql).toContain("owner_scope_kind = 'personal'")
    expect(sql).toContain("owner_scope_kind IN ('team', 'organization')")
  })

  test('enforces one live installation per provider and owner scope', () => {
    const sql = schemaSql().replace(/\s+/g, ' ')
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_installations_live_scope_provider',
    )
    expect(sql).toContain(
      'ON extension_installations (provider_id, owner_scope_kind, owner_scope_id)',
    )
  })

  test('keeps the personal one-installation-per-user index intact', () => {
    const sql = schemaSql()
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_installations_live_owner_provider',
    )
  })

  test('enforces membership role/state allowlists and team hierarchy in SQL', () => {
    const sql = schemaSql().replace(/\s+/g, ' ')
    const memberships = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_scope_memberships'),
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_scope_outbox'),
    )
    expect(memberships).toContain("CHECK (scope_kind IN ('team', 'organization'))")
    expect(memberships).toContain(
      "CHECK (state IN ('invited', 'active', 'suspended', 'revoked'))",
    )
    expect(memberships).toContain("CHECK (roles <@ ARRAY['reader', 'contributor', 'reviewer', 'publisher', 'policy_administrator', 'scope_administrator']")
    expect(memberships).toContain('REFERENCES users(id) ON DELETE SET NULL')
    expect(memberships).toContain('UNIQUE (scope_kind, scope_id, user_id)')

    const teams = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_teams'),
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_scope_memberships'),
    )
    expect(teams).toContain('REFERENCES extension_organizations(organization_id)')
  })

  test('membership user_id is nullable so revoked identities survive account deletion', () => {
    const sql = schemaSql().replace(/\s+/g, ' ')
    const memberships = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_scope_memberships'),
      sql.indexOf('CREATE TABLE IF NOT EXISTS extension_scope_outbox'),
    )
    expect(memberships).toContain('user_id INT REFERENCES users(id) ON DELETE SET NULL')
    expect(memberships).not.toContain('user_id INT NOT NULL')
  })
})

describe('scope role and permission allowlists', () => {
  test('role bundles map to the frozen permission sets', () => {
    expect(SCOPE_ROLE_PERMISSIONS.reader).toEqual(['read'])
    expect(SCOPE_ROLE_PERMISSIONS.contributor).toEqual(['read', 'contribute'])
    expect(SCOPE_ROLE_PERMISSIONS.reviewer).toEqual(['read', 'review'])
    expect(SCOPE_ROLE_PERMISSIONS.publisher).toEqual(['read', 'review', 'publish'])
    expect(SCOPE_ROLE_PERMISSIONS.policy_administrator).toEqual(['read', 'policy_admin'])
    expect(SCOPE_ROLE_PERMISSIONS.scope_administrator).toEqual([
      'read',
      'contribute',
      'review',
      'publish',
      'policy_admin',
      'scope_admin',
    ])
  })

  test('unknown roles fail closed', () => {
    expect(isScopeRole('admin')).toBe(false)
    expect(isScopeRole('owner')).toBe(false)
    expect(isScopeRole('reader')).toBe(true)
    expect(normalizeScopeRoles(['reader', 'reader'])).toEqual(['reader'])
    expect(normalizeScopeRoles(['reader', 'superuser'])).toBeNull()
    expect(normalizeScopeRoles([])).toBeNull()
    expect(normalizeScopeRoles('reader' as never)).toBeNull()
  })

  test('permissionsForRoles unions bundle permissions deterministically', () => {
    expect(permissionsForRoles(['reader', 'reviewer'])).toEqual(['read', 'review'])
    expect(permissionsForRoles(['publisher'])).toEqual(['read', 'review', 'publish'])
    expect(permissionsForRoles([] as never)).toEqual([])
  })
})
