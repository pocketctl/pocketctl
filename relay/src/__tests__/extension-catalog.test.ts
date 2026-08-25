import { describe, expect, test, vi } from 'vitest'
import {
  EXTENSION_PROVIDER_CATALOG,
  getExtensionProviderManifest,
  initializeExtensionProviderCatalog,
  upsertProviderDefinitions,
  validateInstallationGrant,
} from '../extensions/catalog.js'

describe('extension provider catalog', () => {
  test('contains exactly the first-party pocketctl-memory provider', () => {
    expect(EXTENSION_PROVIDER_CATALOG.map(entry => entry.provider_id))
      .toEqual(['pocketctl-memory'])
    const manifest = getExtensionProviderManifest('pocketctl-memory')
    expect(manifest).toBeDefined()
    expect(manifest!.display_name).toBe('PocketCtl Memory')
    expect(manifest!.protocol_versions).toEqual(['extension-feed.v1'])
    expect([...manifest!.subscriptions].sort()).toEqual([
      'session.access.revoked.v1',
      'session.deleted.v1',
      'session.event.v1',
      'session.lifecycle.v1',
      'turn.lifecycle.v1',
    ])
    expect([...manifest!.requested_scopes].sort()).toEqual([
      'session:deletion:read',
      'session:events:read',
      'session:snapshot:read',
    ])
    expect(manifest!.services.map(service => service.service_id).sort()).toEqual([
      'knowledge.query', 'memory.manage', 'memory.mcp', 'memory.recall', 'memory.search',
    ])
    expect(manifest!.manifest_version).toBe(2)
    const manage = manifest!.services.find(service => service.service_id === 'memory.manage')
    expect(manage).toMatchObject({ mode: 'write', metered: false })
  })

  test('unknown provider ids resolve to nothing', () => {
    expect(getExtensionProviderManifest('third-party-memory')).toBeUndefined()
    expect(getExtensionProviderManifest('')).toBeUndefined()
  })

  test('the catalog is deeply frozen', () => {
    const manifest = EXTENSION_PROVIDER_CATALOG[0] as unknown as Record<string, unknown>
    expect(() => { manifest.provider_id = 'mutated' }).toThrow()
    expect(() => {
      (manifest.services as Array<Record<string, unknown>>)[0].service_id = 'evil'
    }).toThrow()
  })

  test('upsert preserves the operational enabled/disabled status', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await upsertProviderDefinitions({ query } as never)
    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('INSERT INTO extension_providers')
    expect(sql).toContain('ON CONFLICT (provider_id) DO UPDATE')
    expect(sql).toContain('manifest_version = EXCLUDED.manifest_version')
    expect(sql).not.toContain('status = EXCLUDED.status')
  })

  test('upsert writes the bumped manifest version and never touches installations', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    await upsertProviderDefinitions({ query } as never)
    // Exactly one catalog statement per provider, targeting only
    // extension_providers: expanding the manifest must not silently widen an
    // existing installation's enabled_services.
    expect(query).toHaveBeenCalledTimes(EXTENSION_PROVIDER_CATALOG.length)
    for (const call of query.mock.calls) {
      const sql = String(call[0])
      expect(sql).toContain('extension_providers')
      expect(sql).not.toContain('extension_installations')
    }
    expect(query.mock.calls[0][1]).toContain(2)
  })

  test('memory.manage is a grantable service but never auto-granted', () => {
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search', 'memory.manage'],
    }).valid).toBe(true)
    // Only what a user explicitly submits validates; there is no code path
    // that rewrites existing installations when the catalog grows.
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
    }).enabled_services).toEqual(['memory.search'])
  })

  test('enabled startup awaits catalog seeding and propagates failures', async () => {
    let released = false
    const query = vi.fn(() => new Promise<{ rows: []; rowCount: number }>((resolve) => {
      setTimeout(() => { released = true; resolve({ rows: [], rowCount: 0 }) }, 5)
    }))
    await initializeExtensionProviderCatalog({ query } as never, 'enabled')
    expect(released).toBe(true)

    await expect(initializeExtensionProviderCatalog({
      query: vi.fn(async () => { throw new Error('catalog unavailable') }),
    } as never, 'shadow')).rejects.toThrow('catalog unavailable')
  })
})

describe('installation grant validation', () => {
  test('accepts subsets of the requested scopes, topics and services', () => {
    const result = validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1', 'turn.lifecycle.v1'],
      enabled_services: ['memory.search'],
    })
    expect(result.valid).toBe(true)
  })

  test('rejects topic subscriptions whose required read scope was not granted', () => {
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:snapshot:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
    }).valid).toBe(false)
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.deleted.v1'],
      enabled_services: ['memory.search'],
    }).valid).toBe(false)
  })

  test('rejects anything outside the manifest allowlists', () => {
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:write'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
    }).valid).toBe(false)
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['memory.candidates.v1'],
      enabled_services: ['memory.search'],
    }).valid).toBe(false)
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.drop_tables'],
    }).valid).toBe(false)
    expect(validateInstallationGrant('unknown-provider', {
      granted_scopes: [], subscriptions: [], enabled_services: [],
    }).valid).toBe(false)
  })

  test('rejects duplicates and empty mandatory sets', () => {
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read', 'session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
    }).valid).toBe(false)
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: [],
      subscriptions: [],
      enabled_services: [],
    }).valid).toBe(false)
  })

  test('event_filter only accepts daemon_ids and agent_types arrays', () => {
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
      event_filter: { daemon_ids: ['d-1'], agent_types: ['codex'] },
    }).valid).toBe(true)
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
      event_filter: { repository_paths: ['~/projects/pocketctl'] },
    }).valid).toBe(false)
    expect(validateInstallationGrant('pocketctl-memory', {
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
      event_filter: { daemon_ids: 'd-1' },
    }).valid).toBe(false)
  })
})
