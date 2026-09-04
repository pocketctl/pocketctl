import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ExtensionInstallationConflictError,
  ExtensionInstallationNotFoundError,
  ExtensionInstallationRepository,
  ExtensionInstallationVersionConflictError,
} from '../extensions/installation-repository.js'

type RegisterRoutes = (
  app: FastifyInstance,
  deps: {
    pool: unknown
    verifyAccessToken(token: string): Promise<{ userId: number } | null>
    mode: 'off' | 'shadow' | 'enabled'
    repository: ExtensionInstallationRepository
    cursorSecret?: string
  },
) => void

const { registerExtensionInstallationRoutes } = await import('../extensions/installation-routes.js') as {
  registerExtensionInstallationRoutes: RegisterRoutes
}

const CURSOR_SECRET = 'replay-cursor-secret-0123456789'

const VALID_BODY = {
  provider_id: 'pocketctl-memory',
  granted_scopes: ['session:events:read'],
  subscriptions: ['session.event.v1'],
  enabled_services: ['memory.search'],
  start_policy: 'from_now',
}

function makeRepository(overrides: Partial<ExtensionInstallationRepository> = {}) {
  return {
    listInstallations: vi.fn(async () => []),
    createInstallation: vi.fn(async () => ({
      installation_id: '11111111-1111-1111-1111-111111111111',
      provider_id: 'pocketctl-memory',
      owner_user_id: 1,
      status: 'pending',
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
      event_filter: {},
      start_policy: 'from_now',
      start_feed_id: 42,
      config_version: 1,
      created_at: new Date('2026-08-23T10:00:00Z'),
      updated_at: new Date('2026-08-23T10:00:00Z'),
    })),
    updateInstallation: vi.fn(async () => ({
      installation_id: '11111111-1111-1111-1111-111111111111',
      provider_id: 'pocketctl-memory',
      owner_user_id: 1,
      status: 'paused',
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
      event_filter: {},
      start_policy: 'from_now',
      start_feed_id: 42,
      config_version: 2,
      created_at: new Date('2026-08-23T10:00:00Z'),
      updated_at: new Date('2026-08-23T10:00:00Z'),
    })),
    getInstallationForUser: vi.fn(async () => ({
      installation_id: '11111111-1111-1111-1111-111111111111',
      provider_id: 'pocketctl-memory',
      owner_user_id: 1,
      status: 'active',
      granted_scopes: ['session:events:read'],
      subscriptions: ['session.event.v1'],
      enabled_services: ['memory.search'],
      event_filter: {},
      start_policy: 'from_now',
      start_feed_id: 42,
      config_version: 1,
      created_at: new Date('2026-08-23T10:00:00Z'),
      updated_at: new Date('2026-08-23T10:00:00Z'),
    })),
    revokeInstallation: vi.fn(async () => ({
      installation: {
        installation_id: '11111111-1111-1111-1111-111111111111',
        status: 'revoking',
      },
      purge_request_id: '22222222-2222-2222-2222-222222222222',
    })),
    ...overrides,
  } as unknown as ExtensionInstallationRepository
}

