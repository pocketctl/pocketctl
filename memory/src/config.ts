/**
 * Strict environment parsing for the pocketctl-memory service. Every value is
 * validated at startup: production must fail fast on missing infrastructure
 * configuration, and error messages must never echo secret values.
 */

export type MemoryMode = 'off' | 'shadow' | 'enabled'
export type MemoryLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type MemoryMetricsBind = 'loopback' | 'all'

export const MEMORY_PROVIDER_ID = 'pocketctl-memory' as const

/** Model adapter settings; presence means the adapter is configured/ready. */
export interface ModelAdapterSettings {
  provider: 'openai-compatible'
  baseUrl: string
  model: string
  apiKey: string
  pricingConfigured: boolean
  inputCostMicrosPerMillionTokens: number
  outputCostMicrosPerMillionTokens: number
}

export interface EmbeddingAdapterSettings extends ModelAdapterSettings {
  dimensions: number
}

export interface TombstoneHmacKey {
  version: string
  key: string
}

export interface MemoryConfig {
  mode: MemoryMode
  port: number
  metricsPort: number
  metricsBind: MemoryMetricsBind
  databaseUrl: string
  dbPoolMax: number
  relayUrl: string
  relayIssuer: string
  providerId: typeof MEMORY_PROVIDER_ID
  providerVersion: string
  providerClientId: string
  providerClientSecret: string
  workerId: string
  pollIntervalMs: number
  httpTimeoutMs: number
  jobLeaseMs: number
  episodeStabilizationMs: number
  hmacKey: string
  logLevel: MemoryLogLevel
  isProduction: boolean
  textModel: ModelAdapterSettings | undefined
  embeddingModel: EmbeddingAdapterSettings | undefined
  modelTimeoutMs: number
  recallEmbeddingTimeoutMs: number
  extractionMaxChars: number
  allowedOrigins: readonly string[]
  allowedHosts: readonly string[]
  tombstoneHmacKeys: readonly TombstoneHmacKey[]
}

const MODES: readonly MemoryMode[] = ['off', 'shadow', 'enabled']
const LOG_LEVELS: readonly MemoryLogLevel[] = ['debug', 'info', 'warn', 'error']
const METRICS_BINDS: readonly MemoryMetricsBind[] = ['loopback', 'all']
const MIN_HMAC_KEY_BYTES = 32
const MAX_WORKER_ID_LENGTH = 64

class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function parseEnum<T extends string>(envName: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  // Only an absent variable falls back; an explicitly empty value is a
  // configuration error rather than a silent default.
  const value = raw === undefined ? fallback : raw
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${envName} must be one of ${allowed.join('|')}`)
  }
  return value as T
}

function parseBoundedInteger(
  envName: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ConfigError(`${envName} must be an integer`)
  }
  const value = Number(raw)
  if (value < min || value > max) {
    throw new ConfigError(`${envName} must be between ${min} and ${max}`)
  }
  return value
}

/**
 * Normalize a relay origin: only http/https, no credentials, no path/query.
 * Deriving anything from a request Host is forbidden; url and issuer are
 * validated independently.
 */
function parseHttpOrigin(envName: string, raw: string | undefined): string {
  if (raw === undefined || raw === '') return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${envName} must be a valid http(s) origin`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${envName} must use http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${envName} must not embed credentials`)
  }
  return `${url.protocol}//${url.host}`
}

/**
 * Parse a model API base URL: http(s), no credentials, no query/fragment.
 * Unlike relay origins a bounded path is allowed (`.../v1`).
 */
