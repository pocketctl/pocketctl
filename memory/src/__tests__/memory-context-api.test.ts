import { describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { registerContextRoutes } from '../api/context-routes.js'
import type { GrantGuard } from '../auth/grant-guard.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'

const INSTALLATION = '0d0d0d0d-0d0d-40d0-80d0-0d0d0d0d0d0d'

function stubGuard(verified: { callerType?: string; sessionId?: string; service?: string }) {
  return {
    guard: vi.fn(async (input: { requiredService: string; sessionId?: string }) => {
      if (verified.service && input.requiredService !== verified.service) {
        throw new Error('grant rejected')
      }
      return {
        installationId: INSTALLATION,
        services: [input.requiredService],
        configVersion: '1',
        callerType: verified.callerType ?? 'daemon',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }
    }),
  } as unknown as GrantGuard
}

function policy() {
  return createCorsHostPolicy({ allowedOrigins: [], allowedHosts: ['memory.test'], isProduction: false })
}

function appWith(deps: Partial<Parameters<typeof registerContextRoutes>[1]>) {
  const app = Fastify()
  registerContextRoutes(app, {
    pool: {} as never,
    guard: stubGuard({}),
    policy: policy(),
    compiler: { compile: vi.fn(async () => ({ kind: 'off' })) } as never,
    admission: { admit: vi.fn(), receipt: vi.fn() } as never,
    feedback: { submit: vi.fn() } as never,
    packs: { listForSession: vi.fn(), get: vi.fn() } as never,
    settings: { list: vi.fn(), upsert: vi.fn(), resolve: vi.fn() } as never,
    loadouts: { resolve: vi.fn(), replace: vi.fn() } as never,
    requestKey: { keyId: 'k', hmacKey: Buffer.alloc(32, 1) },
    ...deps,
  })
  return app
}

describe('context route contracts (unit)', () => {
  test('compile rejects a malformed body with a bounded error', async () => {
    const app = appWith({})
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: { schema_version: 2 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
    // The bounded error never echoes the body.
    expect(response.body).not.toContain('schema_version')
  })

  test('a non-daemon caller is forbidden on the compile route', async () => {
    const app = appWith({ guard: stubGuard({ callerType: 'web' }) })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        schema_version: 1, client_request_id: 'cr-1', session_id: 'ses-1',
        agent: 'codex', adapter_capability: 'native_hidden_v1', query: 'q',
      },
    })
    expect(response.statusCode).toBe(403)
  })

  test('an off compile outcome maps to the frozen wire shape', async () => {
    const app = appWith({
      compiler: { compile: vi.fn(async () => ({ kind: 'off' })) } as never,
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        schema_version: 1, client_request_id: 'cr-1', session_id: 'ses-1',
        agent: 'codex', adapter_capability: 'native_hidden_v1', query: 'hello',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ outcome: 'off' })
  })

	test('compile truncates transient Unicode queries by UTF-8 bytes', async () => {
		const compile = vi.fn(async (_input: Record<string, unknown>) => ({ kind: 'off' as const }))
		const app = appWith({ compiler: { compile } as never })
		const response = await app.inject({
			method: 'POST', url: '/api/v1/memory/context/compile',
			headers: { host: 'memory.test', authorization: 'Bearer g' },
			payload: {
				schema_version: 1, client_request_id: 'cr-unicode', session_id: 'ses-1',
				agent: 'codex', adapter_capability: 'native_hidden_v1', query: '界'.repeat(20_000),
			},
		})
		expect(response.statusCode).toBe(200)
		const query = String(compile.mock.calls[0][0].query)
		expect(Buffer.byteLength(query, 'utf8')).toBeLessThanOrEqual(32 * 1024)
		expect(query).not.toContain('\uFFFD')
	})

  test('compile rejects malformed repository hints before any database scope lookup', async () => {
    const compile = vi.fn(async () => ({ kind: 'off' as const }))
    const app = appWith({ compiler: { compile } as never })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        schema_version: 1, client_request_id: 'cr-repo-invalid', session_id: 'ses-1',
        agent: 'codex', adapter_capability: 'native_hidden_v1', query: 'q',
        repository_hint: { repository_id: 'not-a-uuid', branch: 'x'.repeat(256) },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('invalid_request')
    expect(compile).not.toHaveBeenCalled()
  })

  test('compile resolves a canonical daemon repository fact as an installation-scoped key hint', async () => {
    const compile = vi.fn(async () => ({ kind: 'off' as const }))
    const app = appWith({ compiler: { compile } as never })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/context/compile',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: {
        schema_version: 1, client_request_id: 'cr-repo-key', session_id: 'ses-1',
        agent: 'codex', adapter_capability: 'native_hidden_v1', query: 'q',
        repository_hint: {
          repository_id: 'gitee.com/muwb123/pocketctl', branch: 'develop',
          commit_sha: 'a'.repeat(40),
        },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: null,
      repositoryKey: 'gitee.com/muwb123/pocketctl',
      branch: 'develop',
    }))
  })

  test('pack text is consumed once through a session-bound admitted injection', async () => {
    const consume = vi.fn(async () => ({
      ok: true,
      pack: {
        packId: '11111111-1111-4111-8111-111111111111',
        stableText: 'stable context',
        dynamicText: 'dynamic context',
        stableHash: 'aa',
        dynamicHash: 'bb',
      },
    }))
    const guard = stubGuard({ callerType: 'daemon' })
    const app = appWith({
      guard,
      admission: { admit: vi.fn(), receipt: vi.fn(), consume } as never,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/memory/context/packs/11111111-1111-4111-8111-111111111111/text'
        + '?session_id=ses-1&injection_id=22222222-2222-4222-8222-222222222222&nonce=one-time',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      pack_id: '11111111-1111-4111-8111-111111111111',
      stable_text: 'stable context',
      dynamic_text: 'dynamic context',
      stable_hash: 'aa',
      dynamic_hash: 'bb',
    })
    expect(guard.guard).toHaveBeenCalledWith(expect.objectContaining({
      requiredService: 'memory.context', sessionId: 'ses-1',
    }))
  })

  test('receipt re-verifies the grant session against the injection session', async () => {
    const receipt = vi.fn(async () => ({ ok: true, state: 'delivered' }))
    const guard = stubGuard({ callerType: 'daemon' })
    const app = appWith({
      guard,
      admission: { admit: vi.fn(), consume: vi.fn(), receipt } as never,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/context/injections/22222222-2222-4222-8222-222222222222/receipt',
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: { session_id: 'ses-1', delivered: true, outcome_code: 'accepted' },
    })

    expect(response.statusCode).toBe(200)
    expect(guard.guard).toHaveBeenCalledWith(expect.objectContaining({
      requiredService: 'memory.context', sessionId: 'ses-1',
    }))
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1', injectionId: '22222222-2222-4222-8222-222222222222',
    }))
  })

  test('usage is session-bound and rejects unsafe token counters', async () => {
    const query = vi.fn(async (_sql: string) => ({ rowCount: 1, rows: [] }))
    const guard = stubGuard({ callerType: 'daemon' })
    const app = appWith({ pool: { query } as never, guard })
    const url = '/api/v1/memory/context/injections/22222222-2222-4222-8222-222222222222/usage'

    const accepted = await app.inject({
      method: 'POST', url,
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: { session_id: 'ses-1', input_tokens: 10, output_tokens: 4, cached_tokens: 2 },
    })
    expect(accepted.statusCode).toBe(200)
    expect(guard.guard).toHaveBeenCalledWith(expect.objectContaining({
      requiredService: 'memory.context', sessionId: 'ses-1',
    }))

    const rejected = await app.inject({
      method: 'POST', url,
      headers: { host: 'memory.test', authorization: 'Bearer g' },
      payload: { session_id: 'ses-1', input_tokens: -1, output_tokens: 0, cached_tokens: 0 },
    })
    expect(rejected.statusCode).toBe(400)
    expect(String(query.mock.calls[0][0])).toContain("state = 'delivered'")
  })

  test('agent and management routes reject malformed identifiers before repository calls', async () => {
    const admit = vi.fn()
    const listForSession = vi.fn()
    const feedback = vi.fn()
    const settings = vi.fn()
    const resolveLoadout = vi.fn()
    const replaceLoadout = vi.fn()
    const app = appWith({
      admission: { admit, receipt: vi.fn(), consume: vi.fn() } as never,
      packs: { listForSession, get: vi.fn() } as never,
      feedback: { submit: feedback } as never,
      settings: { list: vi.fn(), upsert: settings, resolve: vi.fn() } as never,
      loadouts: { resolve: resolveLoadout, replace: replaceLoadout } as never,
    })
    const headers = { host: 'memory.test', authorization: 'Bearer g' }

    const responses = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/v1/memory/context/packs/not-a-uuid/admit', headers,
        payload: {
          client_request_id: 'cr-1', session_id: 'ses-1', agent: 'codex', adapter: 'opencode-server',
        },
      }),
      app.inject({
        method: 'GET', url: `/api/v1/memory/context/packs?session_id=${'s'.repeat(65)}`, headers,
      }),
      app.inject({
        method: 'POST', url: '/api/v1/memory/context/feedback', headers,
        payload: { action: 'used', pack_id: 'not-a-uuid' },
      }),
      app.inject({
        method: 'PUT', url: '/api/v1/memory/context/settings', headers,
        payload: {
          scope_kind: 'repository', scope_key: 'not-a-uuid', mode: 'enabled', expected_revision: 1,
        },
      }),
      app.inject({
        method: 'GET', url: '/api/v1/memory/context/loadouts?repository_id=not-a-uuid', headers,
      }),
      app.inject({
        method: 'PUT', url: '/api/v1/memory/context/loadouts', headers,
        payload: {
          expected_revision: 1,
          items: [{
            item_id: 'not-a-uuid', asset_kind: 'claim', claim_id: 'also-not-a-uuid',
            representation: 'summary', priority: 101,
          }],
        },
      }),
    ])

    expect(responses.map(response => response.statusCode)).toEqual([400, 400, 400, 400, 400, 400])
    expect(admit).not.toHaveBeenCalled()
    expect(listForSession).not.toHaveBeenCalled()
    expect(feedback).not.toHaveBeenCalled()
    expect(settings).not.toHaveBeenCalled()
    expect(resolveLoadout).not.toHaveBeenCalled()
    expect(replaceLoadout).not.toHaveBeenCalled()
  })
})
