import { isExtensionMode, type ExtensionMode } from './types.js'
import { EXTENSION_PROVIDER_CATALOG } from './catalog.js'

export interface ExtensionConfig {
  readonly mode: ExtensionMode
  /** Projector batch size, 1..500 rows per transaction. */
  readonly projectorBatchSize: number
  /** extension_feed retention, 1..90 days. */
  readonly feedRetentionDays: number
  /** Feed pull lease TTL, 10..300 seconds. */
  readonly leaseTtlSeconds: number
  /** Provider token signing secret (EXTENSION_PROVIDER_JWT_SECRET). */
  readonly providerJwtSecret: string
  /** Cursor HMAC secret (EXTENSION_CURSOR_SECRET). */
  readonly cursorSecret: string
  /** Capability grant RS256 private key PEM (EXTENSION_GRANT_PRIVATE_KEY). */
  readonly grantPrivateKey: string
  /**
   * Operator-owned provider public origins
   * (EXTENSION_PROVIDER_PUBLIC_ORIGINS), keyed by catalog provider id.
   */
  readonly providerPublicOrigins: ReadonlyMap<string, string>
}

const SECRET_MIN_LENGTH = 32

/** Decode multiline key material stored as canonical base64 in EnvironmentFile. */
export function extensionTextSecret(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const raw = env[name]?.trim() ?? ''
  const encodedName = `${name}_B64`
  const encoded = env[encodedName]?.trim() ?? ''
  if (raw && encoded) throw new Error(`${name} and ${encodedName} cannot both be configured`)
  if (!encoded) return raw
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${encodedName} must be canonical base64`)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) {
    throw new Error(`${encodedName} must be canonical base64`)
  }
  return decoded.toString('utf8').trim()
}

function boundedEnvInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]
  let value: number
  if (raw === undefined) {
    value = fallback
  } else {
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error(`${name} must be a decimal integer between ${min} and ${max}`)
    }
    value = Number(raw)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name} must be a decimal integer between ${min} and ${max}`)
    }
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return value
}

function requireSecret(
  env: Record<string, string | undefined>,
  name: string,
  required: boolean,
): string {
  const value = extensionTextSecret(env, name)
  if (!value) {
    if (required) throw new Error(`${name} is required when RELAY_EXTENSIONS=enabled in production`)
    return ''
  }
  if (value.length < SECRET_MIN_LENGTH) {
    throw new Error(`${name} must be at least ${SECRET_MIN_LENGTH} characters`)
  }
  return value
}

/**
 * Lightweight mode reader for call sites (journal sink, projector) that only
 * need off|shadow|enabled. Full numeric/key validation stays in
 * resolveExtensionConfig, which startup already runs; an invalid value here
 * still throws rather than silently degrading to off.
 */
export function extensionModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): ExtensionMode {
  const rawMode = env.RELAY_EXTENSIONS?.trim() ?? ''
  if (!rawMode) return 'off'
  if (!isExtensionMode(rawMode)) {
    throw new Error(`invalid RELAY_EXTENSIONS value: ${rawMode} (expected off | shadow | enabled)`)
  }
  return rawMode
}

export const EXTENSION_PROVIDER_PUBLIC_ORIGINS_ENV = 'EXTENSION_PROVIDER_PUBLIC_ORIGINS'

/**
 * Parse the operator-owned JSON map of provider public origins, e.g.
 * `{"pocketctl-memory": "https://memory.example"}`. Origins are trusted
 * operator configuration: they are the only source of provider origins and
 * must be bare https origins in production — no credentials, paths or
 * queries, no providers outside the code-owned catalog, no duplicate keys.
 */