function parseModelBaseUrl(envName: string, raw: string | undefined): string {
  let url: URL
  try {
    url = new URL(raw ?? '')
  } catch {
    throw new ConfigError(`${envName} must be a valid http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${envName} must use http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${envName} must not embed credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${envName} must not carry a query or fragment`)
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Model adapter groups are all-or-nothing: a configured provider requires
 * every member variable, and production may omit the group entirely (feature
 * modes default to off). Error messages name variables, never values.
 */
function parseModelAdapter(env: Record<string, string | undefined>, prefix: 'MEMORY_TEXT' | 'MEMORY_EMBEDDING'): ModelAdapterSettings | undefined {
  const provider = env[`${prefix}_PROVIDER`]
  if (provider === undefined || provider === '') return undefined
  if (provider !== 'openai-compatible') {
    throw new ConfigError(`${prefix}_PROVIDER must be openai-compatible`)
  }
  const baseUrl = env[`${prefix}_BASE_URL`]
  if (baseUrl === undefined || baseUrl === '') throw new ConfigError(`${prefix}_BASE_URL is required when ${prefix}_PROVIDER is configured`)
  const model = env[`${prefix}_MODEL`]
  if (model === undefined || model === '') throw new ConfigError(`${prefix}_MODEL is required when ${prefix}_PROVIDER is configured`)
  const apiKey = env[`${prefix}_API_KEY`]
  if (apiKey === undefined || apiKey === '') throw new ConfigError(`${prefix}_API_KEY is required when ${prefix}_PROVIDER is configured`)
  if (model.length > 128) throw new ConfigError(`${prefix}_MODEL must be at most 128 characters`)
  const inputPrice = env[`${prefix}_INPUT_COST_MICROS_PER_MILLION_TOKENS`]
  const outputPrice = env[`${prefix}_OUTPUT_COST_MICROS_PER_MILLION_TOKENS`]
  return {
    provider: 'openai-compatible',
    baseUrl: parseModelBaseUrl(`${prefix}_BASE_URL`, baseUrl),
    model,
    apiKey,
    pricingConfigured: inputPrice !== undefined && inputPrice !== ''
      && outputPrice !== undefined && outputPrice !== '',
    inputCostMicrosPerMillionTokens: parseBoundedInteger(
      `${prefix}_INPUT_COST_MICROS_PER_MILLION_TOKENS`,
      inputPrice, 0, 0, 1_000_000_000_000,
    ),
    outputCostMicrosPerMillionTokens: parseBoundedInteger(
      `${prefix}_OUTPUT_COST_MICROS_PER_MILLION_TOKENS`,
      outputPrice, 0, 0, 1_000_000_000_000,
    ),
  }
}

function parseStringList(envName: string, raw: string | undefined, max: number): string[] {
  if (raw === undefined || raw.trim() === '') return []
  const items = raw.split(',').map(item => item.trim()).filter(item => item.length > 0)
  if (items.length === 0 || items.length > max) {
    throw new ConfigError(`${envName} must be a comma-separated list of at most ${max} entries`)
  }
  return items
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  const items = parseStringList('MEMORY_ALLOWED_ORIGINS', raw, 32)
  for (const item of items) {
    let url: URL
    try {
      url = new URL(item)
    } catch {
      throw new ConfigError(`MEMORY_ALLOWED_ORIGINS entries must be absolute origins`)
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:')
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw new ConfigError(`MEMORY_ALLOWED_ORIGINS entries must be bare http(s) origins`)
    }
  }
  return [...new Set(items.map(item => new URL(item).origin))]
}

function parseAllowedHosts(raw: string | undefined): string[] {
  const items = parseStringList('MEMORY_ALLOWED_HOSTS', raw, 32)
  for (const item of items) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/i.test(item)) {
      throw new ConfigError('MEMORY_ALLOWED_HOSTS entries must be host names with an optional port')
    }
  }
  return [...new Set(items.map(item => item.toLowerCase()))]
}

