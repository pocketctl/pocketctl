import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { extensionTextSecret } from './config.js'

/**
 * ADR-0003 authorization chain 2: short-lived RS256 Capability Grants the
 * Relay issues to Web/Daemon/Agent callers so they can call provider APIs.
 * The grant keypair is completely separate from the user JWT_SECRET; the
 * private key never leaves the signing path and the JWKS exposes only the
 * public JWK fields.
 */

export const CAPABILITY_GRANT_TOKEN_TYPE = 'extension_capability'
export const CAPABILITY_GRANT_MAX_TTL_SECONDS = 300

export interface GrantKeyMaterial {
  privateKeyPem: string
  publicKeyPem: string
  /** Stable signing key id surfaced in both the JWT header and the JWKS. */
  kid: string
}

function pemThumbprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

/**
 * Resolve the grant key material. Production fails startup on missing or
 * invalid PEM, a public/private mismatch, or an empty configured kid; the
 * separate chain must never degrade to the shared user JWT secret. Outside
 * production an ephemeral RSA pair keeps local flows usable.
 */
export function resolveGrantKeyMaterial(env: {
  NODE_ENV?: string
  EXTENSION_GRANT_PRIVATE_KEY?: string
  EXTENSION_GRANT_PUBLIC_KEY?: string
  EXTENSION_GRANT_PRIVATE_KEY_B64?: string
  EXTENSION_GRANT_PUBLIC_KEY_B64?: string
  EXTENSION_GRANT_KEY_ID?: string
}, options: { strictProduction?: boolean } = {}): GrantKeyMaterial {
  // Real keys are mandatory only when grants are actually mintable
  // (production + enabled); off/shadow deployments keep an ephemeral pair so
  // the read-only JWKS surface stays available without secrets.
  const production = env.NODE_ENV === 'production' && (options.strictProduction ?? true)
  const privateKeyPem = extensionTextSecret(env, 'EXTENSION_GRANT_PRIVATE_KEY')
  const publicKeyPem = extensionTextSecret(env, 'EXTENSION_GRANT_PUBLIC_KEY')
  const configuredKid = env.EXTENSION_GRANT_KEY_ID?.trim() ?? ''

  if (!privateKeyPem && !publicKeyPem) {
    if (production) {
      throw new Error('EXTENSION_GRANT_PRIVATE_KEY/EXTENSION_GRANT_PUBLIC_KEY are required in production')
    }
    const generated = generateKeyPairSync('rsa', { modulusLength: 2048 })
    return {
      privateKeyPem: generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: generated.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      kid: 'dev-ephemeral',
    }
  }
  if (!privateKeyPem || !publicKeyPem) {
    throw new Error('EXTENSION_GRANT_PRIVATE_KEY and EXTENSION_GRANT_PUBLIC_KEY must be configured together')
  }
  let keys: { privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey> }
  try {
    keys = {
      privateKey: createPrivateKey(privateKeyPem),
      publicKey: createPublicKey(publicKeyPem),
    }
  } catch {
    throw new Error('EXTENSION_GRANT_PRIVATE_KEY/EXTENSION_GRANT_PUBLIC_KEY are not valid PEM keys')
  }
  if (keys.privateKey.asymmetricKeyType !== 'rsa'
    || keys.publicKey.asymmetricKeyType !== 'rsa') {
    throw new Error('extension capability grant keys must be RSA')
  }
  // Pairing check: the private key must derive the same public key.
  const derived = createPublicKey(keys.privateKey).export({ type: 'spki', format: 'pem' }).toString()
  const declared = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  if (derived !== declared) {
    throw new Error('EXTENSION_GRANT_PRIVATE_KEY does not match EXTENSION_GRANT_PUBLIC_KEY')
  }
  const kid = configuredKid || pemThumbprint(declared)
  if (!kid || kid.length > 128) {
    throw new Error('EXTENSION_GRANT_KEY_ID must be a non-empty identifier of at most 128 characters')
  }
  return { privateKeyPem, publicKeyPem, kid }
}

export interface CapabilityGrantInput {
  issuer: string
  providerId: string
  installationId: string
  userId: number
  callerType: 'web' | 'daemon' | 'agent'
  sessionId?: string | null
  services: string[]
  configVersion: number | string
  ttlSeconds?: number
  jti?: string
}

/** Sign a grant; RS256 only, with the fixed kid in the header. */
export function signCapabilityGrant(
  keys: GrantKeyMaterial,
  input: CapabilityGrantInput,
): string {
  const ttl = Math.min(
    Math.max(1, Math.trunc(input.ttlSeconds ?? CAPABILITY_GRANT_MAX_TTL_SECONDS)),
    CAPABILITY_GRANT_MAX_TTL_SECONDS,
  )
  return jwt.sign(
    {
      token_type: CAPABILITY_GRANT_TOKEN_TYPE,
      installation_id: input.installationId,
      provider_id: input.providerId,
      caller_type: input.callerType,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      services: input.services,
      config_version: String(input.configVersion),
    },
    keys.privateKeyPem,
    {
      algorithm: 'RS256',
      keyid: keys.kid,
      issuer: input.issuer,
      audience: input.providerId,
      subject: `user:${input.userId}`,
      expiresIn: ttl,
      jwtid: input.jti ?? randomUUID(),
    },
  )
}

export interface VerifiedCapabilityGrant {
  userId: number
  providerId: string
  installationId: string
  callerType: string
  sessionId?: string
  services: string[]
  configVersion: string
}

/** Verify a grant against the public key only (provider-side semantics). */
export function verifyCapabilityGrant(
  publicKeyPem: string,
  token: string,
  issuer: string,
): VerifiedCapabilityGrant | null {
  let payload: Record<string, unknown>
  try {
    payload = jwt.verify(token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer,
    }) as Record<string, unknown>
  } catch {
    return null
  }
  if (payload.token_type !== CAPABILITY_GRANT_TOKEN_TYPE) return null
  const match = typeof payload.sub === 'string' ? /^user:(\d+)$/.exec(payload.sub) : null
  if (!match) return null
  if (typeof payload.aud !== 'string' || typeof payload.installation_id !== 'string'
    || typeof payload.provider_id !== 'string' || typeof payload.caller_type !== 'string'
    || !Array.isArray(payload.services) || typeof payload.config_version !== 'string') {
    return null
  }
  return {
    userId: Number(match[1]),
    providerId: payload.aud,
    installationId: payload.installation_id,
    callerType: payload.caller_type,
    ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}),
    services: payload.services as string[],
    configVersion: payload.config_version,
  }
}

export interface JsonWebKey {
  kty: string
  n: string
  e: string
  alg: string
  use: string
  kid: string
}

/**
 * Read-only JWKS document. Exposes exactly kty/n/e/alg/use/kid — never the
 * private key, never the shared user JWT secret.
 */
export function publicJwks(keys: GrantKeyMaterial): { keys: JsonWebKey[] } {
  const jwk = createPublicKey(keys.publicKeyPem).export({ format: 'jwk' }) as {
    kty: string
    n?: string
    e?: string
  }
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('grant public key is not an exportable RSA JWK')
  }
  return {
    keys: [{
      kty: 'RSA',
      n: jwk.n,
      e: jwk.e,
      alg: 'RS256',
      use: 'sig',
      kid: keys.kid,
    }],
  }
}
