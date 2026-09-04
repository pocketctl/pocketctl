import { describe, expect, test } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import {
  CAPABILITY_GRANT_MAX_TTL_SECONDS,
  publicJwks,
  resolveGrantKeyMaterial,
  signCapabilityGrant,
  verifyCapabilityGrant,
} from '../extensions/capability-grant.js'

const ISSUER = 'https://relay.example.test'

function rsaPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

describe('grant key material resolution', () => {
  test('production fails startup without keys', () => {
    expect(() => resolveGrantKeyMaterial({ NODE_ENV: 'production' }))
      .toThrow('EXTENSION_GRANT_PRIVATE_KEY')
  })

  test('production rejects invalid PEM and mismatched pairs', () => {
    expect(() => resolveGrantKeyMaterial({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PRIVATE_KEY: 'not a pem',
      EXTENSION_GRANT_PUBLIC_KEY: 'not a pem',
    })).toThrow('PEM')

    const pairA = rsaPair()
    const pairB = rsaPair()
    expect(() => resolveGrantKeyMaterial({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PRIVATE_KEY: pairA.privateKeyPem,
      EXTENSION_GRANT_PUBLIC_KEY: pairB.publicKeyPem,
    })).toThrow('match')
  })

  test('production rejects half-configured pairs', () => {
    const pair = rsaPair()
    expect(() => resolveGrantKeyMaterial({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PRIVATE_KEY: pair.privateKeyPem,
    })).toThrow('together')
  })

  test('development generates an ephemeral pair instead of failing', () => {
    const keys = resolveGrantKeyMaterial({ NODE_ENV: 'development' })
    expect(keys.privateKeyPem).toContain('PRIVATE KEY')
    expect(keys.kid).toBe('dev-ephemeral')
  })

  test('a valid configured pair derives a stable kid', () => {
    const pair = rsaPair()
    const keys = resolveGrantKeyMaterial({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PRIVATE_KEY: pair.privateKeyPem,
      EXTENSION_GRANT_PUBLIC_KEY: pair.publicKeyPem,
      EXTENSION_GRANT_KEY_ID: 'grant-key-2026-08',
    })
    expect(keys.kid).toBe('grant-key-2026-08')
  })

  test('resolves an RSA pair from base64 EnvironmentFile values', () => {
    const pair = rsaPair()
    const keys = resolveGrantKeyMaterial({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PRIVATE_KEY_B64: Buffer.from(pair.privateKeyPem).toString('base64'),
      EXTENSION_GRANT_PUBLIC_KEY_B64: Buffer.from(pair.publicKeyPem).toString('base64'),
      EXTENSION_GRANT_KEY_ID: 'b64-key',
    })
    expect(keys.privateKeyPem).toBe(pair.privateKeyPem.trim())
    expect(keys.publicKeyPem).toBe(pair.publicKeyPem.trim())
    expect(keys.kid).toBe('b64-key')
  })
})

describe('capability grant signing and verification', () => {
  test('signs RS256-only grants with the fixed kid and frozen claims', () => {
    const pair = rsaPair()
    const keys = resolveGrantKeyMaterial({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PRIVATE_KEY: pair.privateKeyPem,
      EXTENSION_GRANT_PUBLIC_KEY: pair.publicKeyPem,
      EXTENSION_GRANT_KEY_ID: 'kid-1',
    })
    const token = signCapabilityGrant(keys, {
      issuer: ISSUER,
      providerId: 'pocketctl-memory',
      installationId: '11111111-1111-1111-1111-111111111111',
      userId: 42,
      callerType: 'web',
      sessionId: 'ses-1',
      services: ['memory.search'],
      configVersion: 3,
    })
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBe('kid-1')

    const verified = verifyCapabilityGrant(keys.publicKeyPem, token, ISSUER)
    expect(verified).toMatchObject({
      userId: 42,
      providerId: 'pocketctl-memory',
      installationId: '11111111-1111-1111-1111-111111111111',
      callerType: 'web',
      sessionId: 'ses-1',
      services: ['memory.search'],
      configVersion: '3',
    })

    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.token_type).toBe('extension_capability')
    expect(decoded.sub).toBe('user:42')
    expect(Number(decoded.exp) - Number(decoded.iat)).toBeLessThanOrEqual(CAPABILITY_GRANT_MAX_TTL_SECONDS)
  })

  test('TTL is clamped to 1..300 seconds', () => {
    const keys = resolveGrantKeyMaterial({})
    const long = signCapabilityGrant(keys, {
      issuer: ISSUER, providerId: 'p', installationId: 'i', userId: 1,
      callerType: 'agent', services: [], configVersion: 1, ttlSeconds: 3600,
    })
    const decoded = jwt.decode(long) as Record<string, unknown>
    expect(Number(decoded.exp) - Number(decoded.iat)).toBe(300)

    expect(() => signCapabilityGrant(keys, {
      issuer: ISSUER, providerId: 'p', installationId: 'i', userId: 1,
      callerType: 'agent', services: [], configVersion: 1, ttlSeconds: 0,
    })).not.toThrow()
  })

  test('verification rejects foreign keys and non-grant tokens', () => {
    const keys = resolveGrantKeyMaterial({})
    const token = signCapabilityGrant(keys, {
      issuer: ISSUER, providerId: 'p', installationId: 'i', userId: 1,
      callerType: 'web', services: ['memory.search'], configVersion: 1,
    })
    const otherPair = rsaPair()
    expect(verifyCapabilityGrant(otherPair.publicKeyPem, token, ISSUER)).toBeNull()
    // A user access token cannot verify as a grant.
    const accessToken = jwt.sign({ userId: 1, type: 'access' }, 'user-secret', { expiresIn: '5m' })
    expect(verifyCapabilityGrant(keys.publicKeyPem, accessToken, ISSUER)).toBeNull()
    // Wrong issuer fails.
    expect(verifyCapabilityGrant(keys.publicKeyPem, token, 'https://elsewhere')).toBeNull()
  })
})

describe('grant JWKS exposure', () => {
  test('exposes only the public JWK fields', () => {
    const pair = rsaPair()
    const keys = resolveGrantKeyMaterial({
      EXTENSION_GRANT_PRIVATE_KEY: pair.privateKeyPem,
      EXTENSION_GRANT_PUBLIC_KEY: pair.publicKeyPem,
    })
    const jwks = publicJwks(keys)
    expect(jwks.keys.length).toBe(1)
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'])
    expect(jwks.keys[0].alg).toBe('RS256')
    expect(jwks.keys[0].use).toBe('sig')
    expect(JSON.stringify(jwks)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(jwks)).not.toContain(pair.privateKeyPem.slice(0, 40))
  })
})