function parseTombstoneHmacKeys(raw: string | undefined): TombstoneHmacKey[] {
  if (raw === undefined || raw.trim() === '') return []
  const entries = raw.split(',').map(item => item.trim()).filter(item => item.length > 0)
  if (entries.length === 0 || entries.length > 16) {
    throw new ConfigError('MEMORY_TOMBSTONE_HMAC_KEYS must be a comma-separated list of at most 16 entries')
  }
  const keys: TombstoneHmacKey[] = []
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    const version = separator === -1 ? '' : entry.slice(0, separator)
    const key = separator === -1 ? '' : entry.slice(separator + 1)
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(version)) {
      throw new ConfigError('MEMORY_TOMBSTONE_HMAC_KEYS entries must be version=key')
    }
    if (Buffer.byteLength(key, 'utf8') < 32) {
      throw new ConfigError('MEMORY_TOMBSTONE_HMAC_KEYS keys must be at least 32 bytes')
    }
    if (keys.some(existing => existing.version === version)) {
      throw new ConfigError('MEMORY_TOMBSTONE_HMAC_KEYS versions must be unique')
    }
    keys.push({ version, key })
  }
  return keys
}

export function loadMemoryConfig(env: Record<string, string | undefined> = process.env): MemoryConfig {
  const isProduction = env.NODE_ENV === 'production'

  const mode = parseEnum('MEMORY_MODE', env.MEMORY_MODE, MODES, 'enabled')
  const logLevel = parseEnum('MEMORY_LOG_LEVEL', env.MEMORY_LOG_LEVEL, LOG_LEVELS, 'info')

  const databaseUrl = env.MEMORY_DATABASE_URL ?? ''
  const relayUrl = parseHttpOrigin('MEMORY_RELAY_URL', env.MEMORY_RELAY_URL)
  const relayIssuer = parseHttpOrigin('MEMORY_RELAY_ISSUER', env.MEMORY_RELAY_ISSUER)

  if (env.MEMORY_PROVIDER_ID !== undefined
    && env.MEMORY_PROVIDER_ID !== MEMORY_PROVIDER_ID) {
    throw new ConfigError('MEMORY_PROVIDER_ID must be pocketctl-memory')
  }

  const providerClientId = env.MEMORY_PROVIDER_CLIENT_ID ?? ''
  const providerClientSecret = env.MEMORY_PROVIDER_CLIENT_SECRET ?? ''
  const hmacKey = env.MEMORY_HMAC_KEY ?? ''

  const workerIdRaw = env.MEMORY_WORKER_ID ?? 'memory-worker-1'
  if (workerIdRaw.length === 0 || workerIdRaw.length > MAX_WORKER_ID_LENGTH) {
    throw new ConfigError(`MEMORY_WORKER_ID must be 1..${MAX_WORKER_ID_LENGTH} characters`)
  }

  if (hmacKey !== '' && Buffer.byteLength(hmacKey, 'utf8') < MIN_HMAC_KEY_BYTES) {
    throw new ConfigError(`MEMORY_HMAC_KEY must be at least ${MIN_HMAC_KEY_BYTES} bytes`)
  }

  if (isProduction) {
    // Production fails closed on missing infrastructure configuration. The
    // messages name the variable only — never the (possibly partial secret)
    // value.
    for (const [name, value] of [
      ['MEMORY_DATABASE_URL', databaseUrl],
      ['MEMORY_RELAY_URL', relayUrl],
      ['MEMORY_RELAY_ISSUER', relayIssuer],
      ['MEMORY_PROVIDER_CLIENT_ID', providerClientId],
      ['MEMORY_PROVIDER_CLIENT_SECRET', providerClientSecret],
      ['MEMORY_HMAC_KEY', hmacKey],
    ] as const) {
      if (value === '') throw new ConfigError(`${name} is required in production`)
    }
  }

  const textModel = parseModelAdapter(env, 'MEMORY_TEXT')
  const embeddingModelBase = parseModelAdapter(env, 'MEMORY_EMBEDDING')
  let embeddingModel: EmbeddingAdapterSettings | undefined
  if (embeddingModelBase) {
    if (env.MEMORY_EMBEDDING_DIMENSIONS === undefined || env.MEMORY_EMBEDDING_DIMENSIONS === '') {
      throw new ConfigError('MEMORY_EMBEDDING_DIMENSIONS is required when MEMORY_EMBEDDING_PROVIDER is configured')
    }
    const dimensions = parseBoundedInteger(
      'MEMORY_EMBEDDING_DIMENSIONS', env.MEMORY_EMBEDDING_DIMENSIONS, 0, 1, 4096,
    )
    embeddingModel = { ...embeddingModelBase, dimensions }
  }
  const configuredTombstoneHmacKeys = parseTombstoneHmacKeys(env.MEMORY_TOMBSTONE_HMAC_KEYS)
  if (isProduction && mode !== 'off' && configuredTombstoneHmacKeys.length === 0) {
    throw new ConfigError('MEMORY_TOMBSTONE_HMAC_KEYS is required when MEMORY_MODE is shadow or enabled in production')
  }
  const tombstoneHmacKeys = configuredTombstoneHmacKeys.length > 0
    ? configuredTombstoneHmacKeys
    : [{ version: 'legacy', key: hmacKey }]

  return {
    mode,
    port: parseBoundedInteger('MEMORY_PORT', env.MEMORY_PORT, 8090, 1, 65535),
    metricsPort: parseBoundedInteger('MEMORY_METRICS_PORT', env.MEMORY_METRICS_PORT, 8091, 1, 65535),
    metricsBind: parseEnum('MEMORY_METRICS_BIND', env.MEMORY_METRICS_BIND, METRICS_BINDS, 'loopback'),
    databaseUrl,
    dbPoolMax: parseBoundedInteger('MEMORY_DB_POOL_MAX', env.MEMORY_DB_POOL_MAX, 12, 1, 64),
    relayUrl,
    relayIssuer,
    providerId: MEMORY_PROVIDER_ID,
    providerVersion: env.MEMORY_PROVIDER_VERSION ?? '0.1.0',
    providerClientId,
    providerClientSecret,
    workerId: workerIdRaw,
    pollIntervalMs: parseBoundedInteger('MEMORY_POLL_INTERVAL_MS', env.MEMORY_POLL_INTERVAL_MS, 1000, 100, 3_600_000),
    httpTimeoutMs: parseBoundedInteger('MEMORY_HTTP_TIMEOUT_MS', env.MEMORY_HTTP_TIMEOUT_MS, 10_000, 1000, 120_000),
    jobLeaseMs: parseBoundedInteger('MEMORY_JOB_LEASE_MS', env.MEMORY_JOB_LEASE_MS, 30_000, 1000, 600_000),
    episodeStabilizationMs: parseBoundedInteger(
      'MEMORY_EPISODE_STABILIZATION_MS', env.MEMORY_EPISODE_STABILIZATION_MS, 30_000, 0, 3_600_000,
    ),
    hmacKey,
    logLevel,
    isProduction,
    textModel,
    embeddingModel,
    modelTimeoutMs: parseBoundedInteger('MEMORY_MODEL_TIMEOUT_MS', env.MEMORY_MODEL_TIMEOUT_MS, 30_000, 1000, 300_000),
    recallEmbeddingTimeoutMs: parseBoundedInteger(
      'MEMORY_RECALL_EMBEDDING_TIMEOUT_MS', env.MEMORY_RECALL_EMBEDDING_TIMEOUT_MS, 2_000, 100, 60_000,
    ),
    extractionMaxChars: parseBoundedInteger(
      'MEMORY_EXTRACTION_MAX_CHARS', env.MEMORY_EXTRACTION_MAX_CHARS, 200_000, 10_000, 2_000_000,
    ),
    allowedOrigins: parseAllowedOrigins(env.MEMORY_ALLOWED_ORIGINS),
    allowedHosts: parseAllowedHosts(env.MEMORY_ALLOWED_HOSTS),
    tombstoneHmacKeys,
  }
}
