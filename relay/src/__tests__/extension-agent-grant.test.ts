import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, test, vi } from 'vitest'
import {
  createMemoryContextGrantBroker,
  createMemoryMcpGrantBroker,
  handleMemoryMcpGrantMessage,
} from '../extensions/grant-service.js'
import { verifyCapabilityGrant, resolveGrantKeyMaterial } from '../extensions/capability-grant.js'

const ISSUER = 'https://relay.example.test'

function keys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return resolveGrantKeyMaterial({
    EXTENSION_GRANT_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    EXTENSION_GRANT_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    EXTENSION_GRANT_KEY_ID: 'test-kid',
  })
}

function poolWith(installations: Array<{
  installation_id: string
  owner_user_id: number
  status: string
  enabled_services: string[]
}>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/installation_id = .1 AND owner_user_id = .2/.test(sql)) {
        const [installationId, userId] = params as [string, number]
        const match = installations.find(row =>
          row.installation_id === installationId && row.owner_user_id === userId)
        return {
          rows: match ? [{
            provider_id: 'pocketctl-memory',
            owner_user_id: match.owner_user_id,
            status: match.status,
            enabled_services: match.enabled_services,
            config_version: 1,
          }] : [],
        }
      }
      if (/FROM extension_installations/.test(sql)) {
        return { rows: installations.filter(row => row.owner_user_id === (params as number[])[0]) }
      }
      return { rows: [] }
    }),
  }
}

const grantKeysMaterial = keys()

function brokerFor(installations: Parameters<typeof poolWith>[0], mode: 'enabled' | 'off' = 'enabled') {
  return createMemoryMcpGrantBroker({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool: poolWith(installations) as any,
    issuer: ISSUER,
    mode,
    providerPublicOrigins: new Map([['pocketctl-memory', 'https://memory.example']]),
    grantKeys: grantKeysMaterial,
  })
}

const BASE = {
  installation_id: '11111111-1111-4111-8111-111111111111',
  owner_user_id: 42,
  status: 'active',
  enabled_services: ['memory.search', 'memory.mcp'],
}

describe('agent MCP grant broker', () => {
  test('an authenticated daemon owner receives a verifiable memory.mcp grant with the provider origin', async () => {
    const broker = brokerFor([BASE])
    const result = await broker.requestGrant({ userId: 42 })
    expect(result.type).toBe('memory_mcp_grant_result')
    if (result.type !== 'memory_mcp_grant_result') return
    expect(result.installation_id).toBe(BASE.installation_id)
    expect(result.provider_public_origin).toBe('https://memory.example')
    const verified = verifyCapabilityGrant(verifiedKeys().publicKeyPem, result.grant, ISSUER)
    expect(verified).toMatchObject({
      userId: 42,
      providerId: 'pocketctl-memory',
      installationId: BASE.installation_id,
      services: ['memory.mcp'],
    })
  })

  test('unauthenticated daemons are refused without touching the database', async () => {
    const broker = brokerFor([BASE])
    const result = await broker.requestGrant({ userId: null })
    expect(result).toEqual({ type: 'memory_mcp_grant_error', code: 'unauthenticated' })
  })

  test('no installation, disabled service and inactive installations are distinct bounded errors', async () => {
    expect(await brokerFor([]).requestGrant({ userId: 42 }))
      .toEqual({ type: 'memory_mcp_grant_error', code: 'no_installation' })
    expect(await brokerFor([{ ...BASE, enabled_services: ['memory.search'] }]).requestGrant({ userId: 42 }))
      .toEqual({ type: 'memory_mcp_grant_error', code: 'service_disabled' })
    expect(await brokerFor([{ ...BASE, status: 'paused' }]).requestGrant({ userId: 42 }))
      .toEqual({ type: 'memory_mcp_grant_error', code: 'installation_not_active' })
    expect(await brokerFor([{ ...BASE, status: 'revoked' }]).requestGrant({ userId: 42 }))
      .toEqual({ type: 'memory_mcp_grant_error', code: 'installation_not_active' })
  })

  test('feature-disabled mode never mints', async () => {
    const result = await brokerFor([BASE], 'off').requestGrant({ userId: 42 })
    expect(result).toEqual({ type: 'memory_mcp_grant_error', code: 'feature_disabled' })
  })

  test('the WS message handler correlates request ids and never throws', async () => {
    const broker = brokerFor([BASE])
    const sent: string[] = []
    await handleMemoryMcpGrantMessage(broker, { userId: 42 }, { type: 'memory_mcp_grant', request_id: 'corr-1' }, payload => sent.push(payload))
    await handleMemoryMcpGrantMessage(broker, { userId: null }, { type: 'memory_mcp_grant', request_id: 'corr-2' }, payload => sent.push(payload))
    const first = JSON.parse(sent[0])
    const second = JSON.parse(sent[1])
    expect(first.type).toBe('memory_mcp_grant_result')
    expect(first.request_id).toBe('corr-1')
    expect(second).toEqual({ type: 'memory_mcp_grant_error', request_id: 'corr-2', code: 'unauthenticated' })
  })

  test('internal database failures surface only the bounded internal_error code', async () => {
    const failing = createMemoryMcpGrantBroker({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: { query: vi.fn(async () => { throw new Error('boom with secret data') }) } as any,
      issuer: ISSUER,
      mode: 'enabled',
      providerPublicOrigins: new Map(),
      grantKeys: keys(),
    })
    const sent: string[] = []
    await handleMemoryMcpGrantMessage(failing, { userId: 42 }, { type: 'memory_mcp_grant', request_id: 'x' }, payload => sent.push(payload))
    expect(JSON.parse(sent[0])).toEqual({ type: 'memory_mcp_grant_error', request_id: 'x', code: 'internal_error' })
    expect(sent[0]).not.toContain('boom')
  })
})