export function parseProviderPublicOrigins(
  raw: string | undefined,
  options: { allowedProviders: readonly string[]; requireHttps: boolean },
): ReadonlyMap<string, string> {
  const text = raw?.trim() ?? ''
  if (!text) return new Map()
  const invalid = (reason: string): never => {
    throw new Error(`${EXTENSION_PROVIDER_PUBLIC_ORIGINS_ENV} ${reason}`)
  }
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    invalid('must be a JSON object mapping provider ids to origins')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid('must be a JSON object mapping provider ids to origins')
  }
  // JSON.parse silently keeps the last duplicate key; detect them on the raw
  // text (keys and origins in this map cannot contain escaped quotes).
  const keyTokens = [...text.matchAll(/"([^"\\]+)"\s*:/g)].map(match => match[1])
  if (new Set(keyTokens).size !== keyTokens.length) {
    invalid('contains duplicate provider keys')
  }
  const origins = new Map<string, string>()
  for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!options.allowedProviders.includes(providerId)) {
      return invalid(`contains an unknown provider id`)
    }
    if (typeof value !== 'string' || value.length === 0) {
      return invalid(`origin for a provider must be a non-empty string`)
    }
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`${EXTENSION_PROVIDER_PUBLIC_ORIGINS_ENV} origin for a provider must be an absolute URL`)
    }
    if (url.protocol !== 'https:') {
      if (options.requireHttps || url.protocol !== 'http:') {
        invalid('origins must use HTTPS' + (options.requireHttps ? ' in production' : ''))
      }
    }
    if (url.username || url.password) {
      invalid('origins must not carry credentials')
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      invalid('origins must be a bare scheme://host[:port] origin')
    }
    origins.set(providerId, url.origin)
  }
  return origins
}

/**
 * Resolve the extension platform feature configuration. Production must set
 * RELAY_EXTENSIONS explicitly; every numeric knob is strictly parsed and
 * bounded; enabled-in-production additionally requires the three provider
 * key materials (provider JWT secret, cursor secret, grant private key) so a
 * misconfigured rollout fails startup instead of degrading to the shared
 * user JWT secret.
 */
export function resolveExtensionConfig(
  env: Record<string, string | undefined> = process.env,
): ExtensionConfig {
  const production = env.NODE_ENV === 'production'
  const rawMode = env.RELAY_EXTENSIONS?.trim() ?? ''
  let mode: ExtensionMode = 'off'
  if (!rawMode) {
    if (production) {
      throw new Error('RELAY_EXTENSIONS is required in production (off | shadow | enabled)')
    }
  } else if (!isExtensionMode(rawMode)) {
    throw new Error(`invalid RELAY_EXTENSIONS value: ${rawMode} (expected off | shadow | enabled)`)
  } else {
    mode = rawMode
  }

  const needProviderKeys = production && mode === 'enabled'
  const providerJwtSecret = requireSecret(env, 'EXTENSION_PROVIDER_JWT_SECRET', needProviderKeys)
  const cursorSecret = requireSecret(env, 'EXTENSION_CURSOR_SECRET', needProviderKeys)
  const grantPrivateKey = requireSecret(env, 'EXTENSION_GRANT_PRIVATE_KEY', needProviderKeys)

  const providerPublicOrigins = parseProviderPublicOrigins(
    env[EXTENSION_PROVIDER_PUBLIC_ORIGINS_ENV],
    {
      allowedProviders: EXTENSION_PROVIDER_CATALOG.map(entry => entry.provider_id),
      requireHttps: production,
    },
  )
  if (needProviderKeys) {
    for (const manifest of EXTENSION_PROVIDER_CATALOG) {
      if (!providerPublicOrigins.has(manifest.provider_id)) {
        throw new Error(
          `${EXTENSION_PROVIDER_PUBLIC_ORIGINS_ENV} must configure ${manifest.provider_id} when RELAY_EXTENSIONS=enabled in production`,
        )
      }
    }
  }

  return Object.freeze({
    mode,
    projectorBatchSize: boundedEnvInt(env, 'RELAY_EXTENSION_PROJECTOR_BATCH', 200, 1, 500),
    feedRetentionDays: boundedEnvInt(env, 'RELAY_EXTENSION_FEED_RETENTION_DAYS', 7, 1, 90),
    leaseTtlSeconds: boundedEnvInt(env, 'RELAY_EXTENSION_LEASE_TTL_SECONDS', 60, 10, 300),
    providerJwtSecret,
    cursorSecret,
    grantPrivateKey,
    providerPublicOrigins,
  })
}
