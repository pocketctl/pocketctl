import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import { PROVIDER_INSTALLATION_FIELDS } from '../extensions/types.js'
import type { ProviderInstallationRouteDeps } from '../extensions/provider-installation-routes.js'

const { registerProviderInstallationRoutes } = await import(
  '../extensions/provider-installation-routes.js'
)

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'cursor-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

interface Script {
  /** Rows returned by the provider inventory listing query. */
  inventoryRows?: Array<Record<string, unknown>>
  /** Row locked by the reconcile ACK (null = missing/foreign). */
  installation?: Record<string, unknown> | null
  checkpoint?: Record<string, unknown>
  /** rowCount returned by the snapshot_required_at clear statement. */
  clearResult?: number
}

function scriptPool(script: Script) {
  const queries: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (/^BEGIN$/i.test(sql.trim()) || /^COMMIT$/i.test(sql.trim())
        || /^ROLLBACK$/i.test(sql.trim())) return { rows: [] }
      if (/FROM extension_installations[\s\S]*FOR UPDATE/.test(sql)) {
        return { rows: script.installation === null ? [] : [script.installation ?? defaultInstallation()] }
      }
      if (/INSERT INTO extension_checkpoints/.test(sql)) return { rows: [] }
      if (/FROM extension_checkpoints[\s\S]*FOR UPDATE/.test(sql)) {
        return { rows: [script.checkpoint ?? defaultCheckpoint()] }
      }
      if (/snapshot_required_at = NULL/.test(sql)) {
        return { rows: [], rowCount: script.clearResult ?? 1 }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (/FROM extension_installations[\s\S]*extension_checkpoints/.test(sql)
        || /FROM extension_installations i/.test(sql)) {
        // Emulate the SQL LIMIT clause on the last bound parameter.
        const limit = params?.[params.length - 1]
        const rows = typeof limit === 'number'
          ? (script.inventoryRows ?? []).slice(0, limit)
          : (script.inventoryRows ?? [])
        return { rows: rows.map(row => ({ ...row })), rowCount: rows.length }
      }
      return { rows: [] }
    }),
  }
  return { pool, client, queries }
}

function defaultInstallation(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: INSTALLATION,
    provider_id: 'pocketctl-memory',
    owner_user_id: 42,
    status: 'active',
    granted_scopes: ['session:events:read'],
    subscriptions: ['session.event.v1'],
    enabled_services: ['memory.search'],
    event_filter: {},
    start_feed_id: 0,
    config_version: 1,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-02T00:00:00Z'),
    ...overrides,
  }
}

function defaultCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    ack_feed_id: 0,
    lease_epoch: 0,
    lease_token_hash: null,
    lease_expires_at: null,
    snapshot_required_at: new Date(),
    ...overrides,
  }
}

function inventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: INSTALLATION,
    status: 'active',
    config_version: 3,
    granted_scopes: ['session:events:read', 'session:snapshot:read'],
    subscriptions: ['session.event.v1', 'turn.lifecycle.v1'],
    enabled_services: ['memory.search'],
    event_filter: { agent_types: ['codex'] },
    snapshot_required: true,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-02T00:00:00Z'),
    // The SQL may join owner columns; they must never reach the response.
    owner_user_id: 42,
    ...overrides,
  }
}

function providerToken(providerId = 'pocketctl-memory') {
  return signProviderExtensionToken({
    providerId, credentialId: 'cred-1', secret: PROVIDER_SECRET, issuer: ISSUER,
  })
}

function makeApp(script: Script, deps: Partial<ProviderInstallationRouteDeps> = {}) {
  const app = Fastify()
  const { pool } = scriptPool(script)
  registerProviderInstallationRoutes(app, {
    pool: pool as never,
    mode: 'enabled',
    providerJwtSecret: PROVIDER_SECRET,
    issuer: ISSUER,
    cursorSecret: CURSOR_SECRET,
    ...deps,
  } as ProviderInstallationRouteDeps)
  return app
}