function verifiedKeys() {
  return grantKeysMaterial
}

describe('session-bound context grant broker (Phase 2)', () => {
  function contextPoolWith(input: {
    installations: Array<{ installation_id: string; owner_user_id: number; status: string; enabled_services: string[] }>
    ownedSessions: Array<{ session_id: string; user_id: number }>
  }) {
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/installation_id = .1 AND owner_user_id = .2/.test(sql)) {
          const [installationId, userId] = params as [string, number]
          const match = input.installations.find(row =>
            row.installation_id === installationId && row.owner_user_id === userId)
          return {
            rows: match ? [{
              provider_id: 'pocketctl-memory',
              owner_user_id: match.owner_user_id,
              status: match.status,
              enabled_services: match.enabled_services,
              config_version: 1,
            }] : [],
          }
        }
        if (/FROM extension_installations i/.test(sql)) {
          const [userId, sessionId] = params as [number, string]
          const owned = input.ownedSessions.some(row =>
            row.user_id === userId && row.session_id === sessionId)
          return {
            rows: input.installations
              .filter(row => row.owner_user_id === userId)
              .map(row => ({
                installation_id: row.installation_id,
                status: row.status,
                enabled_services: row.enabled_services,
                session_owned: owned,
              })),
          }
        }
        if (/SELECT status, enabled_services FROM extension_installations/.test(sql)) {
          const [installationId] = params as [string, number]
          const match = input.installations.find(row => row.installation_id === installationId)
          return { rows: match ? [{ status: match.status, enabled_services: match.enabled_services }] : [] }
        }
        if (/FROM sessions s/.test(sql)) {
          const [installationId, sessionId] = params as [string, string]
          const installation = input.installations.find(row => row.installation_id === installationId)
          const owned = installation && input.ownedSessions.some(row =>
            row.user_id === installation.owner_user_id && row.session_id === sessionId)
          return { rows: owned ? [{ '?column?': 1 }] : [], rowCount: owned ? 1 : 0 }
        }
        return { rows: [] }
      }),
    }
  }

  function contextBroker(input: Parameters<typeof contextPoolWith>[0]) {
    return createMemoryContextGrantBroker({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: contextPoolWith(input) as any,
      issuer: ISSUER,
      mode: 'enabled',
      providerPublicOrigins: new Map([['pocketctl-memory', 'https://memory.example']]),
      grantKeys: grantKeysMaterial,
    })
  }

  const INSTALL = {
    installation_id: '21111111-1111-4111-8111-111111111112',
    owner_user_id: 42,
    status: 'active',
    enabled_services: ['memory.search', 'memory.context'],
  }

  test('a daemon owning the session gets a session-bound memory.context grant', async () => {
    const broker = contextBroker({
      installations: [INSTALL],
      ownedSessions: [{ session_id: 'ses-own', user_id: 42 }],
    })
    const result = await broker.requestGrant({ userId: 42 }, 'ses-own')
    expect(result.type).toBe('memory_context_grant_result')
    if (result.type !== 'memory_context_grant_result') return
    expect(result.services).toEqual(['memory.context'])
    expect(result.session_id).toBe('ses-own')
    expect(result.expires_in).toBeLessThanOrEqual(300)
    const verified = verifyCapabilityGrant(verifiedKeys().publicKeyPem, result.grant, ISSUER)
    expect(verified).toMatchObject({ userId: 42, callerType: 'daemon' })
  })

  test('caps both the response and minted JWT lifetime at 300 seconds', async () => {
    const broker = createMemoryContextGrantBroker({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: contextPoolWith({
        installations: [INSTALL],
        ownedSessions: [{ session_id: 'ses-own', user_id: 42 }],
      }) as any,
      issuer: ISSUER,
      mode: 'enabled',
      providerPublicOrigins: new Map([['pocketctl-memory', 'https://memory.example']]),
      grantKeys: grantKeysMaterial,
      ttlSeconds: 3600,
    })
    const result = await broker.requestGrant({ userId: 42 }, 'ses-own')
    expect(result.type).toBe('memory_context_grant_result')
    if (result.type !== 'memory_context_grant_result') return
    const payload = jwt.decode(result.grant) as jwt.JwtPayload
    expect(result.expires_in).toBe(300)
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300)
  })

  test('a session owned by someone else is rejected as not owned', async () => {
    const broker = contextBroker({
      installations: [INSTALL],
      ownedSessions: [],
    })
    const result = await broker.requestGrant({ userId: 42 }, 'ses-foreign')
    expect(result).toMatchObject({ type: 'memory_context_grant_error', code: 'session_not_owned' })
  })

  test('installations without the memory.context service stay disabled', async () => {
    const broker = contextBroker({
      installations: [{ ...INSTALL, enabled_services: ['memory.search', 'memory.mcp'] }],
      ownedSessions: [{ session_id: 'ses-own', user_id: 42 }],
    })
    const result = await broker.requestGrant({ userId: 42 }, 'ses-own')
    expect(result).toMatchObject({ type: 'memory_context_grant_error', code: 'service_disabled' })
  })

  test('an unauthenticated connection is rejected before any query', async () => {
    const broker = contextBroker({ installations: [INSTALL], ownedSessions: [] })
    const result = await broker.requestGrant({ userId: null }, 'ses-own')
    expect(result).toMatchObject({ type: 'memory_context_grant_error', code: 'unauthenticated' })
  })

  test('a revoked predecessor cannot mask the one active context installation', async () => {
    const revoked = {
      ...INSTALL,
      installation_id: '21111111-1111-4111-8111-111111111110',
      status: 'revoked',
    }
    const broker = contextBroker({
      installations: [revoked, INSTALL],
      ownedSessions: [{ session_id: 'ses-own', user_id: 42 }],
    })

    const result = await broker.requestGrant({ userId: 42 }, 'ses-own')

    expect(result).toMatchObject({
      type: 'memory_context_grant_result',
      installation_id: INSTALL.installation_id,
    })
  })

  test('session ownership and active context installation resolve in one query', async () => {
    const pool = contextPoolWith({
      installations: [INSTALL],
      ownedSessions: [{ session_id: 'ses-own', user_id: 42 }],
    })
    const broker = createMemoryContextGrantBroker({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      issuer: ISSUER,
      mode: 'enabled',
      providerPublicOrigins: new Map([['pocketctl-memory', 'https://memory.example']]),
      grantKeys: grantKeysMaterial,
    })

    const resolved = await broker.resolveForSession({ userId: 42, sessionId: 'ses-own' })

    expect(resolved).toEqual({ installationId: INSTALL.installation_id })
    expect(pool.query).toHaveBeenCalledTimes(1)
  })
})

