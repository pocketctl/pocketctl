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

// --- Protocol v2 federated scope grants (ADR-P3-05) ----------------------------

export const CAPABILITY_GRANT_V2_TOKEN_TYPE = 'extension_capability_v2'
/** Frozen v2 ceiling: a v2 grant lives at most 60 seconds (ADR-P3-05/09). */
export const CAPABILITY_GRANT_V2_MAX_TTL_SECONDS = 60
/** Frozen v2 ceiling: at most 16 explicitly selected scope bindings. */
export const CAPABILITY_GRANT_V2_MAX_BINDINGS = 16

export type GrantOwnerScopeKind = 'personal' | 'team' | 'organization'

export interface ScopeBindingV2 {
  installation_id: string
  owner_scope_kind: GrantOwnerScopeKind
  owner_scope_id: string
  membership_id: string | null
  membership_revision: string
  authorization_epoch: string
  permissions: string[]
}

export interface CapabilityGrantV2Input {
  issuer: string
  providerId: string
  userId: number
  callerType: 'web' | 'daemon' | 'agent'
  services: string[]
  primaryInstallationId: string
  scopeBindings: ScopeBindingV2[]
  configVersion: number | string
  ttlSeconds?: number
  jti?: string
}

/** Sign a v2 grant; RS256 only, TTL hard-clamped to the 60-second fence. */
export function signCapabilityGrantV2(
  keys: GrantKeyMaterial,
  input: CapabilityGrantV2Input,
): string {
  const ttl = Math.min(
    Math.max(1, Math.trunc(input.ttlSeconds ?? CAPABILITY_GRANT_V2_MAX_TTL_SECONDS)),
    CAPABILITY_GRANT_V2_MAX_TTL_SECONDS,
  )
  return jwt.sign(
    {
      token_type: CAPABILITY_GRANT_V2_TOKEN_TYPE,
      caller_type: input.callerType,
      services: input.services,
      primary_installation_id: input.primaryInstallationId,
      scope_bindings: input.scopeBindings,
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

export interface VerifiedCapabilityGrantV2 {
  userId: number
  providerId: string
  callerType: string
  services: string[]
  primaryInstallationId: string
  scopeBindings: ScopeBindingV2[]
  configVersion: string
}

const GRANT_PERMISSION_ALLOWLIST = [
  'read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin',
]
const GRANT_SCOPE_KINDS = ['personal', 'team', 'organization']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POSITIVE_INT_PATTERN = /^[0-9]+$/

function isValidBindingV2(binding: unknown): binding is ScopeBindingV2 {
  if (binding === null || typeof binding !== 'object') return false
  const value = binding as Record<string, unknown>
  if (typeof value.installation_id !== 'string' || !UUID_PATTERN.test(value.installation_id)) return false
  if (typeof value.owner_scope_kind !== 'string' || !GRANT_SCOPE_KINDS.includes(value.owner_scope_kind)) return false
  if (typeof value.owner_scope_id !== 'string' || !UUID_PATTERN.test(value.owner_scope_id)) return false
  if (value.membership_id !== null
    && (typeof value.membership_id !== 'string' || !UUID_PATTERN.test(value.membership_id))) return false
  if (value.owner_scope_kind === 'personal' && value.membership_id !== null) return false
  if (typeof value.membership_revision !== 'string' || !POSITIVE_INT_PATTERN.test(value.membership_revision)) return false
  if (typeof value.authorization_epoch !== 'string'
    || !POSITIVE_INT_PATTERN.test(value.authorization_epoch)
    || Number(value.authorization_epoch) < 1) return false
  if (!Array.isArray(value.permissions)
    || value.permissions.some(permission =>
      typeof permission !== 'string' || !GRANT_PERMISSION_ALLOWLIST.includes(permission))) return false
  if (new Set(value.permissions).size !== value.permissions.length) return false
  return true
}

/**
 * Verify a v2 grant against the public key only (provider-side semantics).
 * Shape failures — wrong token type, oversized/duplicated bindings, unknown
 * permissions or scope kinds, malformed fences — all return null: the guard
 * never distinguishes foreign from malformed.
 */
export function verifyCapabilityGrantV2(
  publicKeyPem: string,
  token: string,
  issuer: string,
): VerifiedCapabilityGrantV2 | null {
  let payload: Record<string, unknown>
  try {
    payload = jwt.verify(token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer,
    }) as Record<string, unknown>
  } catch {
    return null
  }
  if (payload.token_type !== CAPABILITY_GRANT_V2_TOKEN_TYPE) return null
  const match = typeof payload.sub === 'string' ? /^user:(\d+)$/.exec(payload.sub) : null
  if (!match) return null
  if (typeof payload.aud !== 'string' || typeof payload.caller_type !== 'string'
    || !Array.isArray(payload.services)
    || payload.services.some(service => typeof service !== 'string')
    || typeof payload.primary_installation_id !== 'string'
    || !Array.isArray(payload.scope_bindings)
    || typeof payload.config_version !== 'string') {
    return null
  }
  const bindings = payload.scope_bindings
  if (bindings.length === 0 || bindings.length > CAPABILITY_GRANT_V2_MAX_BINDINGS) return null
  if (!bindings.every(binding => isValidBindingV2(binding))) return null
  const installationIds = new Set(bindings.map(binding => (binding as ScopeBindingV2).installation_id))
  if (installationIds.size !== bindings.length) return null
  return {
    userId: Number(match[1]),
    providerId: payload.aud,
    callerType: payload.caller_type,
    services: payload.services as string[],
    primaryInstallationId: payload.primary_installation_id,
    scopeBindings: payload.scope_bindings as ScopeBindingV2[],
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
