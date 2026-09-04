import { createPublicKey, generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, test, vi } from 'vitest'
import { createCapabilityVerifier } from '../relay/capability-verifier.js'

const ISSUER = 'http://relay.test'
const INSTALLATION = '11111111-1111-1111-1111-111111111111'

function makeKeys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    kid: 'test-kid-1',
  }
}

function jwksFor(keys: ReturnType<typeof makeKeys>) {
  const exported = createPublicKey(keys.publicKeyPem).export({ format: 'jwk' }) as {
    kty: string; n: string; e: string
  }
  return {
    keys: [{
      kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid: keys.kid,
    }],
  }
}

function signGrant(
  keys: ReturnType<typeof makeKeys>,
  overrides: {
    payload?: Record<string, unknown>
    issuer?: string
    audience?: string
    subject?: string
    ttlSeconds?: number
    keyid?: string
    algorithm?: jwt.Algorithm
    secret?: string
  } = {},
): string {
  const ttl = overrides.ttlSeconds ?? 120
  return jwt.sign(
    {
      token_type: 'extension_capability',
      installation_id: INSTALLATION,
      provider_id: 'pocketctl-memory',
      caller_type: 'web',
      services: ['memory.search'],
      config_version: '3',
      ...overrides.payload,
    },
    overrides.secret ?? keys.privateKeyPem,
    {
      algorithm: overrides.algorithm ?? 'RS256',
      keyid: overrides.keyid ?? keys.kid,
      issuer: overrides.issuer ?? ISSUER,
      audience: overrides.audience ?? 'pocketctl-memory',
      subject: overrides.subject ?? 'user:42',
      expiresIn: ttl,
      jwtid: 'jti-1',
    },
  )
}

