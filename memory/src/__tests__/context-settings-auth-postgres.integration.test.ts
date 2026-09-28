import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createGrantGuard } from '../auth/grant-guard.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { registerContextRoutes, type ContextRouteDeps } from '../api/context-routes.js'
import { createContextSettingsRepository } from '../context/settings-repository.js'
import { createPackRepository } from '../context/pack-repository.js'
import { createLoadoutRepository } from '../context/loadout-repository.js'
import { createAdmissionService } from '../context/admission-service.js'
import { createFeedbackService } from '../context/feedback-service.js'
import type { GrantScopeBinding } from '../governance/authorization.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const PERSONAL = 'eeeeeee1-0000-4000-8000-000000000001'
const TEAM = 'eeeeeee1-0000-4000-8000-000000000002'
const OTHER = 'eeeeeee1-0000-4000-8000-000000000003'
const MEMBER = 'eeeeeee1-0000-4000-8000-000000000004'
const OTHER_MEMBER = 'eeeeeee1-0000-4000-8000-000000000005'
const payload = { scope_kind: 'installation', scope_key: 'global', mode: 'enabled', max_tokens: 500, expected_revision: 1 }

// The real signer/verifier and local membership mirror are exercised together;
// only the external Relay JWKS HTTP boundary is supplied locally.
db('context settings management under real capability grants (PostgreSQL)', () => {
  let pool: pg.Pool
  let app: ReturnType<typeof Fastify>
  let privateKeyPem: string
  let jwks: object
  const binding = (installationId: string, permissions: string[]): GrantScopeBinding => ({
    installation_id: installationId, owner_scope_kind: 'team', owner_scope_id: installationId,
    membership_id: installationId === TEAM ? MEMBER : OTHER_MEMBER,
    membership_revision: '1', authorization_epoch: '1', permissions,
  })
  const sign = (body: object) => jwt.sign(body, privateKeyPem, {
    algorithm: 'RS256', keyid: 'settings-test', issuer: 'https://relay.test',
    audience: 'pocketctl-memory', subject: 'user:42', expiresIn: 60,
  })
  const v2 = (options: { permissions?: string[]; callerType?: string; services?: string[]; bindings?: GrantScopeBinding[]; configVersion?: string } = {}) => sign({
    token_type: 'extension_capability_v2', primary_installation_id: TEAM, config_version: options.configVersion ?? '1',
    caller_type: options.callerType ?? 'web', services: options.services ?? ['memory.manage'],
    scope_bindings: options.bindings ?? [binding(TEAM, options.permissions ?? ['read', 'policy_admin'])],
  })
  const v1 = (options: { installationId?: string; callerType?: string; services?: string[] } = {}) => sign({
    token_type: 'extension_capability', provider_id: 'pocketctl-memory',
    installation_id: options.installationId ?? PERSONAL, config_version: '1',
    caller_type: options.callerType ?? 'web', services: options.services ?? ['memory.manage'],
  })
  const headers = (token: string) => ({ host: 'memory.test', authorization: `Bearer ${token}`, 'idempotency-key': 'settings-auth-1' })
  const stored = async () => (await pool.query('SELECT installation_id, mode, revision::text FROM memory_context_settings ORDER BY installation_id')).rows
  async function denied(token: string, status: number) {
    const before = await stored()
    for (const method of ['GET', 'PUT'] as const) {
      const result = await app.inject({ method, url: '/api/v1/memory/context/settings', headers: headers(token), ...(method === 'PUT' ? { payload } : {}) })
      expect(result.statusCode, `${method}: ${result.body}`).toBe(status)
    }
    expect(await stored()).toEqual(before)
    expect((await pool.query('SELECT count(*)::int n FROM memory_idempotency_keys')).rows[0].n).toBe(0)
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    await assertMemoryTestDatabase(pool, url!)
    await applyMemorySchema(pool)
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'settings-test', alg: 'RS256', use: 'sig' }] }
  }, 60_000)
  afterAll(async () => { await app?.close(); await pool?.end() })
  beforeEach(async () => {
    await app?.close()
    await pool.query('TRUNCATE memory_installations CASCADE')
    for (const installationId of [PERSONAL, TEAM, OTHER]) {
      await pool.query(`INSERT INTO memory_installations(installation_id, provider_id, relay_status, local_status, config_version)
        VALUES($1, 'pocketctl-memory', 'active', 'ready', 1)`, [installationId])
      await pool.query(`INSERT INTO memory_owner_scopes(installation_id, owner_scope_kind, owner_scope_id)
        VALUES($1, $2, $1)`, [installationId, installationId === PERSONAL ? 'personal' : 'team'])
      await pool.query(`INSERT INTO memory_context_settings(setting_id, installation_id, scope_kind, scope_key, mode)
        VALUES(gen_random_uuid(), $1, 'installation', 'global', 'off')`, [installationId])
    }
    for (const [installationId, membershipId] of [[TEAM, MEMBER], [OTHER, OTHER_MEMBER]]) {
      await pool.query(`INSERT INTO memory_scope_memberships(installation_id, membership_id, roles, state, membership_revision)
        VALUES($1, $2, ARRAY['scope_administrator'], 'active', 1)`, [installationId, membershipId])
    }
    app = Fastify()
    registerContextRoutes(app, {
      pool, guard: createGrantGuard({ pool, relayUrl: 'https://relay.test', relayIssuer: 'https://relay.test',
        fetchImpl: async () => new Response(JSON.stringify(jwks), { status: 200 }) }),
      policy: createCorsHostPolicy({ allowedOrigins: [], allowedHosts: ['memory.test'], isProduction: false }),
      compiler: {} as ContextRouteDeps['compiler'],
      admission: createAdmissionService({ pool, nonceHmacKey: Buffer.alloc(32, 4) }),
      feedback: createFeedbackService({ pool }), packs: createPackRepository(pool),
      settings: createContextSettingsRepository(pool), loadouts: createLoadoutRepository(pool),
      requestKey: { keyId: 'settings-test', hmacKey: Buffer.alloc(32, 4) },
    })
  })

  test.each(['policy_admin', 'scope_admin'])('v2 %s manages only its primary installation and preserves replay/CAS', async permission => {
    const token = v2({ bindings: [binding(TEAM, ['read', permission]), binding(OTHER, ['read', 'scope_admin'])] })
    const read = await app.inject({ method: 'GET', url: '/api/v1/memory/context/settings', headers: headers(token) })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().settings.map((row: { installationId: string }) => row.installationId)).toEqual([TEAM])
    const first = await app.inject({ method: 'PUT', url: '/api/v1/memory/context/settings', headers: headers(token), payload })
    const replay = await app.inject({ method: 'PUT', url: '/api/v1/memory/context/settings', headers: headers(token), payload })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual({ revision: 2 })
    expect(replay.json()).toEqual(first.json())
    const stale = await app.inject({ method: 'PUT', url: '/api/v1/memory/context/settings', headers: { ...headers(token), 'idempotency-key': 'settings-stale' }, payload })
    expect(stale.statusCode).toBe(409)
    expect(await stored()).toEqual([
      { installation_id: PERSONAL, mode: 'off', revision: '1' },
      { installation_id: TEAM, mode: 'enabled', revision: '2' },
      { installation_id: OTHER, mode: 'off', revision: '1' },
    ])
  })
  test('v1 web personal management remains compatible', async () => {
    const token = v1()
    const read = await app.inject({ method: 'GET', url: '/api/v1/memory/context/settings', headers: headers(token) })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().settings.map((row: { installationId: string }) => row.installationId)).toEqual([PERSONAL])
    const write = await app.inject({ method: 'PUT', url: '/api/v1/memory/context/settings', headers: headers(token), payload })
    expect(write.statusCode, write.body).toBe(200)
    expect((await stored()).find(row => row.installation_id === PERSONAL)).toEqual({ installation_id: PERSONAL, mode: 'enabled', revision: '2' })
  })
  test('v1 cannot bypass shared-scope member authorization', async () => { await denied(v1({ installationId: TEAM }), 403) })
  test('v2 reader cannot configure a scope even with the manage service', async () => {
    await pool.query("UPDATE memory_scope_memberships SET roles=ARRAY['reader'] WHERE membership_id=$1", [MEMBER])
    await denied(v2({ permissions: ['read'] }), 403)
  })
  test('secondary scope administration cannot authorize a reader primary', async () => {
    await denied(v2({ bindings: [binding(TEAM, ['read']), binding(OTHER, ['read', 'scope_admin'])] }), 403)
  })
  test.each(['daemon', 'agent'])('v2 %s cannot manage settings even with administrator permissions', async callerType => { await denied(v2({ callerType }), 403) })
  test.each(['daemon', 'agent'])('v1 %s cannot manage personal settings', async callerType => { await denied(v1({ callerType }), 403) })
  test.each(['v1', 'v2'])('%s must carry memory.manage', async version => { await denied(version === 'v1' ? v1({ services: ['memory.context'] }) : v2({ services: ['memory.context'] }), 401) })
  test('a stale primary membership is rejected before settings work', async () => {
    const token = v2()
    await pool.query('UPDATE memory_scope_memberships SET membership_revision=2 WHERE membership_id=$1', [MEMBER])
    await denied(token, 401)
  })
  test('a revoked primary membership is rejected before settings work', async () => {
    const token = v2()
    await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1", [MEMBER])
    await denied(token, 401)
  })
  test('a stale primary config version is rejected', async () => { await denied(v2({ configVersion: '2' }), 401) })
  test('a tampered grant is rejected without persisting settings or idempotency', async () => { await denied(v2().slice(0, -4) + 'xxxx', 401) })
})
