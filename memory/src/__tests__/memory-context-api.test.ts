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
    pool: {query:vi.fn(async()=>({rows:[]}))} as never,
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
  test('validates an exact published Team claim through a readable v2 binding', async () => {
    const version = '11111111-1111-4111-8111-111111111111'
    const claim = '22222222-2222-4222-8222-222222222222'
    const scope = '33333333-3333-4333-8333-333333333333'
    const guardV2 = vi.fn(async () => ({
      version: 'v2' as const,
      installationId: INSTALLATION,
      primaryInstallationId: INSTALLATION,
      services: ['memory.context'], configVersion: '1', callerType: 'web',
      scopeBindings: [{
        installation_id: INSTALLATION, owner_scope_kind: 'team' as const,
        owner_scope_id: scope, membership_id: 'membership', membership_revision: '1',
        authorization_epoch: '1', permissions: ['read'],
      }],
    }))
    const query = vi.fn(async () => ({ rows: [{
      claim_id: claim, version_id: version, claim_type: 'implementation_map',
      statement: 'published', owner_scope_kind: 'team', owner_scope_id: scope,
      scope_kind:'installation',scope_key:'global',current:true,time_eligible:true,source_metadata_owned:true,
      evidence_ids: ['44444444-4444-4444-8444-444444444444'],
    }] }))
    const app = appWith({
      pool: { query } as never,
      guard: { guardV2 } as unknown as GrantGuard,
    })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memory/context/references/validate',
      headers: { host: 'memory.test', authorization: 'Bearer v2' },
      payload: {
        installation_id: INSTALLATION,
        references: [{
          source_kind: 'memory_claim', source_id: claim, source_version: version,
          owner_scope_id: scope, installation_id: INSTALLATION,
        }],
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ valid: true })
    expect(guardV2).toHaveBeenCalledWith(expect.objectContaining({ requiredService: 'memory.context' }))
  })

  test.each(['matching','missing','different'])('v2 Context requires the signed Session (%s)',async mode=>{
    const grant={version:'v2',installationId:INSTALLATION,primaryInstallationId:INSTALLATION,services:['memory.context'],configVersion:'1',callerType:'daemon',scopeBindings:[],...(mode==='missing'?{}:{sessionId:mode==='matching'?'ses-1':'other-session'})}
    const compile=vi.fn(async()=>({kind:'off'})),app=appWith({guard:{guard:async()=>grant} as never,compiler:{compile} as never})
    const response=await app.inject({method:'POST',url:'/api/v1/memory/context/compile',headers:{host:'memory.test',authorization:'Bearer v2'},payload:{schema_version:1,client_request_id:'signed-session',session_id:'ses-1',agent:'codex',adapter_capability:'native_hidden_v1',query:'q'}})
    expect(response.statusCode).toBe(mode==='matching'?200:401)
    expect(compile).toHaveBeenCalledTimes(mode==='matching'?1:0)
  })
  test('consume carries only server-verified scope grant facts',async()=>{
    const grant={version:'v2',installationId:INSTALLATION,primaryInstallationId:INSTALLATION,services:['memory.context'],configVersion:'1',callerType:'daemon',sessionId:'ses-1',scopeBindings:[]}
    const consume=vi.fn(async()=>({ok:false,error:'expired'})),app=appWith({sharedScopesEnabled:true,guard:{guard:async()=>grant} as never,admission:{consume} as never})
    const response=await app.inject({method:'GET',url:'/api/v1/memory/context/packs/11111111-1111-4111-8111-111111111111/text?session_id=ses-1&injection_id=22222222-2222-4222-8222-222222222222&nonce=one-time',headers:{host:'memory.test',authorization:'Bearer v2'}})
    expect(response.statusCode).toBe(410);expect(consume).toHaveBeenCalledWith(expect.objectContaining({selectedScopeGrant:grant}))
  })

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

  test('concurrent consumption changes preserve the degraded reason on the wire', async () => {
    const app=appWith({compiler:{compile:vi.fn(async()=>({kind:'degraded',reason:'context_consumption_changed'}))} as never})
    const response=await app.inject({method:'POST',url:'/api/v1/memory/context/compile',headers:{host:'memory.test',authorization:'Bearer g'},payload:{schema_version:1,client_request_id:'cr-race',session_id:'ses-1',agent:'codex',adapter_capability:'native_hidden_v1',query:'hello'}})
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({outcome:'degraded',reason:'context_consumption_changed'})
  })

  test.each([
    { timestamp: 'daemon-start', expectedAge: expect.any(Number) },
    { timestamp: 'private-invalid-clock', expectedAge: null },
  ])('slow native compilation logs bounded phase timings without request data ($timestamp)', async ({ timestamp, expectedAge }) => {
    const started = timestamp === 'daemon-start' ? new Date(Date.now() - 300).toISOString().replace('Z', '123456Z') : timestamp
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const app = appWith({ compiler: { compile: async (_input: unknown, observe: (phase: string, ms: number) => void) => {
      await new Promise(resolve => setTimeout(resolve, 425))
      observe('retrieve', 400)
      observe('persist_commit', 13)
      return { kind: 'ready', packId: 'private-pack', stableTokens: 0, dynamicTokens: 2, itemCount: 1 }
    } } as never })
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/memory/context/compile',
        headers: { host: 'memory.test', authorization: 'Bearer private-grant' },
        payload: { schema_version: 1, client_request_id: 'private-request', session_id: 'private-session',
          agent: 'codex', adapter_capability: 'native_hidden_v1', query: 'private-query', requested_at: started },
      })
      expect(response.statusCode).toBe(200)
      const line = log.mock.calls.map(call => String(call[0])).find(value => value.includes('context_compile_latency'))
      expect(line).toBeDefined()
      const timing = JSON.parse(line!)
      expect(timing).toMatchObject({ outcome: 'ready', grant_ms: expect.any(Number), compile_ms: expect.any(Number), retrieve_ms: 400, persist_commit_ms: 13, daemon_request_age_ms: expectedAge })
      if (timestamp === 'daemon-start') {
        expect(timing.daemon_request_age_ms).toBeGreaterThanOrEqual(300)
        expect(timing.daemon_request_age_ms).toBeLessThan(700)
      }
      expect(line).not.toContain(started)
      expect(line).not.toContain('private-')
    } finally {
      log.mockRestore()
      await app.close()
    }
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
    }), expect.any(Function))
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
      guard: stubGuard({ callerType: 'web' }),
      pool: { query: async () => ({ rows: [{ owner_scope_kind: 'personal' }] }) } as never,
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

