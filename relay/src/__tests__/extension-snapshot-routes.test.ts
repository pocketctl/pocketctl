import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import type { SnapshotRouteDeps } from '../extensions/snapshot-routes.js'
import { getSnapshotEventPage, listInventorySessions, snapshotSessionExists } from '../extensions/snapshot-repository.js'

const { registerSnapshotRoutes } = await import('../extensions/snapshot-routes.js')

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'cursor-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

vi.mock('../extensions/snapshot-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../extensions/snapshot-repository.js')>()
  return {
    ...original,
    listInventorySessions: vi.fn(),
    getSnapshotEventPage: vi.fn(),
    snapshotSessionExists: vi.fn(),
  }
})

function providerToken() {
  return signProviderExtensionToken({
    providerId: 'pocketctl-memory', credentialId: 'c', secret: PROVIDER_SECRET, issuer: ISSUER,
  })
}

function makeApp(deps: Partial<SnapshotRouteDeps> = {}) {
  const app = Fastify()
  registerSnapshotRoutes(app, {
    pool: {} as never,
    mode: 'enabled',
    providerJwtSecret: PROVIDER_SECRET,
    issuer: ISSUER,
    cursorSecret: CURSOR_SECRET,
    ...deps,
  } as SnapshotRouteDeps)
  return app
}

const apps: Array<FastifyInstance> = []