describe('memory mcp grant explicit scope selection (v2)', () => {
  const INSTALLATION = '44444444-4444-4444-8444-444444444444'

  function v2PoolWith(rows: Record<string, unknown>[]) {
    return {
      query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    } as any
  }

  function selectionRows() {
    return [{
      installation_id: INSTALLATION,
      provider_id: 'pocketctl-memory',
      owner_user_id: 7,
      status: 'active',
      enabled_services: ['memory.mcp'],
      config_version: 2,
      owner_scope_kind: 'personal',
      owner_scope_id: INSTALLATION,
      authorization_epoch: '1',
      membership_id: null,
      membership_revision: null,
      roles: null,
      membership_state: null,
    }]
  }

  test('an explicit bounded selection mints an opaque v2 grant', async () => {
    const material = keys()
    const pool = v2PoolWith(selectionRows())
    const broker = createMemoryMcpGrantBroker({
      pool,
      issuer: ISSUER,
      mode: 'enabled',
      v2Mode: 'enabled',
      providerPublicOrigins: new Map([['pocketctl-memory', 'https://memory.example']]),
      grantKeys: material,
    })
    const result = await broker.requestGrant({ userId: 7 }, [INSTALLATION])
    expect(result.type).toBe('memory_mcp_grant_result')
    if (result.type !== 'memory_mcp_grant_result') return
    expect(result.token_type).toBe('extension_capability_v2')
    expect(result.expires_in).toBeLessThanOrEqual(60)
    expect(result.installation_id).toBe(INSTALLATION)
    // The JWT stays opaque to this side's logs: verify only via the public key.
    const verified = verifyCapabilityGrant(material.publicKeyPem, result.grant, ISSUER)
    expect(verified).toBeNull() // v1 verifier rejects v2 tokens
  })

  test('bounds, flag, and unknown selections fail closed', async () => {
    const material = keys()
    const pool = v2PoolWith(selectionRows())
    const off = createMemoryMcpGrantBroker({
      pool, issuer: ISSUER, mode: 'enabled', v2Mode: 'off',
      providerPublicOrigins: new Map(), grantKeys: material,
    })
    const disabled = await off.requestGrant({ userId: 7 }, [INSTALLATION])
    expect(disabled.type).toBe('memory_mcp_grant_error')
    if (disabled.type === 'memory_mcp_grant_error') expect(disabled.code).toBe('feature_disabled')

    const oversize = await createMemoryMcpGrantBroker({
      pool, issuer: ISSUER, mode: 'enabled', v2Mode: 'enabled',
      providerPublicOrigins: new Map(), grantKeys: material,
    }).requestGrant({ userId: 7 }, Array.from({ length: 17 }, () => INSTALLATION))
    expect(oversize.type).toBe('memory_mcp_grant_error')
    if (oversize.type === 'memory_mcp_grant_error') expect(oversize.code).toBe('invalid_request')

    const empty = await createMemoryMcpGrantBroker({
      pool, issuer: ISSUER, mode: 'enabled', v2Mode: 'enabled',
      providerPublicOrigins: new Map(), grantKeys: material,
    }).requestGrant({ userId: 7 }, [])
    expect(empty.type).toBe('memory_mcp_grant_error')

    // The handler passes the selection through from the wire message.
    const sent: string[] = []
    const broker = {
      requestGrant: vi.fn(async (_daemon: unknown, ids?: string[]) => {
        sent.push(...(ids ?? []))
        return { type: 'memory_mcp_grant_result', grant: 'g', expires_in: 60,
          token_type: 'extension_capability_v2', installation_id: ids?.[0] ?? '',
          provider_public_origin: '', services: ['memory.mcp'] }
      }),
    }
    await handleMemoryMcpGrantMessage(broker as never, { userId: 7 },
      { type: 'memory_mcp_grant', scope_installation_ids: [INSTALLATION] },
      () => undefined)
    expect(sent).toEqual([INSTALLATION])
  })
})
