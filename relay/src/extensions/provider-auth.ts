import { createHash, randomBytes, randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type pg from 'pg'

export const PROVIDER_TOKEN_AUDIENCE = 'relay-extension-api'
export const PROVIDER_TOKEN_TTL_SECONDS = 900

export interface ProviderExtensionTokenPayload {
  providerId: string
  credentialId: string
  tokenJti: string
}

/**
 * ADR-0003 authorization chain 1: first-party providers exchange client
 * credentials for a short-lived token with its own audience, signed by an
 * EXTENSION_PROVIDER_JWT_SECRET that is deliberately separate from the user
 * JWT_SECRET. Algorithms are pinned to HS256 on both sides.
 */
export function signProviderExtensionToken(input: {
  providerId: string
  credentialId: string
  secret: string
  issuer: string
  ttlSeconds?: number
  jti?: string
}): string {
  const ttl = Math.min(Math.max(1, input.ttlSeconds ?? PROVIDER_TOKEN_TTL_SECONDS), PROVIDER_TOKEN_TTL_SECONDS)
  return jwt.sign(
    {
      sub: `provider:${input.providerId}`,
      provider_id: input.providerId,
      credential_id: input.credentialId,
      token_type: 'extension_provider',
    },
    input.secret,
    {
      algorithm: 'HS256',
      audience: PROVIDER_TOKEN_AUDIENCE,
      issuer: input.issuer,
      expiresIn: ttl,
      jwtid: input.jti ?? randomUUID(),
    },
  )
}

export function verifyProviderExtensionToken(
  token: string,
  options: { secret: string; issuer: string },
): ProviderExtensionTokenPayload | null {
  let payload: Record<string, unknown>
  try {
    payload = jwt.verify(token, options.secret, {
      algorithms: ['HS256'],
      audience: PROVIDER_TOKEN_AUDIENCE,
      issuer: options.issuer,
    }) as Record<string, unknown>
  } catch {
    return null
  }
  if (payload.token_type !== 'extension_provider') return null
  const providerId = payload.provider_id
  const credentialId = payload.credential_id
  const tokenJti = payload.jti
  if (typeof providerId !== 'string' || typeof credentialId !== 'string'
    || typeof tokenJti !== 'string' || payload.sub !== `provider:${providerId}`) {
    return null
  }
  return { providerId, credentialId, tokenJti }
}

/** Short non-reversible display fingerprint for operational reference. */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

export interface ProvisionedProviderCredential {
  credentialId: string
  clientId: string
  /** Plaintext is returned exactly once; only the digest is stored. */
  clientSecret: string
  fingerprint: string
}

/**
 * Provision a new provider credential. Rotation overlap (setting an expiry
 * on the PREVIOUS credential) is an explicit opt-in so accidental re-runs
 * never log providers out.
 */
export async function createProviderCredential(
  pool: Pick<pg.Pool, 'query'>,
  input: {
    providerId: string
    clientId?: string
    secret?: string
    rotatePreviousAfterSeconds?: number
  },
): Promise<ProvisionedProviderCredential> {
  const clientId = input.clientId ?? `pc-${randomBytes(8).toString('hex')}`
  // Callers may inject a fixed secret only in tests; production always
  // generates one and never accepts it from argv.
  const clientSecret = input.secret ?? randomBytes(32).toString('base64url')
  const credentialId = randomUUID()
  const digest = await bcrypt.hash(clientSecret, 10)
  await pool.query(
    `INSERT INTO extension_provider_credentials
       (credential_id, provider_id, client_id, secret_digest, secret_fingerprint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_id, client_id) DO UPDATE SET
       secret_digest = EXCLUDED.secret_digest,
       secret_fingerprint = EXCLUDED.secret_fingerprint,
       status = 'active', expires_at = NULL, revoked_at = NULL`,
    [credentialId, input.providerId, clientId, digest, secretFingerprint(clientSecret)],
  )
  if (input.rotatePreviousAfterSeconds && input.rotatePreviousAfterSeconds > 0) {
    await pool.query(
      `UPDATE extension_provider_credentials
       SET expires_at = NOW() + ($3 * INTERVAL '1 second')
       WHERE provider_id = $1 AND client_id <> $2 AND status = 'active'
         AND expires_at IS NULL`,
      [input.providerId, clientId, input.rotatePreviousAfterSeconds],
    )
  }
  return {
    credentialId,
    clientId,
    clientSecret,
    fingerprint: secretFingerprint(clientSecret),
  }
}

/**
 * Authenticate provider client credentials. Every failure — unknown provider,
 * disabled provider, unknown client, revoked or expired credential, wrong
 * secret — resolves to the same null so the endpoint cannot enumerate.
 */
export async function authenticateProviderCredentials(
  pool: Pick<pg.Pool, 'query'>,
  input: { providerId: string; clientId: string; clientSecret: string },
): Promise<ProviderExtensionTokenPayload | null> {
  const result = await pool.query<{
    credential_id: string
    provider_id: string
    secret_digest: string
    status: string
    expires_at: Date | null
    provider_status: string
  }>(`
    SELECT c.credential_id, c.provider_id, c.secret_digest, c.status,
           c.expires_at, p.status AS provider_status
    FROM extension_provider_credentials c
    JOIN extension_providers p ON p.provider_id = c.provider_id
    WHERE c.provider_id = $1 AND c.client_id = $2
  `, [input.providerId, input.clientId])
  const row = result.rows[0]
  if (!row) return null
  if (row.provider_status !== 'enabled') return null
  if (row.status !== 'active') return null
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null
  const matched = await bcrypt.compare(input.clientSecret, row.secret_digest)
  if (!matched) return null
  return {
    providerId: row.provider_id,
    credentialId: row.credential_id,
    tokenJti: randomUUID(),
  }
}
