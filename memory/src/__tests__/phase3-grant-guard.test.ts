import { createPublicKey, generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, test, vi } from 'vitest'

import { createGrantGuard } from '../auth/grant-guard.js'

const ISSUER = 'http://relay.test'
const PRIMARY = '11111111-1111-4111-8111-111111111111'
const TEAM_INSTALL = '22222222-2222-4222-8222-222222222222'
const FOREIGN_INSTALL = '33333333-3333-4333-8333-333333333333'
const TEAM_SCOPE = '44444444-4444-4444-8444-444444444444'
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555'

function makeKeys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    kid: 'test-kid-v2',
  }
}

function jwksFor(keys: ReturnType<typeof makeKeys>) {
  const exported = createPublicKey(keys.publicKeyPem).export({ format: 'jwk' }) as {
    kty: string; n: string; e: string
  }
  return {
    keys: [{ kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid: keys.kid }],
  }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: TEAM_INSTALL,
    owner_scope_kind: 'team',
    owner_scope_id: TEAM_SCOPE,
    membership_id: MEMBERSHIP,
    membership_revision: '2',
    authorization_epoch: '5',
    permissions: ['read', 'review'],
    ...overrides,
  }
}

function signV2(
  keys: ReturnType<typeof makeKeys>,
  overrides: {
    payload?: Record<string, unknown>
    ttlSeconds?: number
    issuer?: string
    keyid?: string
  } = {},
): string {
  return jwt.sign(
    {
      token_type: 'extension_capability_v2',
      caller_type: 'web',
      services: ['memory.search'],
      primary_installation_id: PRIMARY,
      scope_bindings: [binding()],
      config_version: '7',
      ...overrides.payload,
    },
    keys.privateKeyPem,
    {
      algorithm: 'RS256',
      keyid: overrides.keyid ?? keys.kid,
      issuer: overrides.issuer ?? ISSUER,
      audience: 'pocketctl-memory',
      subject: 'user:42',
      expiresIn: overrides.ttlSeconds ?? 60,
      jwtid: 'jti-v2',
    },
  )
}

interface MirrorRow {
  installation_id: string
  local_status: string
  relay_status: string
  config_version: string
  owner_scope_kind: string
  owner_scope_id: string
  scope_state: string
  authorization_epoch: string
  membership_id: string | null
  membership_state: string | null
  membership_revision: string | null
  roles: string[] | null
}

function mirrorRow(overrides: Partial<MirrorRow> = {}): MirrorRow {
  return {
    installation_id: TEAM_INSTALL,
    local_status: 'ready',
    relay_status: 'active',
    config_version: '7',
    owner_scope_kind: 'team',
    owner_scope_id: TEAM_SCOPE,
    scope_state: 'active',
    authorization_epoch: '5',
    membership_id: MEMBERSHIP,
    membership_state: 'active',
    membership_revision: '2',
    roles: ['reader', 'reviewer'],
    ...overrides,
  }
}

