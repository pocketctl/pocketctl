import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signProviderExtensionToken } from '../extensions/provider-auth.js'
import type { PurgeRouteDeps } from '../extensions/purge-routes.js'

const { registerPurgeRoutes } = await import('../extensions/purge-routes.js')

const PROVIDER_SECRET = 'provider-secret-0123456789abcdef'
const ISSUER = 'https://relay.example.test'
const REQUEST = '22222222-2222-2222-2222-222222222222'

function providerToken(providerId = 'pocketctl-memory') {
  return signProviderExtensionToken({
    providerId, credentialId: 'c', secret: PROVIDER_SECRET, issuer: ISSUER,
  })
}

function transactionalPool(
  queryImpl: (sql: string) => Promise<{ rows: unknown[]; rowCount?: number }>,
) {
  const client = {
    query: vi.fn(queryImpl),
    release: vi.fn(),
  }
  return {
    pool: {
      query: vi.fn(async () => ({ rows: [{ count: '0' }], rowCount: 1 })),
      connect: vi.fn(async () => client),
    },
    client,
  }
}

function defaultAckPool() {
  return transactionalPool(async (sql: string) => {
    if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
      return {
        rows: [{
          provider_id: 'pocketctl-memory', status: 'pending',
          installation_id: '11111111-1111-1111-1111-111111111111', reason: 'uninstall',
        }],
        rowCount: 1,
      }
    }
    if (/UPDATE extension_purge_requests/.test(sql)) {
      return { rows: [{ status: 'acked' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
}

function makeApp(deps: Partial<PurgeRouteDeps> = {}) {
  const app = Fastify()
  const defaultPool = defaultAckPool().pool
  registerPurgeRoutes(app, {
    pool: defaultPool as never,
    mode: 'enabled',
    providerJwtSecret: PROVIDER_SECRET,
    issuer: ISSUER,
    ...deps,
  } as PurgeRouteDeps)
  return app
}

describe('extension purge routes', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function track(app: FastifyInstance) {
    apps.push(app)
    return app
  }

  test('lists only the token provider pending requests', async () => {
    const pool = {
      query: vi.fn(async (_sql: string) => ({
        rows: [{ request_id: REQUEST, installation_id: 'i', reason: 'uninstall', status: 'pending' }],
      })),
    }
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'GET', url: '/api/extensions/v1/purges',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().purges.length).toBe(1)
    const sql = String(pool.query.mock.calls.find(call =>
      /FROM extension_purge_requests/.test(String(call[0])))?.[0])
    expect(sql).toContain('provider_id = $1')
    expect(sql).toContain("status = 'pending'")
  })

  test('acks a pending request idempotently with a bounded receipt', async () => {
    const app = track(makeApp())
    const first = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { provider_receipt: 'sha256:abc' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().status).toBe('acked')

    // Second ack: the UPDATE misses, the row is already acked → success.
    const { pool } = transactionalPool(async (sql: string) => {
        if (/UPDATE extension_purge_requests/.test(sql)) return { rows: [], rowCount: 0 }
        if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
          return {
            rows: [{
              provider_id: 'pocketctl-memory', status: 'acked',
              installation_id: null, reason: 'account_deleted',
            }],
            rowCount: 1,
          }
        }
        if (/SELECT provider_id, status/.test(sql)) {
          return { rows: [{ provider_id: 'pocketctl-memory', status: 'acked' }] }
        }
        return { rows: [] }
      })
    const app2 = track(makeApp({ pool: pool as never }))
    const second = await app2.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe('acked')
  })

  test('acking an uninstall purge atomically transitions revoking installation to revoked', async () => {
    const queries: string[] = []
    const { pool, client } = transactionalPool(async (sql: string) => {
        queries.push(sql)
        if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
          return {
            rows: [{
              provider_id: 'pocketctl-memory', status: 'pending',
              installation_id: '11111111-1111-1111-1111-111111111111', reason: 'uninstall',
            }],
            rowCount: 1,
          }
        }
        if (/UPDATE extension_purge_requests/.test(sql)) {
          return { rows: [{ status: 'acked' }], rowCount: 1 }
        }
        return { rows: [{ count: '0' }], rowCount: 1 }
      })
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const installationMutation = queries.find(sql => /UPDATE extension_installations/.test(sql)) ?? ''
    expect(installationMutation).toContain("status = 'revoked'")
    expect(installationMutation).toContain("status = 'revoking'")
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('locks the installation before updating the purge request in one transaction', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim())
        if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
          return {
            rows: [{
              provider_id: 'pocketctl-memory', status: 'pending',
              installation_id: '11111111-1111-1111-1111-111111111111', reason: 'uninstall',
            }],
            rowCount: 1,
          }
        }
        if (/SELECT status[\s\S]+FROM extension_installations/.test(sql)) {
          return { rows: [{ status: 'revoking' }], rowCount: 1 }
        }
        if (/UPDATE extension_purge_requests/.test(sql)) {
          return { rows: [{ status: 'acked' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (/COUNT/.test(sql)) return { rows: [{ count: '0' }], rowCount: 1 }
        throw new Error('ack mutation escaped its transaction')
      }),
      connect: vi.fn(async () => client),
    }
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const lockIndex = statements.findIndex(sql =>
      /FROM extension_installations/.test(sql) && /FOR UPDATE/.test(sql))
    const purgeUpdateIndex = statements.findIndex(sql => /UPDATE extension_purge_requests/.test(sql))
    expect(lockIndex).toBeGreaterThan(-1)
    expect(purgeUpdateIndex).toBeGreaterThan(lockIndex)
    expect(statements[0]).toBe('BEGIN')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('rolls back and releases the transaction when the purge update fails', async () => {
    const statements: string[] = []
    const { pool, client } = transactionalPool(async (sql: string) => {
      statements.push(sql.trim())
      if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
        return {
          rows: [{
            provider_id: 'pocketctl-memory', status: 'pending',
            installation_id: '11111111-1111-1111-1111-111111111111', reason: 'uninstall',
          }],
          rowCount: 1,
        }
      }
      if (/UPDATE extension_purge_requests/.test(sql)) throw new Error('database write failed')
      return { rows: [], rowCount: 1 }
    })
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(500)
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('another provider cannot ack a foreign queue', async () => {
    const { pool } = transactionalPool(async (sql: string) => {
        if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
          return {
            rows: [{
              provider_id: 'pocketctl-memory', status: 'pending',
              installation_id: null, reason: 'account_deleted',
            }],
            rowCount: 1,
          }
        }
        return { rows: [] }
      })
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken('other-provider')}` },
    })
    expect(response.statusCode).toBe(404)
  })

  test('an already-acked uninstall repairs a legacy revoking installation', async () => {
    const queries: string[] = []
    const { pool } = transactionalPool(async (sql: string) => {
        queries.push(sql)
        if (/SELECT provider_id, status, installation_id, reason/.test(sql)) {
          return {
            rows: [{
              provider_id: 'pocketctl-memory', status: 'acked',
              installation_id: '11111111-1111-1111-1111-111111111111', reason: 'uninstall',
            }],
            rowCount: 1,
          }
        }
        if (/UPDATE extension_purge_requests/.test(sql)) return { rows: [], rowCount: 0 }
        if (/SELECT provider_id, status FROM extension_purge_requests/.test(sql)) {
          return { rows: [{ provider_id: 'pocketctl-memory', status: 'acked' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      })
    const app = track(makeApp({ pool: pool as never }))
    const response = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(response.statusCode).toBe(200)
    const repair = queries.find(sql => /UPDATE extension_installations/.test(sql)) ?? ''
    expect(repair).toContain("status = 'revoked'")
    expect(repair).toContain("status = 'revoking'")
  })

  test('bounds the receipt length and requires ids', async () => {
    const app = track(makeApp())
    const longReceipt = await app.inject({
      method: 'POST', url: `/api/extensions/v1/purges/${REQUEST}/ack`,
      headers: { authorization: `Bearer ${providerToken()}` },
      payload: { provider_receipt: 'x'.repeat(513) },
    })
    expect(longReceipt.statusCode).toBe(400)
    const badId = await app.inject({
      method: 'POST', url: '/api/extensions/v1/purges/not-a-uuid/ack',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(badId.statusCode).toBe(400)
  })

  test('requires a provider token and enabled mode', async () => {
    const app = track(makeApp())
    const anonymous = await app.inject({ method: 'GET', url: '/api/extensions/v1/purges' })
    expect(anonymous.statusCode).toBe(401)
    const off = track(makeApp({ mode: 'off' }))
    const closed = await off.inject({
      method: 'GET', url: '/api/extensions/v1/purges',
      headers: { authorization: `Bearer ${providerToken()}` },
    })
    expect(closed.statusCode).toBe(503)
  })
})
