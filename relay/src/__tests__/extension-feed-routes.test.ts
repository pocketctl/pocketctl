import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { signProviderExtensionToken, PROVIDER_TOKEN_AUDIENCE } from '../extensions/provider-auth.js'
import type { FeedRouteDeps } from '../extensions/feed-routes.js'
import { createHash } from 'node:crypto'
import { encodeFeedCursor, filterHashForInstallation } from '../extensions/cursor.js'

const { registerFeedRoutes } = await import('../extensions/feed-routes.js')

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const CURSOR_SECRET = 'cursor-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

interface Script {
  installation?: Record<string, unknown> | null
  checkpoint?: Record<string, unknown>
  feedRows?: Array<Record<string, unknown>>
  ackResult?: string | null
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
      if (/FROM extension_feed/.test(sql)) {
        return { rows: (script.feedRows ?? []).map(row => ({ ...row })) }
      }
      if (/SET ack_feed_id = GREATEST/.test(sql)) {
        return { rows: script.ackResult === null ? [] : [{ ack_feed_id: script.ackResult ?? '150' }] }
      }
      if (/UPDATE extension_checkpoints|UPDATE extension_installations/.test(sql)) {
        return { rows: [] }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, client, queries }
}

function defaultInstallation(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: INSTALLATION,
    provider_id: 'pocketctl-memory',
    owner_user_id: 42,
    status: 'active',
    granted_scopes: ['session:events:read'],
    subscriptions: ['session.event.v1'],
    event_filter: {},
    start_feed_id: 0,
    config_version: 1,
    ...overrides,
  }
}

function defaultCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    ack_feed_id: 0,
    lease_epoch: 0,
    lease_token_hash: null,
    lease_expires_at: null,
    ...overrides,
  }
}

function providerToken() {
  return signProviderExtensionToken({
    providerId: 'pocketctl-memory',
    credentialId: 'cred-1',
    secret: PROVIDER_SECRET,
    issuer: ISSUER,
  })
}

function makeApp(script: Script, deps: Partial<FeedRouteDeps> = {}) {
  const app = Fastify()
  const { pool } = scriptPool(script)
  registerFeedRoutes(app, {
    pool: pool as never,
    mode: 'enabled',
    providerJwtSecret: PROVIDER_SECRET,
    issuer: ISSUER,
    cursorSecret: CURSOR_SECRET,
    leaseTtlSeconds: 60,
    ...deps,
  } as FeedRouteDeps)
  return app
}

