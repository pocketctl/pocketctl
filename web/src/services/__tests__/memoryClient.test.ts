import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'

const accessToken = ref('user-token')

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ accessToken, doRefreshToken: async () => true }),
}))
vi.mock('../../composables/useEnv', () => ({
  getRelayOrigin: () => 'https://relay.example',
}))

const {
  resetMemoryClient,
  discoverMemoryInstallation,
  enableMemoryServices,
  searchMemory,
  correctMemoryClaim,
  sendMemoryFeedback,
  MemoryClientError,
} = await import('../../services/memoryClient')

const INSTALLATION = {
  installation_id: 'inst-1',
  provider_id: 'pocketctl-memory',
  status: 'active',
  granted_scopes: [],
  subscriptions: [],
  enabled_services: ['memory.search', 'memory.recall', 'memory.manage'],
  config_version: '3',
}

function relayAndProviderFetch(options: {
  grantResponse?: unknown
  providerHandler?: (url: string, init: RequestInit) => Response | Promise<Response>
}) {
  const calls: Array<{ origin: string; path: string; search: string; init: RequestInit }> = []
  const grantResponse = options.grantResponse ?? {
    grant: 'grant-token-1', expires_in: 300, token_type: 'extension_capability',
    provider_public_origin: 'https://memory.example',
  }
  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ origin: new URL(url).origin, path: new URL(url).pathname, search: new URL(url).search, init })
    if (url.includes('/api/extensions/v1/')) {
      if (url.includes('/grants')) {
        if (options.grantResponse instanceof Response) return options.grantResponse
        return new Response(JSON.stringify(grantResponse), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/installations/')) {
        return new Response(JSON.stringify({ installation: { ...INSTALLATION, enabled_services: ['memory.search', 'memory.recall', 'memory.manage', 'memory.mcp'] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ installations: [INSTALLATION] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (options.providerHandler) return options.providerHandler(url, init)
    return new Response(JSON.stringify({ hits: [], nextCursor: null, degradedComponents: [], poolSizes: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { calls, fetchImpl }
}

beforeEach(() => {
  resetMemoryClient()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('memoryClient', () => {
  test('discovers the pocketctl-memory installation via the relay', async () => {
    const { calls } = relayAndProviderFetch({})
    const installation = await discoverMemoryInstallation()
    expect(installation?.installation_id).toBe('inst-1')
    expect(calls[0].origin).toBe('https://relay.example')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer user-token')
  })

  test('prefers the active installation over an older revoked one', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      installations: [
        { ...INSTALLATION, installation_id: 'inst-revoked', status: 'revoked' },
        { ...INSTALLATION, installation_id: 'inst-active', status: 'active' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchImpl)
    const installation = await discoverMemoryInstallation()
    expect(installation?.installation_id).toBe('inst-active')
    expect(installation?.status).toBe('active')
  })

  test('falls back to the first installation when none is active', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      installations: [
        { ...INSTALLATION, installation_id: 'inst-revoked', status: 'revoked' },
        { ...INSTALLATION, installation_id: 'inst-paused', status: 'paused' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchImpl)
    const installation = await discoverMemoryInstallation()
    expect(installation?.installation_id).toBe('inst-revoked')
  })

  test('enabling services patches only the relay installation', async () => {
    const { calls } = relayAndProviderFetch({})
    const updated = await enableMemoryServices('inst-1', 3, ['memory.search', 'memory.mcp'])
    expect(updated.enabled_services).toContain('memory.mcp')
    expect(calls[0].path).toBe('/api/extensions/v1/installations/inst-1')
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ expected_config_version: 3 })
  })

  test('business calls go directly to the provider origin with the minted grant', async () => {
    const { calls } = relayAndProviderFetch({})
    await searchMemory('vitest')
    const providerCall = calls.find(call => call.origin === 'https://memory.example')
    expect(providerCall).toBeTruthy()
    expect(providerCall!.path).toBe('/api/v1/memory/search')
    expect((providerCall!.init.headers as Record<string, string>).Authorization).toBe('Bearer grant-token-1')
    expect(providerCall!.init.redirect).toBe('error')
    // The access token never leaves the relay origin.
    for (const call of calls) {
      const authorization = (call.init.headers as Record<string, string>).Authorization
      if (call.origin === 'https://memory.example') {
        expect(authorization).not.toContain('user-token')
      }
    }
  })

  test('relay calls also reject redirects before forwarding the user token', async () => {
    const { calls } = relayAndProviderFetch({})
    await discoverMemoryInstallation()
    expect(calls[0].init.redirect).toBe('error')
  })

  test('a 401 from the provider refreshes the grant exactly once', async () => {
    let providerCalls = 0
    const { calls } = relayAndProviderFetch({
      providerHandler: () => {
        providerCalls++
        if (providerCalls === 1) {
          return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } }), {
            status: 401, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ hits: [], nextCursor: null, degradedComponents: [], poolSizes: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      },
    })
    await searchMemory('vitest')
    expect(providerCalls).toBe(2)
    const grantCalls = calls.filter(call => call.path === '/api/extensions/v1/grants')
    expect(grantCalls.length).toBe(2)
  })

  test('409 revision conflicts surface the current revision', async () => {
    relayAndProviderFetch({
      providerHandler: () => new Response(JSON.stringify({
        error: { code: 'revision_conflict', message: 'stale', current_revision: 4 },
      }), { status: 409, headers: { 'content-type': 'application/json' } }),
    })
    await expect(searchMemory('vitest')).rejects.toMatchObject({
      status: 409, code: 'revision_conflict', currentRevision: 4,
    })
  })

  test('degraded vector results are surfaced, not swallowed', async () => {
    relayAndProviderFetch({
      providerHandler: () => new Response(JSON.stringify({
        hits: [], nextCursor: null, degradedComponents: ['embedding'], poolSizes: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })
    const result = await searchMemory('vitest')
    expect(result.degradedComponents).toEqual(['embedding'])
  })

  test('feedback writes carry a bounded idempotency key', async () => {
    const { calls } = relayAndProviderFetch({
      providerHandler: () => new Response(JSON.stringify({ recorded: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    })
    await sendMemoryFeedback('recall_used', '11111111-1111-4111-8111-111111111111')
    const feedback = calls.find(call => call.path === '/api/v1/memory/feedback')
    expect((feedback?.init.headers as Record<string, string>)['idempotency-key']).toMatch(/^web-feedback-/)
  })

  test('correction evidence sends only the identifier allowed by its kind', async () => {
    const { calls } = relayAndProviderFetch({
      providerHandler: () => new Response(JSON.stringify({ version_id: 'v2', version_number: 2 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    })
    await correctMemoryClaim('claim-1', 1, 'corrected', [{
      evidence_kind: 'episode', episode_id: 'episode-1',
      source_event_id: null, artifact_id: null,
      excerpt: 'evidence', occurred_at: '2026-08-25T00:00:00Z',
    }], 'correct-1')
    const request = calls.find(call => call.path.endsWith('/correct'))!
    const body = JSON.parse(String(request.init.body))
    expect(body.evidence[0]).toEqual({
      evidence_kind: 'episode', episode_id: 'episode-1', locator: {},
      excerpt: 'evidence', occurred_at: '2026-08-25T00:00:00Z',
    })
  })

  test('no grant or token is ever persisted to web storage', async () => {
    relayAndProviderFetch({})
    await searchMemory('vitest')
    expect(localStorage.getItem('memory_grant')).toBeNull()
    expect(sessionStorage.getItem('memory_grant')).toBeNull()
    for (let i = 0; i < localStorage.length; i++) {
      const value = localStorage.getItem(localStorage.key(i)!)
      expect(value).not.toContain('grant-token-1')
    }
  })

  test('superseded searches throw the bounded superseded code', async () => {
    relayAndProviderFetch({
      providerHandler: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return new Response(JSON.stringify({ hits: [], nextCursor: null, degradedComponents: [], poolSizes: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      },
    })
    const first = searchMemory('slow-query')
    const second = searchMemory('fast-query')
    await expect(first).rejects.toMatchObject({ code: 'superseded' })
    await expect(second).resolves.toBeTruthy()
  })

  test('grant failures without an installation are bounded', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ installations: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(searchMemory('vitest')).rejects.toBeInstanceOf(MemoryClientError)
  })
  test('phase two management calls go directly with the manage grant', async () => {
    const { calls } = relayAndProviderFetch({})
    const client = await import('../../services/memoryClient')
    await client.listContextSettings()
    await client.getEffectivePolicy('context')
    const manageCalls = calls.filter(call => call.path.includes('/memory/context') || call.path.includes('/memory/policies'))
    expect(manageCalls.length).toBeGreaterThanOrEqual(2)
    expect(manageCalls.every(call => call.origin === 'https://memory.example')).toBe(true)
  })

  test('context settings PUT carries the CAS revision', async () => {
    const { calls } = relayAndProviderFetch({})
    const client = await import('../../services/memoryClient')
    await client.putContextSetting({
      scope_kind: 'installation', scope_key: 'global', mode: 'shadow', expected_revision: 3,
    })
    const put = calls.find(call => call.path === '/api/v1/memory/context/settings')
    expect(put?.init.method).toBe('PUT')
    expect((put?.init.headers as Record<string, string>)['idempotency-key'])
      .toMatch(/^web-context-setting-/)
    expect(JSON.parse(String(put?.init.body))).toMatchObject({ expected_revision: 3, mode: 'shadow' })
  })

  test('phase four graph and Wiki calls preserve bounded cursors and CAS bodies', async () => {
    const { calls } = relayAndProviderFetch({
      providerHandler: () => new Response(JSON.stringify({}), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    })
    const client = await import('../../services/memoryClient')
    await client.getMemoryCodeGraph('repo-1', 'signed graph cursor')
    await client.analyzeMemoryChangeImpact('repo-1', {
      entry_paths: ['src/index.ts'], depth: 2, max_nodes: 50, max_edges: 100,
    })
    await client.getMemoryWiki('repo-1')
    await client.listMemoryWikiBuilds('wiki-1', 'signed wiki cursor')
    await client.scheduleMemoryWikiBuild('wiki-1', 4)
    await client.publishMemoryWikiCandidate('wiki-1', 'build-1', 4, 2)
    await client.editMemoryWikiSection('wiki-1', 'operations', 'Manual runbook', 3)
    await client.setMemoryWikiSectionLock('wiki-1', 'operations', 'lock', 4)

    expect(calls.find(call => call.path.endsWith('/repo-1/codegraph'))?.path).toBe(
      '/api/v1/memory/repositories/repo-1/codegraph',
    )
    const graphCall = calls.find(call => String(call.init.method ?? 'GET') === 'GET'
      && call.path.includes('/codegraph'))!
    expect(graphCall.search).toContain('cursor=signed+graph+cursor')
    const buildsList = calls.find(call => call.path.endsWith('/wiki-1/builds') && !call.init.method)!
    expect(buildsList.search).toContain('cursor=signed+wiki+cursor')
    const impact = calls.find(call => call.path.endsWith('/impact'))!
    expect(JSON.parse(String(impact.init.body))).toMatchObject({ entry_paths: ['src/index.ts'], depth: 2 })
    const build = calls.find(call => call.path.endsWith('/wiki-1/builds') && call.init.method === 'POST')!
    expect(JSON.parse(String(build.init.body))).toEqual({ expected_generation: 4 })
    const publish = calls.find(call => call.path.endsWith('/publish'))!
    expect(JSON.parse(String(publish.init.body))).toEqual({ expected_generation: 4, expected_head_revision: 2 })
    const edit = calls.find(call => call.path.includes('/manual-sections/operations') && call.init.method === 'PUT')!
    expect(JSON.parse(String(edit.init.body))).toMatchObject({ markdown: 'Manual runbook', expected_lock_version: 3 })
    const lock = calls.find(call => call.path.endsWith('/operations/lock'))!
    expect(JSON.parse(String(lock.init.body))).toEqual({ expected_lock_version: 4 })
    expect(calls.filter(call => call.origin === 'https://memory.example').every(call =>
      (call.init.headers as Record<string, string>).Authorization === 'Bearer grant-token-1')).toBe(true)
  })

	test('policy diff uses a browser-compatible POST body', async () => {
		const { calls } = relayAndProviderFetch({})
		const client = await import('../../services/memoryClient')
		await client.previewPolicyDiff({ kind: 'context', document: { max_items: 4 } })
		const request = calls.find(call => call.path === '/api/v1/memory/policies/context/diff')
		expect(request?.init.method).toBe('POST')
		expect(JSON.parse(String(request?.init.body))).toEqual({ document: { max_items: 4 } })
	})

})
