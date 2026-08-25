import Fastify, { type FastifyInstance } from 'fastify'
import pg from 'pg'
import { generateKeyPairSync } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  publicJwks,
  resolveGrantKeyMaterial,
  signCapabilityGrant,
} from '../../../relay/src/extensions/capability-grant.js'
import jwt from 'jsonwebtoken'
import { createGrantGuard } from '../auth/grant-guard.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { registerMcpRoute } from '../mcp/server.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = 'aaaaaaa9-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function rpc(method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method, params }
}

describeWithDatabase('memory MCP endpoint (PostgreSQL + real grants)', () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let jwksApp: FastifyInstance
  let keys: ReturnType<typeof resolveGrantKeyMaterial>

  /** Sign a structurally valid grant whose exp is firmly in the past. */
  const signExpiredGrant = (): string => {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign({
      token_type: 'extension_capability',
      installation_id: INSTALLATION,
      provider_id: 'pocketctl-memory',
      caller_type: 'agent',
      services: ['memory.mcp'],
      config_version: '1',
      exp: now - 3_600,
      iat: now - 7_200,
    }, keys.privateKeyPem, {
      algorithm: 'RS256',
      keyid: keys.kid,
      issuer: 'https://relay.test',
      audience: 'pocketctl-memory',
      subject: 'user:42',
      jwtid: 'expired-grant-test',
    })
  }

  const authHeaders = (services: string[]) => ({
    host: 'memory.example',
    authorization: `Bearer ${signCapabilityGrant(keys, {
      issuer: 'https://relay.test',
      providerId: 'pocketctl-memory',
      installationId: INSTALLATION,
      userId: 42,
      callerType: 'agent',
      services,
      configVersion: '1',
    })}`,
  })

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    keys = resolveGrantKeyMaterial({
      EXTENSION_GRANT_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      EXTENSION_GRANT_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      EXTENSION_GRANT_KEY_ID: 'test-kid',
    })
    jwksApp = Fastify()
    jwksApp.get('/.well-known/pocketctl-extension-jwks.json', async () => publicJwks(keys))
    await jwksApp.listen({ port: 0, host: '127.0.0.1' })
    const port = (jwksApp.server.address() as { port: number }).port

    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1)
      ON CONFLICT DO NOTHING
    `, [INSTALLATION])
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id) VALUES ($1)
      ON CONFLICT DO NOTHING
    `, [INSTALLATION])

    app = Fastify()
    registerMcpRoute(app, {
      pool,
      guard: createGrantGuard({
        pool, relayUrl: `http://127.0.0.1:${port}`, relayIssuer: 'https://relay.test',
      }),
      policy: createCorsHostPolicy({
        allowedOrigins: [], allowedHosts: ['memory.example'], isProduction: false,
      }),
      providerVersion: '0.1.0',
      recallEmbeddingTimeoutMs: 100,
      cursorSigningKey: 'test-cursor-signing-key',
    })
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await jwksApp?.close()
    await pool?.end()
  })

  const post = async (payload: unknown, headersOverride: Record<string, string> = {}) => {
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(['memory.mcp']),
        ...headersOverride,
      },
      payload: payload as never,
    })
    return response
  }

  // The stateless endpoint answers either plain JSON (modern era) or a
  // single SSE-framed message (legacy 2025 clients) — parse both.
  function parseRpc(response: { body: string }): Record<string, unknown> {
    const text = response.body
    if (text.startsWith('event:') || text.startsWith('data:')) {
      const dataLine = text.split('\n').find(line => line.startsWith('data:'))
      return JSON.parse(dataLine!.slice(5).trim())
    }
    return JSON.parse(text)
  }

  test('initialize completes against the official SDK handler', async () => {
    const response = await post(rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    }))
    expect(response.statusCode).toBe(200)
    const body = parseRpc(response)
    expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('pocketctl-memory')
    expect((body.result as { protocolVersion: string }).protocolVersion).toBeTruthy()
  })

  test('tools/list exposes exactly the six read-only tools', async () => {
    const response = await post(rpc('tools/list', {}))
    expect(response.statusCode).toBe(200)
    const parsed = parseRpc(response)
    const names = ((parsed.result as { tools: Array<{ name: string }> }).tools).map(tool => tool.name).sort()
    expect(names).toEqual([
      'memory_find_related_episodes',
      'memory_get_claim',
      'memory_get_evidence',
      'memory_get_repository_context',
      'memory_recall',
      'memory_search',
    ])
  })

  test('memory_search returns results as JSON text content', async () => {
    const response = await post(rpc('tools/call', {
      name: 'memory_search',
      arguments: { query: 'anything at all' },
    }))
    expect(response.statusCode).toBe(200)
    const body = parseRpc(response) as { result: { content: Array<{ type: string; text: string }> } }
    expect(body.result.content[0].type).toBe('text')
    const parsed = JSON.parse(body.result.content[0].text)
    expect(parsed).toHaveProperty('hits')
    expect(parsed).toHaveProperty('degradedComponents')
  })

  test('memory_get_claim paginates immutable version history with claim-bound signed cursors', async () => {
    await pool.query(`
      DELETE FROM knowledge_claims WHERE installation_id = $1 AND normalized_key = 'mcp-history-key'
    `, [INSTALLATION])
    const claim = await pool.query<{ claim_id: string }>(`
      INSERT INTO knowledge_claims
        (claim_id, installation_id, claim_type, scope_kind, scope_key, normalized_key, state)
      VALUES (gen_random_uuid(), $1, 'work_method', 'installation', 'mcp-history',
              'mcp-history-key', 'active')
      RETURNING claim_id::text
    `, [INSTALLATION])
    const versions = await pool.query<{ version_id: string; version_number: number }>(`
      INSERT INTO knowledge_versions
        (version_id, installation_id, claim_id, version_number, statement, authority, confidence)
      SELECT gen_random_uuid(), $1, $2, n, 'Version ' || n,
             CASE WHEN n = 25 THEN 'user_corrected' ELSE 'user_accepted' END, 1
      FROM generate_series(1, 25) AS n
      RETURNING version_id::text, version_number
    `, [INSTALLATION, claim.rows[0].claim_id])
    const current = versions.rows.find(row => row.version_number === 25)!
    await pool.query(`UPDATE knowledge_claims SET current_version_id = $2 WHERE claim_id = $1`,
      [claim.rows[0].claim_id, current.version_id])

    const response = await post(rpc('tools/call', {
      name: 'memory_get_claim', arguments: { claim_id: claim.rows[0].claim_id },
    }))
    const body = parseRpc(response) as { result: { content: Array<{ text: string }> } }
    const detail = JSON.parse(body.result.content[0].text)
    expect(detail.versions.map((version: { version_number: string }) => version.version_number))
      .toEqual(Array.from({ length: 20 }, (_, index) => String(index + 6)))
    expect(detail.next_version_cursor).toEqual(expect.any(String))

    const olderResponse = await post(rpc('tools/call', {
      name: 'memory_get_claim', arguments: {
        claim_id: claim.rows[0].claim_id,
        version_cursor: detail.next_version_cursor,
      },
    }))
    const olderBody = parseRpc(olderResponse) as { result: { content: Array<{ text: string }> } }
    const older = JSON.parse(olderBody.result.content[0].text)
    expect(older.versions.map((version: { version_number: string }) => version.version_number))
      .toEqual(['1', '2', '3', '4', '5'])
    expect(older.next_version_cursor).toBeNull()

    const tampered = await post(rpc('tools/call', {
      name: 'memory_get_claim', arguments: {
        claim_id: claim.rows[0].claim_id,
        version_cursor: `${detail.next_version_cursor}x`,
      },
    }))
    const tamperedBody = parseRpc(tampered) as { result?: { isError?: boolean }; error?: unknown }
    expect(tamperedBody.error ?? tamperedBody.result?.isError).toBeTruthy()
  })

  test('mutation tools do not exist on this endpoint', async () => {
    const response = await post(rpc('tools/call', {
      name: 'memory_delete_claim',
      arguments: { claim_id: '11111111-1111-4111-8111-111111111111' },
    }))
    expect(response.statusCode).toBe(200)
    const body = parseRpc(response) as { error?: unknown; result?: { isError?: boolean } }
    expect(body.error ?? body.result?.isError).toBeTruthy()
  })

  test('wrong-service grants never reach the SDK', async () => {
    const response = await post(rpc('tools/list', {}), authHeaders(['memory.search']))
    expect(response.statusCode).toBe(401)
  })

  test('missing grants answer the uniform envelope', async () => {
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { host: 'memory.example', 'content-type': 'application/json' },
      payload: rpc('tools/list', {}),
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('unauthorized')
  })

  test('missing grants win before content-type and JSON body parsing', async () => {
    const text = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { host: 'memory.example', 'content-type': 'text/plain' },
      payload: 'not json',
    })
    const malformedJson = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { host: 'memory.example', 'content-type': 'application/json' },
      payload: '{',
    })
    for (const response of [text, malformedJson]) {
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('unauthorized')
    }
  })

  test('non-JSON content types and bad hosts are rejected before dispatch', async () => {
    const contentType = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { ...authHeaders(['memory.mcp']), 'content-type': 'text/plain', host: 'memory.example' },
      payload: 'not json',
    })
    expect(contentType.statusCode).toBe(415)
    const badHost = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { ...authHeaders(['memory.mcp']), 'content-type': 'application/json', host: 'evil.example' },
      payload: rpc('tools/list', {}),
    })
    expect(badHost.statusCode).toBe(403)
  })

  test('the stream (GET) leg does not exist in stateless JSON mode', async () => {
    const response = await app.inject({
      method: 'GET', url: '/mcp',
      headers: authHeaders(['memory.mcp']),
    })
    expect(response.statusCode).toBe(405)
  })

  test('expired grants are refused', async () => {
    const expired = signExpiredGrant()
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: {
        host: 'memory.example', 'content-type': 'application/json',
        authorization: `Bearer ${expired}`,
      },
      payload: rpc('tools/list', {}),
    })
    expect(response.statusCode).toBe(401)
  })

  test('MCP requests share the bounded installation rate limit', async () => {
    const limitedApp = Fastify()
    const port = (jwksApp.server.address() as { port: number }).port
    registerMcpRoute(limitedApp, {
      pool,
      guard: createGrantGuard({
        pool, relayUrl: `http://127.0.0.1:${port}`, relayIssuer: 'https://relay.test',
      }),
      policy: createCorsHostPolicy({
        allowedOrigins: [], allowedHosts: ['memory.example'], isProduction: false,
      }),
      rateLimiter: { check: () => ({ allowed: false }) },
      providerVersion: '0.1.0',
      recallEmbeddingTimeoutMs: 100,
      cursorSigningKey: 'test-cursor-signing-key',
    })
    try {
      const response = await limitedApp.inject({
        method: 'POST', url: '/mcp',
        headers: { 'content-type': 'application/json', ...authHeaders(['memory.mcp']) },
        payload: rpc('tools/list', {}),
      })
      expect(response.statusCode).toBe(429)
      expect(response.json().error.code).toBe('rate_limited')
    } finally {
      await limitedApp.close()
    }
  })
})