describe('extension feed routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  test('pulls a bounded batch with a fresh lease and a signed cursor', async () => {
    const app = track(makeApp({
      feedRows: [
        { feed_id: 101, topic: 'session.event.v1', payload: { topic: 'session.event.v1', data: { text: 'a' } } },
        { feed_id: 102, topic: 'session.event.v1', payload: { topic: 'session.event.v1', data: { text: 'b' } } },
      ],
    }))
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}&limit=10`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.items.map((item: { feed_id: string }) => item.feed_id)).toEqual(['101', '102'])
    expect(body.items[0].data.text).toBe('a')
    expect(typeof body.lease_token).toBe('string')
    expect(body.next_cursor).toBeTruthy()
  })

  test('pending installations activate on the first authenticated pull', async () => {
    const script: Script = { installation: defaultInstallation({ status: 'pending' }) }
    const app = track(makeApp(script))
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
  })

  test('cross-provider installation ids resolve to 404', async () => {
    const app = track(makeApp({ installation: null }))
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })

  test('paused and revoked installations fail closed', async () => {
    const paused = track(makeApp({ installation: defaultInstallation({ status: 'paused' }) }))
    const pausedResponse = await paused.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(pausedResponse.statusCode).toBe(409)
    expect(pausedResponse.json().error.code).toBe('installation_paused')

    const revoked = track(makeApp({ installation: defaultInstallation({ status: 'revoked' }) }))
    const revokedResponse = await revoked.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(revokedResponse.statusCode).toBe(403)
    expect(revokedResponse.json().error.code).toBe('installation_revoked')
  })

  test('a topic subscription without its required scope fails closed before querying feed rows', async () => {
    const script: Script = {
      installation: defaultInstallation({
        granted_scopes: ['session:snapshot:read'],
        subscriptions: ['session.event.v1'],
      }),
      feedRows: [{ feed_id: 101, payload: { data: { text: 'must-not-leak' } } }],
    }
    const app = track(makeApp(script))
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
  })

  test('requires a provider token; user access tokens are rejected', async () => {
    const app = track(makeApp({}))
    const anonymous = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
    })
    expect(anonymous.statusCode).toBe(401)

    const accessToken = jwt.sign({ userId: 1, type: 'access' }, 'user-secret', { expiresIn: '5m' })
    const asUser = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(asUser.statusCode).toBe(401)
  })

  test('off and shadow modes keep the feed closed', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const app = track(makeApp({}, { mode }))
      const response = await app.inject({
        method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
        headers: { authorization: `Bearer ${providerToken()}` },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('feature_disabled')
    }
  })

  test('a cursor bound to an older config version fails with 410', async () => {
    const app = track(makeApp({
      installation: defaultInstallation({ config_version: 7 }),
    }))
    const staleCursor = encodeCursor({ config_version: '6' })
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}&cursor=${encodeURIComponent(staleCursor)}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('cursor_expired')
    // Ordinary cursor invalidation never claims a snapshot is mandatory.
    expect(response.json().error.snapshot_required).toBeUndefined()
  })

  test('hard retention pulls fail with cursor_expired plus snapshot_required true', async () => {
    const app = track(makeApp({
      checkpoint: defaultCheckpoint({ snapshot_required_at: new Date() }),
    }))
    const response = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('cursor_expired')
    expect(response.json().error.snapshot_required).toBe(true)
  })

  test('cuts the batch at the response byte budget', async () => {
    const app = track(makeApp({
      feedRows: [
        { feed_id: 201, payload: { data: { text: 'x'.repeat(250) } } },
        { feed_id: 202, payload: { data: { text: 'y'.repeat(250) } } },
      ],
    }, { maxResponseBytes: 300 }))
    const response = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().items.length).toBe(1)
  })

  test('a single oversized item is a typed error, not an unbounded reply', async () => {
    const app = track(makeApp({
      feedRows: [{ feed_id: 301, payload: { data: { text: 'z'.repeat(400) } } }],
    }, { maxResponseBytes: 100 }))
    const response = await app.inject({
      method: 'GET', url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
  })

  test('ack advances the checkpoint under the matching lease binding', async () => {
    const app = track(makeApp({ ackResult: '150' }))
    const leaseToken = 'lease-token-abc'
    const cursorToken = encodeCursor({ feed_id: '150' })
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/feed/ack',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION, cursor: cursorToken, lease_token: leaseToken },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().ack_feed_id).toBe(150)
  })

  test('a stale lease cannot ack', async () => {
    const app = track(makeApp({ ackResult: null }))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/feed/ack',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: {
        installation_id: INSTALLATION,
        cursor: encodeCursor({ feed_id: '150' }),
        lease_token: 'old-token',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('stale_lease')
  })

  test('malformed ack bodies are rejected', async () => {
    const app = track(makeApp({}))
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/feed/ack',
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { installation_id: INSTALLATION },
    })
    expect(response.statusCode).toBe(400)
  })
})

function encodeCursor(overrides: Record<string, string> = {}): string {
  return encodeFeedCursor({
    v: 1,
    installation_id: INSTALLATION,
    feed_id: '100',
    lease_epoch: '1',
    config_version: '1',
    filter_hash: filterHashForInstallation({}),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }, CURSOR_SECRET)
}


describe('extension feed 410 contract details', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  test('a retention-marked checkpoint returns 410 with snapshot_required', async () => {
    const app = Fastify()
    apps.push(app)
    const { pool } = scriptPool({
      installation: defaultInstallation({}),
      checkpoint: defaultCheckpoint({ snapshot_required_at: new Date() }),
    })
    registerFeedRoutes(app, {
      pool: pool as never,
      mode: 'enabled',
      providerJwtSecret: PROVIDER_SECRET,
      issuer: ISSUER,
      cursorSecret: CURSOR_SECRET,
      leaseTtlSeconds: 60,
    } as never)
    const response = await app.inject({
      method: 'GET',
      url: `/api/extensions/v1/feed?installation_id=${INSTALLATION}`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('cursor_expired')
    expect(response.json().error.snapshot_required).toBe(true)
  })
})
