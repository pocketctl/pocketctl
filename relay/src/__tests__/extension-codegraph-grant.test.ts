import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, test, vi } from 'vitest'

import {
  createMemoryCodegraphGrantBroker,
  handleMemoryCodegraphGrantMessage,
} from '../extensions/grant-service.js'
import {
  resolveGrantKeyMaterial,
  verifyCapabilityGrant,
  verifyCapabilityGrantV2,
} from '../extensions/capability-grant.js'

const ISSUER = 'https://relay.example.test'
const PROVIDER = 'pocketctl-memory'
const PERSONAL_INSTALL = '11111111-1111-4111-8111-111111111111'
const TEAM_INSTALL = '22222222-2222-4222-8222-222222222222'
const TEAM_SCOPE = '44444444-4444-4444-8444-444444444444'
const CODEGRAPH_SERVICE = 'memory.codegraph.write'

const MATERIAL = (() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return resolveGrantKeyMaterial({
    EXTENSION_GRANT_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    EXTENSION_GRANT_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    EXTENSION_GRANT_KEY_ID: 'test-kid',
  })
})()

interface QueryScript {
  match: RegExp
  rows: Record<string, unknown>[]
}

function poolWith(queries: QueryScript[]) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ')
      for (const script of queries) {
        if (script.match.test(normalized)) return { rows: script.rows, rowCount: script.rows.length }
      }
      return { rows: [], rowCount: 0 }
    }),
  } as unknown as import('pg').Pool
}

const PERSONAL_ROW = {
  installation_id: PERSONAL_INSTALL,
  provider_id: PROVIDER,
  owner_user_id: 42,
  status: 'active',
  enabled_services: ['memory.search', CODEGRAPH_SERVICE],
  config_version: '3',
  owner_scope_kind: 'personal',
  owner_scope_id: PERSONAL_INSTALL,
  authorization_epoch: '1',
  membership_id: null,
  membership_revision: null,
  membership_state: null,
  roles: null,
}

const TEAM_ROW_BASE = {
  installation_id: TEAM_INSTALL,
  provider_id: PROVIDER,
  owner_user_id: null,
  status: 'active',
  enabled_services: [CODEGRAPH_SERVICE],
  config_version: '5',
  owner_scope_kind: 'team',
  owner_scope_id: TEAM_SCOPE,
  authorization_epoch: '4',
  membership_id: '55555555-5555-4555-8555-555555555555',
  membership_revision: '2',
  membership_state: 'active',
  roles: ['contributor'],
}

function teamRow(overrides: Record<string, unknown> = {}) {
  return { ...TEAM_ROW_BASE, ...overrides }
}

function brokerFor(options: {
  queries?: QueryScript[]
  mode?: 'enabled' | 'off'
  v2Mode?: 'off' | 'shadow' | 'enabled'
} = {}) {
  return createMemoryCodegraphGrantBroker({
    pool: poolWith(options.queries ?? []),
    issuer: ISSUER,
    mode: options.mode ?? 'enabled',
    v2Mode: options.v2Mode ?? 'enabled',
    providerPublicOrigins: new Map([[PROVIDER, 'https://memory.example.test']]),
    grantKeys: MATERIAL,
  })
}

