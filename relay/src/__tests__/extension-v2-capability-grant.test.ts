import { describe, expect, test } from 'vitest'
import jwt from 'jsonwebtoken'

import {
  CAPABILITY_GRANT_V2_MAX_BINDINGS,
  CAPABILITY_GRANT_V2_MAX_TTL_SECONDS,
  CAPABILITY_GRANT_V2_TOKEN_TYPE,
  type GrantKeyMaterial,
  type ScopeBindingV2,
  resolveGrantKeyMaterial,
  signCapabilityGrantV2,
  verifyCapabilityGrantV2,
} from '../extensions/capability-grant.js'

const ISSUER = 'https://relay.example.test'
const PROVIDER = 'pocketctl-memory'

function keys(): GrantKeyMaterial {
  return resolveGrantKeyMaterial({ NODE_ENV: 'test' })
}

function binding(overrides: Partial<ScopeBindingV2> = {}): ScopeBindingV2 {
  return {
    installation_id: '11111111-1111-4111-8111-111111111111',
    owner_scope_kind: 'team',
    owner_scope_id: '22222222-2222-4222-8222-222222222222',
    membership_id: '33333333-3333-4333-8333-333333333333',
    membership_revision: '4',
    authorization_epoch: '7',
    permissions: ['read', 'review'],
    ...overrides,
  }
}

function sign(keysMaterial: GrantKeyMaterial, overrides: Partial<Parameters<typeof signCapabilityGrantV2>[1]> = {}) {
  return signCapabilityGrantV2(keysMaterial, {
    issuer: ISSUER,
    providerId: PROVIDER,
    userId: 9,
    callerType: 'web',
    services: ['memory.search'],
    primaryInstallationId: '11111111-1111-4111-8111-111111111111',
    scopeBindings: [binding()],
    configVersion: '12',
    ...overrides,
  })
}

describe('extension capability grant v2 signing and verification', () => {
  test('round-trips the frozen v2 grant shape', () => {
    const material = keys()
    const token = sign(material)
    const verified = verifyCapabilityGrantV2(material.publicKeyPem, token, ISSUER)
    expect(verified).not.toBeNull()
    expect(CAPABILITY_GRANT_V2_TOKEN_TYPE).toBe(CAPABILITY_GRANT_V2_TOKEN_TYPE)
    expect(verified!.userId).toBe(9)
    expect(verified!.providerId).toBe(PROVIDER)
    expect(verified!.callerType).toBe('web')
    expect(verified!.services).toEqual(['memory.search'])
    expect(verified!.primaryInstallationId).toBe('11111111-1111-4111-8111-111111111111')
    expect(verified!.configVersion).toBe('12')
    expect(verified!.scopeBindings).toEqual([binding()])
  })

  test('clamps the TTL to the 60-second v2 ceiling', () => {
    const material = keys()
    const token = sign(material, { ttlSeconds: 3600 })
    const decoded = jwt.decode(token) as { exp: number; iat: number }
    expect(decoded.exp - decoded.iat).toBe(CAPABILITY_GRANT_V2_MAX_TTL_SECONDS)
    expect(CAPABILITY_GRANT_V2_MAX_TTL_SECONDS).toBe(60)
  })

  test('v1 tokens and foreign token types never verify as v2', () => {
    const material = keys()
    const v1Style = jwt.sign(
      {
        token_type: 'extension_capability',
        installation_id: '11111111-1111-4111-8111-111111111111',
        caller_type: 'web',
        services: ['memory.search'],
        config_version: '1',
      },
      material.privateKeyPem,
      { algorithm: 'RS256', issuer: ISSUER, audience: PROVIDER, subject: 'user:9', expiresIn: 60 },
    )
    expect(verifyCapabilityGrantV2(material.publicKeyPem, v1Style, ISSUER)).toBeNull()

    expect(verifyCapabilityGrantV2(material.publicKeyPem, 'not-a-jwt', ISSUER)).toBeNull()

    const wrongIssuer = jwt.sign(
      { token_type: CAPABILITY_GRANT_V2_TOKEN_TYPE },
      material.privateKeyPem,
      { algorithm: 'RS256', issuer: 'https://evil.example', audience: PROVIDER, subject: 'user:9', expiresIn: 60 },
    )
    expect(verifyCapabilityGrantV2(material.publicKeyPem, wrongIssuer, ISSUER)).toBeNull()

    const otherKeys = keys()
    const foreignSignature = sign(otherKeys)
    expect(verifyCapabilityGrantV2(material.publicKeyPem, foreignSignature, ISSUER)).toBeNull()
  })

  test('rejects grants exceeding the 16-binding ceiling or duplicating installations', () => {
    const material = keys()
    const many = Array.from({ length: CAPABILITY_GRANT_V2_MAX_BINDINGS + 1 }, (_, index) =>
      binding({ installation_id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111` }))
    const oversized = sign(material, { scopeBindings: many })
    expect(verifyCapabilityGrantV2(material.publicKeyPem, oversized, ISSUER)).toBeNull()

    expect(CAPABILITY_GRANT_V2_MAX_BINDINGS).toBe(16)

    const duplicated = sign(material, {
      scopeBindings: [binding(), binding({ membership_revision: '5' })],
    })
    expect(verifyCapabilityGrantV2(material.publicKeyPem, duplicated, ISSUER)).toBeNull()
  })

  test('rejects unknown permissions, scope kinds, and malformed fence values', () => {
    const material = keys()
    expect(verifyCapabilityGrantV2(
      material.publicKeyPem,
      sign(material, { scopeBindings: [binding({ permissions: ['admin'] as never })] }),
      ISSUER,
    )).toBeNull()
    expect(verifyCapabilityGrantV2(
      material.publicKeyPem,
      sign(material, { scopeBindings: [binding({ permissions: ['read', 'read'] })] }),
      ISSUER,
    )).toBeNull()
    expect(verifyCapabilityGrantV2(
      material.publicKeyPem,
      sign(material, { scopeBindings: [binding({ owner_scope_kind: 'galaxy' as never })] }),
      ISSUER,
    )).toBeNull()
    expect(verifyCapabilityGrantV2(
      material.publicKeyPem,
      sign(material, { scopeBindings: [binding({ membership_revision: 'soon' })] }),
      ISSUER,
    )).toBeNull()
    expect(verifyCapabilityGrantV2(
      material.publicKeyPem,
      sign(material, { scopeBindings: [binding({ authorization_epoch: '0' })] }),
      ISSUER,
    )).toBeNull()
    expect(verifyCapabilityGrantV2(
      material.publicKeyPem,
      sign(material, { scopeBindings: [binding({ owner_scope_kind: 'personal', membership_id: 'not-null' })] }),
      ISSUER,
    )).toBeNull()
  })

  test('personal bindings carry all six owner permissions and no membership fence', () => {
    const material = keys()
    const personal = binding({
      owner_scope_kind: 'personal',
      owner_scope_id: '11111111-1111-4111-8111-111111111111',
      membership_id: null,
      membership_revision: '0',
      authorization_epoch: '1',
      permissions: ['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin'],
    })
    const verified = verifyCapabilityGrantV2(
      material.publicKeyPem, sign(material, { scopeBindings: [personal] }), ISSUER)
    expect(verified).not.toBeNull()
    expect(verified!.scopeBindings[0].membership_id).toBeNull()
  })
})
