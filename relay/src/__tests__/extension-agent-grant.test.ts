import { generateKeyPairSync } from 'crypto'
import { describe, expect, test, vi } from 'vitest'
import { createMemoryMcpGrantBroker, handleMemoryMcpGrantMessage } from '../extensions/grant-service.js'
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