describe('extension installation user API', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function makeApp(options: {
    mode?: 'off' | 'shadow' | 'enabled'
    userId?: number | null
    repository?: ExtensionInstallationRepository
  }) {
    const app = Fastify()
    apps.push(app)
    registerExtensionInstallationRoutes(app, {
      pool: {},
      verifyAccessToken: vi.fn(async () =>
        options.userId === null
          ? null
          : { userId: options.userId ?? 1 }),
      mode: options.mode ?? 'enabled',
      repository: options.repository ?? makeRepository(),
    })
    return app
  }

  function authHeaders() {
    return { authorization: 'Bearer valid-token' }
  }

  test('lists the code-owned catalog with the runtime capability', async () => {
    const app = makeApp({ mode: 'enabled' })
    const response = await app.inject({ method: 'GET', url: '/api/extensions/v1/providers', headers: authHeaders() })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.capability.mode).toBe('enabled')
    expect(body.capability.can_install).toBe(true)
    expect(body.providers.map((provider: { provider_id: string }) => provider.provider_id))
      .toEqual(['pocketctl-memory'])
  })

  test('off mode advertises a disabled install capability', async () => {
    const app = makeApp({ mode: 'off' })
    const response = await app.inject({ method: 'GET', url: '/api/extensions/v1/providers', headers: authHeaders() })
    expect(response.statusCode).toBe(200)
    expect(response.json().capability.can_install).toBe(false)
  })

  test('rejects anonymous access with 401', async () => {
    const app = makeApp({ userId: null })
    const response = await app.inject({ method: 'GET', url: '/api/extensions/v1/installations' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('unauthorized')
  })

  test('creates an installation in enabled mode', async () => {
    const repository = makeRepository()
    const app = makeApp({ repository })
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/installations',
      headers: authHeaders(), payload: VALID_BODY,
    })
    expect(response.statusCode).toBe(201)
    expect(repository.createInstallation).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 1,
      providerId: 'pocketctl-memory',
    }))
    expect(response.json().installation.status).toBe('pending')
  })

  test('shadow and off refuse to create installations', async () => {
    for (const mode of ['shadow', 'off'] as const) {
      const repository = makeRepository()
      const app = makeApp({ mode, repository })
      const response = await app.inject({
        method: 'POST', url: '/api/extensions/v1/installations',
        headers: authHeaders(), payload: VALID_BODY,
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('feature_disabled')
      expect(repository.createInstallation).not.toHaveBeenCalled()
    }
  })

  test('rejects grants outside the manifest allowlists', async () => {
    const app = makeApp({})
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/installations',
      headers: authHeaders(),
      payload: { ...VALID_BODY, granted_scopes: ['session:events:write'] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
  })

  test('bounds array lengths and body fields', async () => {
    const app = makeApp({})
    const tooMany = await app.inject({
      method: 'POST', url: '/api/extensions/v1/installations',
      headers: authHeaders(),
      payload: { ...VALID_BODY, granted_scopes: ['session:events:read', 'session:snapshot:read', 'session:deletion:read', 'extra-1', 'extra-2', 'extra-3', 'extra-4'] },
    })
    expect(tooMany.statusCode).toBe(400)
    const longFilter = await app.inject({
      method: 'POST', url: '/api/extensions/v1/installations',
      headers: authHeaders(),
      payload: { ...VALID_BODY, event_filter: { daemon_ids: Array.from({ length: 65 }, (_, i) => `d-${i}`) } },
    })
    expect(longFilter.statusCode).toBe(400)
  })

  test('maps duplicate installations to 409', async () => {
    const repository = makeRepository({
      createInstallation: vi.fn(async () => { throw new ExtensionInstallationConflictError() }),
    })
    const app = makeApp({ repository })
    const response = await app.inject({
      method: 'POST', url: '/api/extensions/v1/installations',
      headers: authHeaders(), payload: VALID_BODY,
    })
    expect(response.statusCode).toBe(409)
  })

  test('PATCH requires the expected config version and applies transitions', async () => {
    const repository = makeRepository()
    const app = makeApp({ repository })
    const ok = await app.inject({
      method: 'PATCH', url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111',
      headers: authHeaders(),
      payload: { expected_config_version: 1, status: 'paused' },
    })
    expect(ok.statusCode).toBe(200)
    expect(repository.updateInstallation).toHaveBeenCalledWith(
      1, '11111111-1111-1111-1111-111111111111', 1, { status: 'paused' },
    )

    const stale = makeRepository({
      updateInstallation: vi.fn(async () => { throw new ExtensionInstallationVersionConflictError() }),
    })
    const appStale = makeApp({ repository: stale })
    const conflict = await appStale.inject({
      method: 'PATCH', url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111',
      headers: authHeaders(),
      payload: { expected_config_version: 99, status: 'paused' },
    })
    expect(conflict.statusCode).toBe(409)
  })

  test('PATCH merges omitted grant fields from the current installation', async () => {
    const repository = makeRepository()
    const app = makeApp({ repository })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111',
      headers: authHeaders(),
      payload: { expected_config_version: 1, enabled_services: ['memory.recall'] },
    })
    expect(response.statusCode).toBe(200)
    expect(repository.updateInstallation).toHaveBeenCalledWith(
      1,
      '11111111-1111-1111-1111-111111111111',
      1,
      {
        granted_scopes: ['session:events:read'],
        subscriptions: ['session.event.v1'],
        enabled_services: ['memory.recall'],
      },
    )
  })

  test('DELETE revokes and creates a purge request instead of dropping the row', async () => {
    const repository = makeRepository()
    const app = makeApp({ repository })
    const response = await app.inject({
      method: 'DELETE', url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111',
      headers: authHeaders(),
    })
    expect(response.statusCode).toBe(200)
    expect(repository.revokeInstallation).toHaveBeenCalledWith(1, '11111111-1111-1111-1111-111111111111')
    expect(response.json().installation.status).toBe('revoking')
    expect(response.json().purge_request_id).toBeDefined()
  })

  test('cross-user installation access is a 404', async () => {
    const repository = makeRepository({
      updateInstallation: vi.fn(async () => { throw new ExtensionInstallationNotFoundError() }),
      revokeInstallation: vi.fn(async () => { throw new ExtensionInstallationNotFoundError() }),
    })
    const app = makeApp({ repository })
    const patch = await app.inject({
      method: 'PATCH', url: '/api/extensions/v1/installations/33333333-3333-3333-3333-333333333333',
      headers: authHeaders(), payload: { expected_config_version: 1, status: 'paused' },
    })
    expect(patch.statusCode).toBe(404)
    expect(patch.json().error.code).toBe('not_found')
    const del = await app.inject({
      method: 'DELETE', url: '/api/extensions/v1/installations/33333333-3333-3333-3333-333333333333',
      headers: authHeaders(),
    })
    expect(del.statusCode).toBe(404)
  })
})