describe('extension provider installation routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  // --- GET /api/extensions/v1/provider/installations -----------------------

  test('requires a provider token', async () => {
    const app = track(makeApp({}))
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v1/provider/installations',
    })
    expect(response.statusCode).toBe(401)
  })

  test('off and shadow modes keep the inventory closed', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const app = track(makeApp({}, { mode }))
      const response = await app.inject({
        method: 'GET', url: '/api/extensions/v1/provider/installations',
        headers: { authorization: `Bearer ${providerToken()}` },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('feature_disabled')
    }
  })

  test('lists installations with exactly the frozen response fields and no owner identity', async () => {
    const app = track(makeApp({ inventoryRows: [inventoryRow()] }))
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v1/provider/installations',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.installations).toHaveLength(1)
    const item = body.installations[0]
    expect(Object.keys(item).sort()).toEqual([...PROVIDER_INSTALLATION_FIELDS].sort())
    expect(item.owner_user_id).toBeUndefined()
    expect(item.user_id).toBeUndefined()
    expect(item.installation_id).toBe(INSTALLATION)
    expect(item.status).toBe('active')
    expect(item.config_version).toBe('3')
    expect(item.granted_scopes).toEqual(['session:events:read', 'session:snapshot:read'])
    expect(item.subscriptions).toEqual(['session.event.v1', 'turn.lifecycle.v1'])
    expect(item.enabled_services).toEqual(['memory.search'])
    expect(item.event_filter).toEqual({ agent_types: ['codex'] })
    expect(item.snapshot_required).toBe(true)
    expect(body.has_more).toBe(false)
    expect(body.next_cursor).toBeNull()
  })

  test('surfaces every installation status including pending and revoking', async () => {
    const statuses = ['pending', 'active', 'paused', 'revoking', 'revoked'] as const
    const rows = statuses.map((status, index) => inventoryRow({
      installation_id: `${String(30000000 + index)}-0000-0000-0000-000000000000`,
      status,
    }))
    const app = track(makeApp({ inventoryRows: rows }))
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v1/provider/installations?limit=100',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const returned = response.json().installations as Array<{ status: string }>
    expect(returned.map(item => item.status).sort()).toEqual([...statuses].sort())
  })

  test('pages with a signed, provider-bound cursor and reports has_more', async () => {
    const first = inventoryRow({
      installation_id: INSTALLATION,
      created_at: new Date('2026-08-01T00:00:00Z'),
    })
    const app = track(makeApp({ inventoryRows: [first, first, first] }))
    const firstResponse = await app.inject({
      method: 'GET', url: '/api/extensions/v1/provider/installations?limit=2',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(firstResponse.statusCode).toBe(200)
    const firstBody = firstResponse.json()
    expect(firstBody.installations).toHaveLength(2)
    expect(firstBody.has_more).toBe(true)
    expect(typeof firstBody.next_cursor).toBe('string')

    const secondResponse = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/provider/installations?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(secondResponse.statusCode).toBe(200)

    // A tampered cursor fails closed.
    const tampered = firstBody.next_cursor.slice(0, -2) + 'zz'
    const tamperedResponse = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/provider/installations?cursor=${encodeURIComponent(tampered)}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(tamperedResponse.statusCode).toBe(410)
    expect(tamperedResponse.json().error.code).toBe('cursor_expired')
  })

  test('a cursor issued to another provider is rejected', async () => {
    const app = track(makeApp({ inventoryRows: [inventoryRow(), inventoryRow()] }))
    const issued = await app.inject({
      method: 'GET', url: '/api/extensions/v1/provider/installations?limit=1',
      headers: { authorization: `Bearer ${providerToken('pocketctl-memory')}` },
    })
    expect(issued.statusCode).toBe(200)
    expect(typeof issued.json().next_cursor).toBe('string')
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/provider/installations?limit=1&cursor=${encodeURIComponent(issued.json().next_cursor)}`,
      headers: { authorization: `Bearer ${providerToken('other-provider')}` },
    })
    // A cursor signed for another provider fails closed with 410.
    expect(foreign.statusCode).toBe(410)
    expect(foreign.json().error.code).toBe('cursor_expired')
  })

  test('clamps the page limit into 1..100', async () => {
    const { pool, queries } = scriptPool({ inventoryRows: [] })
    const app = Fastify()
    registerProviderInstallationRoutes(app, {
      pool: pool as never,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
    } as ProviderInstallationRouteDeps)
    apps.push(app)

    for (const [query, expected] of [
      ['limit=0', 1],
      ['limit=1000', 100],
      ['limit=abc', 50],
      ['', 50],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/extensions/v1/provider/installations${query ? `?${query}` : ''}`,
        headers: { authorization: `Bearer ${providerToken()}` },
      })
      expect(response.statusCode).toBe(200)
    }
    const limits = queries
      .filter(entry => /FROM extension_installations/.test(entry.sql))
      .map(entry => entry.params?.[entry.params.length - 1])
    expect(limits).toEqual([1, 100, 50, 50])
  })

  // --- POST /api/extensions/v1/provider/installations/:id/reconciled ------

  test('reconciled ack requires a provider token', async () => {
    const app = track(makeApp({}))
    const response = await app.inject({
      method: 'POST', url: `/api/extensions/v1/provider/installations/${INSTALLATION}/reconciled`,
    })
    expect(response.statusCode).toBe(401)
  })

  test('reconciled ack resolves missing and foreign installations to a uniform 404', async () => {
    const app = track(makeApp({ installation: null }))
    const missing = await app.inject({
      method: 'POST', url: `/api/extensions/v1/provider/installations/${INSTALLATION}/reconciled`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('not_found')

    const malformed = await app.inject({
      method: 'POST', url: '/api/extensions/v1/provider/installations/not-a-uuid/reconciled',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(malformed.statusCode).toBe(400)
  })

  test('reconciled ack clears snapshot_required_at for pending, active and paused installations', async () => {
    for (const status of ['pending', 'active', 'paused'] as const) {
      const script: Script = {
        installation: defaultInstallation({ status }),
        checkpoint: defaultCheckpoint({ snapshot_required_at: new Date() }),
      }
      const { pool, queries } = scriptPool(script)
      const app = Fastify()
      registerProviderInstallationRoutes(app, {
        pool: pool as never,
        mode: 'enabled',
        providerJwtSecret: PROVIDER_SECRET,
        issuer: ISSUER,
        cursorSecret: CURSOR_SECRET,
      } as ProviderInstallationRouteDeps)
      apps.push(app)

      const response = await app.inject({
        method: 'POST', url: `/api/extensions/v1/provider/installations/${INSTALLATION}/reconciled`,
        headers: { authorization: `Bearer ${providerToken()}` },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ installation_id: INSTALLATION, reconciled: true })
      expect(queries.some(entry => /snapshot_required_at = NULL/.test(entry.sql))).toBe(true)
    }
  })

  test('reconciled ack rejects revoking and revoked installations', async () => {
    for (const status of ['revoking', 'revoked'] as const) {
      const app = track(makeApp({
        installation: defaultInstallation({ status }),
        checkpoint: defaultCheckpoint({ snapshot_required_at: new Date() }),
      }))
      const response = await app.inject({
        method: 'POST', url: `/api/extensions/v1/provider/installations/${INSTALLATION}/reconciled`,
        headers: { authorization: `Bearer ${providerToken()}` },
      })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('installation_revoked')
    }
  })

  test('reconciled ack stays idempotent when the flag is already clear', async () => {
    const app = track(makeApp({
      installation: defaultInstallation(),
      checkpoint: defaultCheckpoint({ snapshot_required_at: null }),
      clearResult: 0,
    }))
    const first = await app.inject({
      method: 'POST', url: `/api/extensions/v1/provider/installations/${INSTALLATION}/reconciled`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({
      method: 'POST', url: `/api/extensions/v1/provider/installations/${INSTALLATION}/reconciled`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ installation_id: INSTALLATION, reconciled: true })
  })
})