test.each([['web','user'],['daemon','agent'],['mcp','agent']])('feedback identity comes from authenticated %s caller',async(callerType,actor)=>{
 const query=vi.fn(async(sql:string,_values?:unknown[])=>{
  if(sql.includes('SELECT EXISTS'))return{rows:[{visible:true}],rowCount:1}
  return{rows:[],rowCount:1}
 })
 const pool={connect:async()=>({query,release:()=>undefined})}
 const app=appWith({pool:pool as never,guard:stubGuard({callerType})})
 const response=await app.inject({method:'POST',url:'/api/v1/memory/context/feedback',headers:{host:'memory.test',authorization:'Bearer fixture','idempotency-key':'fixture-feedback'},payload:{pack_id:'11111111-1111-4111-8111-111111111111',item_id:'22222222-2222-4222-8222-222222222222',action:'used',actor:'user'}})
 expect(response.statusCode,response.body).toBe(200)
 const insert=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO memory_context_feedback'))
 expect(insert?.[1]?.[5]).toBe(actor)
 await app.close()
})

test.each(['rate_limited','throws','missing_source','snapshot_context_unavailable','degraded','off','unsupported_adapter','shadow'])('unavailable Context %s resets lifecycle observation',async(kind)=>{
 const query=vi.fn(async()=>({rows:[]}))
 const compile=vi.fn(async()=>{if(kind==='throws')throw Error('compiler unavailable');return ['missing_source','snapshot_context_unavailable'].includes(kind)?{kind:'empty',reason:kind,degradedComponents:[]}:{kind,packId:'pack'}})
 const app=appWith({pool:{query} as never,compiler:{compile} as never,...(kind==='rate_limited'?{rateLimiter:{check:()=>({allowed:false})} as never}:{})})
 const response=await app.inject({method:'POST',url:'/api/v1/memory/context/compile',headers:{host:'memory.test',authorization:'Bearer fixture'},payload:{schema_version:1,client_request_id:'observation-failure',session_id:'ses-1',agent:'codex',adapter_capability:'native_hidden_v1',query:'q'}})
 expect(response.statusCode).toBe(kind==='rate_limited'?429:kind==='throws'?500:200)
 expect(query).toHaveBeenCalledWith('SELECT memory_invalidate_lifecycle_observation($1::uuid)',[INSTALLATION])
 if(kind==='rate_limited')expect(compile).not.toHaveBeenCalled()
 await app.close()
})