describe('extension installation repository transactions', () => {
  test('revoke and purge request creation commit through one client transaction', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim())
        if (/UPDATE extension_installations/.test(sql)) {
          return { rows: [{ provider_id: 'pocketctl-memory', status: 'revoking' }], rowCount: 1 }
        }
        if (/INSERT INTO extension_purge_requests/.test(sql)) {
          return { rows: [{ request_id: '22222222-2222-2222-2222-222222222222' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(async () => { throw new Error('mutation escaped transaction') }),
      connect: vi.fn(async () => client),
    }
    const repository = new ExtensionInstallationRepository(pool as never)

    const result = await repository.revokeInstallation(
      1, '11111111-1111-1111-1111-111111111111',
    )

    expect(statements[0]).toBe('BEGIN')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
    expect(result.purge_request_id).toBe('22222222-2222-2222-2222-222222222222')
  })

  test('purge request failure rolls back the revoking transition', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim())
        if (/UPDATE extension_installations/.test(sql)) {
          return { rows: [{ provider_id: 'pocketctl-memory', status: 'revoking' }], rowCount: 1 }
        }
        if (/INSERT INTO extension_purge_requests/.test(sql)) throw new Error('purge insert failed')
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const repository = new ExtensionInstallationRepository({
      query: vi.fn(), connect: vi.fn(async () => client),
    } as never)

    await expect(repository.revokeInstallation(
      1, '11111111-1111-1111-1111-111111111111',
    )).rejects.toThrow('purge insert failed')

    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })
})

describe('extension installation replay', () => {
  const apps: Array<FastifyInstance> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  function repositoryWithStatus(status: string) {
    return makeRepository({
      getInstallationForUser: vi.fn(async () => ({
        installation_id: '11111111-1111-1111-1111-111111111111',
        provider_id: 'pocketctl-memory',
        owner_user_id: 1,
        status: status as never,
        granted_scopes: ['session:events:read'],
        subscriptions: ['session.event.v1'],
        enabled_services: ['memory.search'],
        event_filter: {},
        start_policy: 'from_now' as const,
        start_feed_id: 0,
        config_version: 1,
        created_at: new Date(),
        updated_at: new Date(),
      })),
    }) as unknown as ExtensionInstallationRepository
  }

  function makeReplayApp(status: string, options: { mode?: 'off' | 'shadow' | 'enabled'; pausedRows?: number; recheckStatus?: string } = {}) {
    const app = Fastify()
    apps.push(app)
    registerExtensionInstallationRoutes(app, {
      pool: {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn(async (sql: string) => {
            if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql.trim())) return { rows: [] }
            if (/SET status = 'paused'/.test(sql)) {
              return { rows: [{ status: 'paused' }], rowCount: options.pausedRows ?? 1 }
            }
            if (/SELECT status FROM extension_installations/.test(sql)) {
              return { rows: [{ status: options.recheckStatus ?? 'revoked' }], rowCount: 1 }
            }
            return { rows: [] }
          }),
          release: vi.fn(),
        }),
        query: vi.fn(async () => ({ rows: [] })),
      } as never,
      verifyAccessToken: vi.fn(async () => ({ userId: 1 })),
      mode: options.mode ?? 'enabled',
      cursorSecret: CURSOR_SECRET,
      repository: repositoryWithStatus(status),
    })
    return app
  }

  test('replays an active installation and resets the checkpoint', async () => {
    const app = makeReplayApp('active')
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111/replay',
      headers: { authorization: 'Bearer t' },
      payload: { from: 'retention_start' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().from).toBe('retention_start')
  })

  test('revoking and revoked installations can never be replayed back to life', async () => {
    for (const status of ['revoking', 'revoked']) {
      const app = makeReplayApp(status)
      const response = await app.inject({
        method: 'POST',
        url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111/replay',
        headers: { authorization: 'Bearer t' },
        payload: { from: 'retention_start' },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('invalid_request')
    }
  })

  test('a paused installation can replay itself (runbook flow)', async () => {
    const app = makeReplayApp('paused')
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111/replay',
      headers: { authorization: 'Bearer t' },
      payload: { from: 'retention_start' },
    })
    expect(response.statusCode).toBe(200)
  })

  test('a concurrent revoke during the transaction fails closed with 409', async () => {
    const app = makeReplayApp('active', {
      pausedRows: 0,
      recheckStatus: 'revoking',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111/replay',
      headers: { authorization: 'Bearer t' },
      payload: { from: 'retention_start' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.message).toContain('revoking')
  })

  test('off and shadow refuse replay', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const app = makeReplayApp('active', { mode })
      const response = await app.inject({
        method: 'POST',
        url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111/replay',
        headers: { authorization: 'Bearer t' },
        payload: { from: 'retention_start' },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('feature_disabled')
    }
  })

  test('cursor replay validates the cursor binding', async () => {
    const app = makeReplayApp('active')
    const response = await app.inject({
      method: 'POST',
      url: '/api/extensions/v1/installations/11111111-1111-1111-1111-111111111111/replay',
      headers: { authorization: 'Bearer t' },
      payload: { from: 'cursor', cursor: 'garbage' },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error.code).toBe('cursor_expired')
  })
})