describe('extension snapshot routes', () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  test('repository queries join installation ownership in one SQL statement', async () => {
    const actual = await vi.importActual<typeof import('../extensions/snapshot-repository.js')>(
      '../extensions/snapshot-repository.js',
    )
    const queries: string[] = []
    const pool = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] } }) }
    await actual.listInventorySessions(pool as never, {
      installationId: INSTALLATION, providerId: 'pocketctl-memory', ownerUserId: 1, eventFilter: {},
    }, { afterSessionRowId: 0, limit: 10 })
    await actual.getSnapshotEventPage(pool as never, {
      installationId: INSTALLATION, providerId: 'pocketctl-memory', ownerUserId: 1, eventFilter: {},
    }, 'ses-1', { afterEventId: 0, limit: 10 })
    const inventorySql = queries[0]
    expect(inventorySql).toContain('FROM extension_installations i')
    expect(inventorySql).toContain('JOIN sessions s ON s.user_id = i.owner_user_id')
    const snapshotSql = queries[1]
    expect(snapshotSql).toContain('JOIN sessions s ON s.user_id = i.owner_user_id AND s.session_id = $3')
    expect(snapshotSql).toContain('JOIN events e ON e.session_id = s.session_id')
    expect(snapshotSql).not.toContain('getSessionAllEvents')
  })

  test('repository binds daemon and agent filters as SQL array parameters', async () => {
    const actual = await vi.importActual<typeof import('../extensions/snapshot-repository.js')>(
      '../extensions/snapshot-repository.js',
    )
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: [] }
      }),
    }
    await actual.listInventorySessions(pool as never, {
      installationId: INSTALLATION,
      providerId: 'pocketctl-memory',
      ownerUserId: 1,
      eventFilter: { daemon_ids: ['d-1', 'd-2'], agent_types: ['codex'] },
    }, { afterSessionRowId: 0, limit: 10 })
    expect(calls[0].params.slice(4)).toEqual([['d-1', 'd-2'], ['codex']])
    expect(calls[0].sql).toContain('s.daemon_id = ANY($5::varchar[])')
    expect(calls[0].sql).toContain('s.agent_type = ANY($6::varchar[])')
  })

  test('repository inventory and event reads exclude immutable app review demo sessions', async () => {
    const actual = await vi.importActual<typeof import('../extensions/snapshot-repository.js')>(
      '../extensions/snapshot-repository.js',
    )
    const queries: string[] = []
    const pool = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] } }) }
    const scope = {
      installationId: INSTALLATION, providerId: 'pocketctl-memory', ownerUserId: 1, eventFilter: {},
    }
    await actual.listInventorySessions(pool as never, scope, { afterSessionRowId: 0, limit: 10 })
    await actual.getSnapshotEventPage(pool as never, scope, 'ses-1', { afterEventId: 0, limit: 10 })
    for (const sql of queries) {
      expect(sql).toContain("s.source IS DISTINCT FROM 'app_review_demo'")
      expect(sql).toContain("s.session_id NOT LIKE 'app-review-demo-%'")
    }
  })

  test('requires a provider token and rejects user access tokens', async () => {
    const app = track(makeApp())
    const anonymous = await app.inject({
      method: 'GET', url: `/api/extensions/v1/sessions?installation_id=${INSTALLATION}`,
    })
    expect(anonymous.statusCode).toBe(401)
  })

  test('a foreign installation id is a 404 without existence leakage', async () => {
    vi.mocked(listInventorySessions).mockResolvedValue([])
    const pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(async (sql: string) => {
          if (/FROM extension_installations[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] }
          return { rows: [] }
        }),
        release: vi.fn(),
      }),
    }
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'GET', url: `/api/extensions/v1/sessions?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })

  test('paused installations and missing scope fail closed', async () => {
    const pausedPool = installationPool({ status: 'paused', granted_scopes: ['session:snapshot:read'] })
    const paused = track(makeApp({ pool: pausedPool as never }))
    const pausedResponse = await paused.inject({
      method: 'GET', url: `/api/extensions/v1/sessions?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(pausedResponse.statusCode).toBe(409)
    expect(pausedResponse.json().error.code).toBe('installation_paused')

    const noScopePool = installationPool({ status: 'active', granted_scopes: ['session:events:read'] })
    const noScope = track(makeApp({ pool: noScopePool as never }))
    const noScopeResponse = await noScope.inject({
      method: 'GET', url: `/api/extensions/v1/sessions?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(noScopeResponse.statusCode).toBe(403)
    expect(noScopeResponse.json().error.code).toBe('forbidden')
  })

  test('inventories sessions with a signed, installation-bound cursor', async () => {
    vi.mocked(listInventorySessions).mockResolvedValue([
      {
        session_id: 'ses-1', agent_type: 'codex', status: 'running', daemon_id: 'd-1',
        created_at: new Date(), updated_at: new Date(), cursor: '3',
      },
    ])
    const app = track(makeApp({ pool: installationPool({}) as never }))
    const response = await app.inject({
      method: 'GET', url: `/api/extensions/v1/sessions?installation_id=${INSTALLATION}&limit=1`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.sessions[0].session_id).toBe('ses-1')
    // The cursor is opaque and tamper-evident: rewrite it and it fails.
    const tampered = body.next_cursor.slice(0, -2) + 'zz'
    const rejected = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions?installation_id=${INSTALLATION}&cursor=${encodeURIComponent(tampered)}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(rejected.statusCode).toBe(410)
  })

  test('a single oversized event is a typed error carrying its event id', async () => {
    vi.mocked(snapshotSessionExists).mockResolvedValue(true)
    vi.mocked(getSnapshotEventPage).mockResolvedValue([
      { event_id: 77, event_type: 'agent_text', payload: { text: 'z'.repeat(500) }, created_at: new Date() },
    ])
    const app = track(makeApp({ pool: installationPool({}) as never, maxPageBytes: 100 }))
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions/ses-1/snapshot?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
    expect(response.json().error.event_id).toBe(77)
  })

  test('snapshots page events with the byte budget', async () => {
    vi.mocked(snapshotSessionExists).mockResolvedValue(true)
    vi.mocked(getSnapshotEventPage).mockResolvedValue([
      { event_id: 1, event_type: 'agent_text', payload: { text: 'a'.repeat(100) }, created_at: new Date() },
      { event_id: 2, event_type: 'agent_text', payload: { text: 'b'.repeat(100) }, created_at: new Date() },
    ])
    const app = track(makeApp({
      pool: installationPool({}) as never,
      maxPageBytes: 150,
    }))
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/sessions/ses-1/snapshot?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().events.length).toBe(1)
  })

  test('direct snapshot existence probe applies the installation event filter', async () => {
    const actual = await vi.importActual<typeof import('../extensions/snapshot-repository.js')>(
      '../extensions/snapshot-repository.js',
    )
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
    await actual.snapshotSessionExists({ query } as never, {
      installationId: INSTALLATION,
      providerId: 'pocketctl-memory',
      ownerUserId: 42,
      eventFilter: { daemon_ids: ['d-allowed'] },
    }, 'ses-1')
    expect(String(query.mock.calls[0][0])).toContain('s.daemon_id = ANY($4::varchar[])')
    expect(query.mock.calls[0][1]).toEqual([
      INSTALLATION, 'pocketctl-memory', 'ses-1', ['d-allowed'],
    ])
  })
})

function installationPool(overrides: Record<string, unknown>) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/JOIN extension_installations i ON i.owner_user_id = s.user_id/.test(sql)
        && /SELECT 1 FROM sessions/.test(sql)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 }
      }
      return { rows: [] }
    }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql.trim())) return { rows: [] }
        if (/FROM extension_installations[\s\S]*FOR UPDATE/.test(sql)) {
          return {
            rows: [{
              installation_id: INSTALLATION,
              provider_id: 'pocketctl-memory',
              owner_user_id: 42,
              status: 'active',
              granted_scopes: ['session:snapshot:read'],
              subscriptions: ['session.event.v1'],
              event_filter: {},
              start_feed_id: 0,
              config_version: 1,
              ack_feed_id: 0,
              lease_epoch: 0,
              lease_token_hash: null,
              lease_expires_at: null,
              ...overrides,
            }],
          }
        }
        if (/INSERT INTO extension_checkpoints/.test(sql)) return { rows: [] }
        if (/FROM extension_checkpoints[\s\S]*FOR UPDATE/.test(sql)) {
          return { rows: [{ ack_feed_id: 0, lease_epoch: 0, lease_token_hash: null, lease_expires_at: null }] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }),
  }
}