describe('memory.codegraph.write grant broker (Phase 4 Task 2)', () => {
  test('personal success: authenticated owner gets a verifiable bounded v1 grant', async () => {
    const broker = brokerFor({
      queries: [
        { match: /FROM extension_installations/, rows: [PERSONAL_ROW] },
        {
          match: /installation_id = \$1 AND owner_user_id = \$2|installation_id=\$1 AND owner_user_id=\$2/,
          rows: [{
            provider_id: PROVIDER,
            owner_user_id: 42,
            status: 'active',
            enabled_services: [CODEGRAPH_SERVICE],
            config_version: 1,
          }],
        },
      ],
    })
    const result = await broker.requestGrant({ userId: 42 })
    expect(result.type).toBe('memory_codegraph_grant_result')
    if (result.type !== 'memory_codegraph_grant_result') return
    expect(result.token_type).toBe('extension_capability')
    expect(result.services).toEqual([CODEGRAPH_SERVICE])
    expect(result.installation_id).toBe(PERSONAL_INSTALL)
    expect(result.expires_in).toBeLessThanOrEqual(60)
    const verified = verifyCapabilityGrant(MATERIAL.publicKeyPem, result.grant, ISSUER)
    expect(verified).toMatchObject({
      userId: 42,
      providerId: PROVIDER,
      installationId: PERSONAL_INSTALL,
      services: [CODEGRAPH_SERVICE],
    })
    const decoded = jwt.decode(result.grant) as { iat: number; exp: number }
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(60)
  })

  test('personal failure: missing service and non-personal scope fail closed', async () => {
    const noService = brokerFor({
      queries: [
        { match: /FROM extension_installations/, rows: [{ ...PERSONAL_ROW, enabled_services: ['memory.search'] }] },
      ],
    })
    expect(await noService.requestGrant({ userId: 42 }))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'service_disabled' })

    // A shared-scope installation never becomes the implicit personal target.
    const sharedOnly = brokerFor({
      queries: [{ match: /FROM extension_installations/, rows: [teamRow()] }],
    })
    expect(await sharedOnly.requestGrant({ userId: 42 }))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'no_installation' })

    const revoked = brokerFor({
      queries: [{ match: /FROM extension_installations/, rows: [{ ...PERSONAL_ROW, status: 'revoked' }] }],
    })
    expect(await revoked.requestGrant({ userId: 42 }))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'installation_not_active' })

    expect(await brokerFor().requestGrant({ userId: null }))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'unauthenticated' })
  })

  test('explicit shared target: v2 grant carries contribute and exactly one binding', async () => {
    const broker = brokerFor({
      queries: [
        { match: /FROM extension_installations i/, rows: [teamRow()] },
        {
          match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
          rows: [{ scope_kind: 'team', scope_id: TEAM_SCOPE, state: 'active', authorization_epoch: '4' }],
        },
        { match: /INSERT INTO audit_log/, rows: [] },
      ],
    })
    const result = await broker.requestGrant({ userId: 42 }, [TEAM_INSTALL])
    expect(result.type).toBe('memory_codegraph_grant_result')
    if (result.type !== 'memory_codegraph_grant_result') return
    expect(result.token_type).toBe('extension_capability_v2')
    expect(result.services).toEqual([CODEGRAPH_SERVICE])
    expect(result.installation_id).toBe(TEAM_INSTALL)
    expect(result.expires_in).toBeLessThanOrEqual(60)
    const verified = verifyCapabilityGrantV2(MATERIAL.publicKeyPem, result.grant, ISSUER)
    expect(verified).not.toBeNull()
    if (!verified) return
    expect(verified.services).toEqual([CODEGRAPH_SERVICE])
    expect(verified.scopeBindings).toHaveLength(1)
    expect(verified.scopeBindings[0]).toMatchObject({
      installation_id: TEAM_INSTALL,
      owner_scope_kind: 'team',
      authorization_epoch: '4',
    })
    expect(verified.scopeBindings[0].permissions).toContain('contribute')
    expect(verified.scopeBindings[0].permissions).not.toContain('publish')
  })

  test('non-contributor and revoked/stale shared bindings fail bounded', async () => {
    const nonContributor = brokerFor({
      queries: [
        { match: /FROM extension_installations i/, rows: [teamRow({ roles: ['reader'] })] },
        {
          match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
          rows: [{ scope_kind: 'team', scope_id: TEAM_SCOPE, state: 'active', authorization_epoch: '4' }],
        },
        { match: /INSERT INTO audit_log/, rows: [] },
      ],
    })
    expect(await nonContributor.requestGrant({ userId: 42 }, [TEAM_INSTALL]))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'not_contributor' })

    // LEFT JOIN misses: membership missing/inactive reads as a uniform 404.
    const revoked = brokerFor({
      queries: [
        { match: /FROM extension_installations i/, rows: [teamRow({ membership_state: null, membership_id: null })] },
      ],
    })
    expect(await revoked.requestGrant({ userId: 42 }, [TEAM_INSTALL]))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'no_installation' })

    // A dissolving scope never mints.
    const dissolving = brokerFor({
      queries: [
        { match: /FROM extension_installations i/, rows: [teamRow()] },
        {
          match: /FROM extension_teams|FROM extension_organizations|UNION ALL/,
          rows: [{ scope_kind: 'team', scope_id: TEAM_SCOPE, state: 'dissolving', authorization_epoch: '5' }],
        },
      ],
    })
    expect(await dissolving.requestGrant({ userId: 42 }, [TEAM_INSTALL]))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'no_installation' })
  })

  test('scope selection must be exactly one id; duplicates and overlong lists are invalid', async () => {
    const broker = brokerFor()
    expect(await broker.requestGrant({ userId: 42 }, []))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'invalid_request' })
    expect(await broker.requestGrant({ userId: 42 }, [TEAM_INSTALL, TEAM_INSTALL]))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'invalid_request' })
    expect(await broker.requestGrant({ userId: 42 }, [TEAM_INSTALL, PERSONAL_INSTALL]))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'invalid_request' })
    expect(await broker.requestGrant(
      { userId: 42 },
      Array.from({ length: 17 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    )).toMatchObject({ type: 'memory_codegraph_grant_error', code: 'invalid_request' })
  })

  test('v2 mode off refuses shared targets without leaking membership detail', async () => {
    const broker = brokerFor({ v2Mode: 'off', queries: [
      { match: /FROM extension_installations i/, rows: [teamRow()] },
    ] })
    expect(await broker.requestGrant({ userId: 42 }, [TEAM_INSTALL]))
      .toMatchObject({ type: 'memory_codegraph_grant_error', code: 'feature_disabled' })
  })

  test('malformed and identity-bearing messages are rejected before any mint', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [PERSONAL_ROW], rowCount: 1 })),
    } as unknown as import('pg').Pool
    const broker = createMemoryCodegraphGrantBroker({
      pool,
      issuer: ISSUER,
      mode: 'enabled',
      v2Mode: 'enabled',
      providerPublicOrigins: new Map([[PROVIDER, 'https://memory.example.test']]),
      grantKeys: MATERIAL,
    })
    const sent: string[] = []
    const send = (payload: string) => { sent.push(payload) }

    // Unknown/identity/repository fields in the request are rejected: the
    // request may never carry trusted identity, path, or commit facts.
    await handleMemoryCodegraphGrantMessage(broker, { userId: 42 }, {
      type: 'memory_codegraph_grant',
      repository_path: '/Users/leaky/repo',
      commit_sha: 'deadbeef',
      user_id: 7,
      roles: ['publisher'],
    }, send)
    await handleMemoryCodegraphGrantMessage(broker, { userId: 42 }, null, send)
    await handleMemoryCodegraphGrantMessage(broker, { userId: 42 }, 'not-an-object', send)
    await handleMemoryCodegraphGrantMessage(broker, { userId: 42 }, {
      type: 'memory_codegraph_grant',
      scope_installation_ids: 'not-an-array',
    }, send)

    for (const payload of sent) {
      const message = JSON.parse(payload)
      expect(message.type).toBe('memory_codegraph_grant_error')
      expect(message.code).toBe('invalid_request')
    }
    // No mint query ran for any rejected message.
    expect(sent).toHaveLength(4)
    expect(pool.query).not.toHaveBeenCalled()
  })

  test('a well-formed message answers on the socket with the correlation id', async () => {
    const broker = brokerFor({
      queries: [
        { match: /FROM extension_installations/, rows: [PERSONAL_ROW] },
        {
          match: /installation_id = \$1 AND owner_user_id = \$2|installation_id=\$1 AND owner_user_id=\$2/,
          rows: [{
            provider_id: PROVIDER,
            owner_user_id: 42,
            status: 'active',
            enabled_services: [CODEGRAPH_SERVICE],
            config_version: 1,
          }],
        },
      ],
    })
    const sent: string[] = []
    await handleMemoryCodegraphGrantMessage(broker, { userId: 42 }, {
      type: 'memory_codegraph_grant',
      request_id: 'corr-1',
    }, (payload) => { sent.push(payload) })
    expect(sent).toHaveLength(1)
    const message = JSON.parse(sent[0]!)
    expect(message.type).toBe('memory_codegraph_grant_result')
    expect(message.request_id).toBe('corr-1')
    expect(message.services).toEqual([CODEGRAPH_SERVICE])
  })
})