function makeVerifier(keys: ReturnType<typeof makeKeys>, options: {
  installations?: Record<string, { local_status: string; relay_status: string; config_version: string }>
  fetchImpl?: typeof fetch
  now?: () => number
} = {}) {
  const installations = options.installations ?? {
    [INSTALLATION]: { local_status: 'ready', relay_status: 'active', config_version: '3' },
  }
  const defaultFetch = vi.fn(async () => new Response(
    JSON.stringify(jwksFor(keys)), { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  return {
    verifier: createCapabilityVerifier({
      relayUrl: ISSUER,
      issuer: ISSUER,
      fetchImpl: options.fetchImpl ?? (defaultFetch as unknown as typeof fetch),
      now: options.now,
      lookupInstallation: async installationId =>
        installations[installationId] ?? null,
    }),
    fetchMock: defaultFetch,
  }
}

describe('capability grant verification', () => {
  test('accepts a well-formed grant and returns its scope', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    const grant = await verifier.verify(signGrant(keys), 'memory.search')
    expect(grant).toMatchObject({
      installationId: INSTALLATION,
      callerType: 'web',
      services: ['memory.search'],
    })
  })

  test('rejects symmetric algorithms and foreign signing keys', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    const hs256 = signGrant(keys, { algorithm: 'HS256', secret: 'shared-secret' })
    expect(await verifier.verify(hs256, 'memory.search')).toBeNull()
    const otherKeys = makeKeys()
    const foreign = signGrant(otherKeys, { keyid: keys.kid })
    expect(await verifier.verify(foreign, 'memory.search')).toBeNull()
  })

  test('rejects wrong issuer, audience and provider ids', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    expect(await verifier.verify(signGrant(keys, { issuer: 'http://evil.test' }), 'memory.search')).toBeNull()
    expect(await verifier.verify(signGrant(keys, { audience: 'other-provider' }), 'memory.search')).toBeNull()
    expect(await verifier.verify(
      signGrant(keys, { payload: { provider_id: 'other-provider' } }), 'memory.search',
    )).toBeNull()
  })

  test('rejects expired, not-yet-valid and mistyped tokens', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    // Outside the 30s clock tolerance (a -10s drift stays within it).
    expect(await verifier.verify(signGrant(keys, { ttlSeconds: -120 }), 'memory.search')).toBeNull()
    const future = jwt.sign(
      { token_type: 'extension_capability', installation_id: INSTALLATION, provider_id: 'pocketctl-memory', services: ['memory.search'], config_version: '3' },
      keys.privateKeyPem,
      {
        algorithm: 'RS256', keyid: keys.kid, issuer: ISSUER, audience: 'pocketctl-memory',
        subject: 'user:42', expiresIn: 300, notBefore: 600, jwtid: 'jti-2',
      },
    )
    expect(await verifier.verify(future, 'memory.search')).toBeNull()
    expect(await verifier.verify(
      signGrant(keys, { payload: { token_type: 'access_token' } }), 'memory.search',
    )).toBeNull()
    expect(await verifier.verify(
      signGrant(keys, { subject: 'user:abc' }), 'memory.search',
    )).toBeNull()
    expect(await verifier.verify(
      signGrant(keys, { subject: 'user:0' }), 'memory.search',
    )).toBeNull()
  })

  test('rejects grants without temporal claims or beyond the five-minute lifetime', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    const unbounded = jwt.sign(
      {
        token_type: 'extension_capability',
        installation_id: INSTALLATION,
        provider_id: 'pocketctl-memory',
        caller_type: 'web',
        services: ['memory.search'],
        config_version: '3',
      },
      keys.privateKeyPem,
      {
        algorithm: 'RS256', keyid: keys.kid, issuer: ISSUER,
        audience: 'pocketctl-memory', subject: 'user:42', jwtid: 'unbounded',
        noTimestamp: true,
      },
    )
    expect(await verifier.verify(unbounded, 'memory.search')).toBeNull()
    expect(await verifier.verify(
      signGrant(keys, { ttlSeconds: 600 }), 'memory.search',
    )).toBeNull()
  })

  test('rejects grants issued beyond clock tolerance even with a five-minute lifetime', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    const issuedAt = Math.floor(Date.now() / 1000) + 3_600
    const futureIssued = jwt.sign(
      {
        token_type: 'extension_capability',
        installation_id: INSTALLATION,
        provider_id: 'pocketctl-memory',
        caller_type: 'web',
        services: ['memory.search'],
        config_version: '3',
        iat: issuedAt,
        exp: issuedAt + 300,
      },
      keys.privateKeyPem,
      {
        algorithm: 'RS256', keyid: keys.kid, issuer: ISSUER,
        audience: 'pocketctl-memory', subject: 'user:42', jwtid: 'future-issued',
      },
    )
    expect(await verifier.verify(futureIssued, 'memory.search')).toBeNull()
  })

  test('requires the route service and a matching local config version', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    expect(await verifier.verify(
      signGrant(keys, { payload: { services: ['memory.recall'] } }), 'memory.search',
    )).toBeNull()
    expect(await verifier.verify(
      signGrant(keys, { payload: { config_version: '99' } }), 'memory.search',
    )).toBeNull()
  })

  test('rejects purged, revoked and unknown installations', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys, {
      installations: {
        [INSTALLATION]: { local_status: 'purged', relay_status: 'revoked', config_version: '3' },
      },
    })
    expect(await verifier.verify(signGrant(keys), 'memory.search')).toBeNull()

    const missing = makeVerifier(keys, { installations: {} })
    expect(await missing.verifier.verify(signGrant(keys), 'memory.search')).toBeNull()
  })

  test('session-scoped checks require an exact session match', async () => {
    const keys = makeKeys()
    const { verifier } = makeVerifier(keys)
    const grant = signGrant(keys, { payload: { session_id: 'ses-1' } })
    expect(await verifier.verify(grant, 'memory.search', 'ses-1')).not.toBeNull()
    expect(await verifier.verify(grant, 'memory.search', 'ses-2')).toBeNull()
    expect(await verifier.verify(grant, 'memory.search')).toBeNull()
  })

  test('an unknown kid forces exactly one JWKS refresh', async () => {
    const oldKeys = makeKeys()
    const newKeys = makeKeys()
    newKeys.kid = 'rotated-kid-2'
    let served = oldKeys
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(jwksFor(served)), { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const { verifier } = makeVerifier(oldKeys, { fetchImpl: fetchImpl as unknown as typeof fetch })

    // Prime the cache with the old key set.
    expect(await verifier.verify(signGrant(oldKeys), 'memory.search')).not.toBeNull()
    const before = fetchImpl.mock.calls.length

    // A token under a kid the cache has never seen triggers one forced
    // refresh — which serves the (still old) document, so it fails.
    expect(await verifier.verify(signGrant(newKeys), 'memory.search')).toBeNull()
    expect(fetchImpl.mock.calls.length).toBe(before + 1)

    // Rotation lands in the JWKS; the next unknown-kid refresh succeeds.
    served = newKeys
    expect(await verifier.verify(signGrant(newKeys), 'memory.search')).not.toBeNull()
  })

  test('a JWKS outage falls back to the cached keys within their TTL', async () => {
    const keys = makeKeys()
    let fail = false
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('jwks endpoint down')
      return new Response(
        JSON.stringify(jwksFor(keys)), { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const { verifier } = makeVerifier(keys, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await verifier.verify(signGrant(keys), 'memory.search')).not.toBeNull()
    fail = true
    // Cache hit: verification still works without the endpoint.
    expect(await verifier.verify(signGrant(keys), 'memory.search')).not.toBeNull()
  })

  test('a successful JWKS refresh evicts kids removed by key rotation', async () => {
    const oldKeys = makeKeys()
    const newKeys = makeKeys()
    newKeys.kid = 'rotated-only-kid'
    let served = oldKeys
    let cacheNow = 0
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(jwksFor(served)), { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const { verifier } = makeVerifier(oldKeys, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => cacheNow,
    })
    expect(await verifier.verify(signGrant(oldKeys), 'memory.search')).not.toBeNull()

    served = newKeys
    cacheNow = 5 * 60_000 + 1
    expect(await verifier.verify(signGrant(oldKeys), 'memory.search')).toBeNull()
  })
})