function makeGuard(keys: ReturnType<typeof makeKeys>, rows: MirrorRow[]) {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify(jwksFor(keys)), { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  const pool = {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  } as never as import('pg').Pool
  const guard = createGrantGuard({
    pool,
    relayUrl: ISSUER,
    relayIssuer: ISSUER,
    fetchImpl: fetchMock as unknown as typeof fetch,
  })
  return { guard, pool, fetchMock }
}

describe('memory v2 grant guard', () => {
  const keys = makeKeys()

  test('verifies a valid v2 grant and returns validated bindings', async () => {
    const personal = mirrorRow({
      installation_id: PRIMARY,
      owner_scope_kind: 'personal',
      owner_scope_id: PRIMARY,
      scope_state: 'active',
      authorization_epoch: '1',
      membership_id: null,
      membership_state: null,
      membership_revision: null,
      roles: null,
    })
    const { guard } = makeGuard(keys, [personal, mirrorRow()])
    const grant = await guard.guardV2({
      authorization: `Bearer ${signV2(keys, {
        payload: {
          primary_installation_id: PRIMARY,
          scope_bindings: [
            {
              installation_id: PRIMARY,
              owner_scope_kind: 'personal',
              owner_scope_id: PRIMARY,
              membership_id: null,
              membership_revision: '0',
              authorization_epoch: '1',
              permissions: ['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin'],
            },
            binding(),
          ],
        },
      })}`,
      requiredService: 'memory.search',
    })
    expect(grant.version).toBe('v2')
    expect(grant.installationId).toBe(PRIMARY)
    expect(grant.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY, TEAM_INSTALL])
    expect(grant.scopeBindings[1].permissions).toEqual(['read', 'review'])
  })

  test('drops stale, revoked, and foreign bindings instead of failing the grant', async () => {
    const stale = mirrorRow({ authorization_epoch: '9' })
    const revokedMember = mirrorRow({
      installation_id: FOREIGN_INSTALL,
      owner_scope_id: '66666666-6666-4666-8666-666666666666',
      membership_state: 'revoked',
      membership_revision: '3',
    })
    const personal = mirrorRow({
      installation_id: PRIMARY,
      owner_scope_kind: 'personal',
      owner_scope_id: PRIMARY,
      membership_id: null,
      membership_state: null,
      membership_revision: null,
      roles: null,
      authorization_epoch: '1',
    })
    const { guard } = makeGuard(keys, [personal, stale, revokedMember])
    const grant = await guard.guardV2({
      authorization: `Bearer ${signV2(keys, {
        payload: {
          scope_bindings: [
            {
              installation_id: PRIMARY,
              owner_scope_kind: 'personal',
              owner_scope_id: PRIMARY,
              membership_id: null,
              membership_revision: '0',
              authorization_epoch: '1',
              permissions: ['read'],
            },
            binding(),
            binding({ installation_id: FOREIGN_INSTALL, owner_scope_id: '66666666-6666-4666-8666-666666666666' }),
          ],
        },
      })}`,
      requiredService: 'memory.search',
    })
    expect(grant.scopeBindings.map(entry => entry.installation_id)).toEqual([PRIMARY])
  })

  test('compares authorization fences exactly above the JavaScript safe-integer limit', async () => {
    const { guard } = makeGuard(keys, [mirrorRow({
      authorization_epoch: '9007199254740993',
      membership_revision: '9007199254740993',
    })])
    const stale = binding({
      authorization_epoch: '9007199254740992',
      membership_revision: '9007199254740992',
    })
    const token = signV2(keys, { payload: {
      primary_installation_id: TEAM_INSTALL,
      scope_bindings: [stale],
    } })

    await expect(guard.guardV2({
      authorization: `Bearer ${token}`,
      requiredService: 'memory.search',
    })).rejects.toMatchObject({ httpStatus: 401 })
  })

  test('accepts a dissolving primary only through the narrow disposition guard', async () => {
    const dispositionBinding = binding({
      authorization_epoch: '8',
      permissions: ['read', 'scope_admin'],
    })
    const { guard } = makeGuard(keys, [mirrorRow({
      scope_state: 'dissolving',
      authorization_epoch: '8',
      roles: ['scope_administrator'],
    })])
    const token = signV2(keys, { payload: {
      services: ['memory.manage'],
      primary_installation_id: TEAM_INSTALL,
      scope_bindings: [dispositionBinding],
    } })
    await expect(guard.guardV2({
      authorization: `Bearer ${token}`, requiredService: 'memory.manage',
    })).rejects.toMatchObject({ httpStatus: 401 })
    await expect(guard.guardV2Disposition({
      authorization: `Bearer ${token}`, requiredService: 'memory.manage',
    })).resolves.toMatchObject({ installationId: TEAM_INSTALL })
  })

  test('rejects the whole grant when the primary binding or service fails', async () => {
    const { guard } = makeGuard(keys, [mirrorRow({ installation_id: PRIMARY, owner_scope_kind: 'personal', owner_scope_id: PRIMARY, membership_id: null, membership_state: null, membership_revision: null, roles: null })])
    await expect(guard.guardV2({
      authorization: `Bearer ${signV2(keys)}`,
      requiredService: 'memory.search',
    })).rejects.toMatchObject({ httpStatus: 401 })

    await expect(guard.guardV2({
      authorization: `Bearer ${signV2(keys)}`,
      requiredService: 'memory.mcp',
    })).rejects.toMatchObject({ httpStatus: 401 })
  })

  test('rejects oversized, expired, or mis-signed v2 grants', async () => {
    const rows = [mirrorRow({ installation_id: PRIMARY, owner_scope_kind: 'personal', owner_scope_id: PRIMARY, membership_id: null, membership_state: null, membership_revision: null, roles: null, authorization_epoch: '1' })]
    const { guard } = makeGuard(keys, rows)

    const oversized = Array.from({ length: 17 }, (_, index) =>
      binding({ installation_id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111` }))
    await expect(guard.guardV2({
      authorization: `Bearer ${signV2(keys, { payload: { scope_bindings: oversized } })}`,
      requiredService: 'memory.search',
    })).rejects.toMatchObject({ httpStatus: 401 })

    await expect(guard.guardV2({
      authorization: `Bearer ${signV2(keys, { ttlSeconds: 300 })}`,
      requiredService: 'memory.search',
    })).rejects.toMatchObject({ httpStatus: 401 })

    const otherKeys = makeKeys()
    const { guard: foreignGuard } = makeGuard(otherKeys, rows)
    await expect(foreignGuard.guardV2({
      authorization: `Bearer ${signV2(keys)}`,
      requiredService: 'memory.search',
    })).rejects.toMatchObject({ httpStatus: 401 })
  })

  test('v1 tokens never verify through the v2 guard', async () => {
    const rows = [mirrorRow()]
    const { guard } = makeGuard(keys, rows)
    const v1Token = jwt.sign(
      {
        token_type: 'extension_capability',
        installation_id: PRIMARY,
        provider_id: 'pocketctl-memory',
        caller_type: 'web',
        services: ['memory.search'],
        config_version: '7',
      },
      keys.privateKeyPem,
      {
        algorithm: 'RS256', keyid: keys.kid, issuer: ISSUER,
        audience: 'pocketctl-memory', subject: 'user:42', expiresIn: 60,
      },
    )
    await expect(guard.guardV2({
      authorization: `Bearer ${v1Token}`,
      requiredService: 'memory.search',
    })).rejects.toMatchObject({ httpStatus: 401 })
  })
})
