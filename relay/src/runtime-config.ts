import { isIP } from 'node:net'

export function resolveCorsOrigin(
  nodeEnv: string,
  allowedOrigins: string[],
): string[] | true {
  const normalized = allowedOrigins
    .map(origin => origin.trim())
    .filter(Boolean)

  if (normalized.length > 0) return normalized
  if (nodeEnv === 'production') {
    throw new Error('ALLOWED_ORIGINS is required in production')
  }
  return true
}

export function resolvePublicIssuer(
  nodeEnv: string,
  configuredUrl: string | undefined,
  fallback: string,
): string {
  const raw = configuredUrl?.trim() || (nodeEnv === 'production' ? '' : fallback)
  if (!raw) {
    throw new Error('PUBLIC_ISSUER_URL is required in production')
  }

  const url = new URL(raw)
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_ISSUER_URL must use HTTPS in production')
  }

  return url.toString().replace(/\/$/, '')
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv): {
  release_version: string
  git_sha: string
  build_time: string
} {
  const production = env.NODE_ENV === 'production'
  const releaseVersion = env.RELEASE_VERSION?.trim() || (production ? '' : 'dev')
  const gitSha = env.GIT_SHA?.trim() || (production ? '' : 'unknown')
  const buildTime = env.BUILD_TIME?.trim() || (production ? '' : 'unknown')

  if (!releaseVersion || (production && releaseVersion === 'dev')) {
    throw new Error('RELEASE_VERSION is required in production')
  }
  if (!gitSha || (production && gitSha === 'unknown')) {
    throw new Error('GIT_SHA is required in production')
  }
  if (!buildTime || (production && buildTime === 'unknown')) {
    throw new Error('BUILD_TIME is required in production')
  }

  return {
    release_version: releaseVersion,
    git_sha: gitSha,
    build_time: buildTime,
  }
}

const LOOPBACK_LISTEN_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function isLoopbackListenHost(host: string): boolean {
  return LOOPBACK_LISTEN_HOSTS.has(host)
}

function isValidIpOrCidr(entry: string): boolean {
  const slash = entry.indexOf('/')
  const host = slash === -1 ? entry : entry.slice(0, slash)
  const prefix = slash === -1 ? undefined : entry.slice(slash + 1)
  const version = isIP(host)
  if (version === 0) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  if (!Number.isSafeInteger(bits) || bits < 0) return false
  return bits <= (version === 4 ? 32 : 128)
}

/**
 * M-1: the relay only honors forwarding headers from explicitly listed
 * reverse-proxy addresses. The returned value feeds Fastify's trustProxy
 * directly (false | string[]), so an untrusted TCP peer can never move a
 * spoofed X-Forwarded-For into req.ip.
 */
export function resolveTrustedProxyConfig(env: NodeJS.ProcessEnv): false | string[] {
  const production = env.NODE_ENV === 'production'

  if (env.TRUST_PROXY === 'true') {
    if (production) {
      throw new Error(
        'TRUST_PROXY=true trusts every peer and is rejected in production; set TRUSTED_PROXY_CIDRS to the reverse-proxy addresses (e.g. 127.0.0.1/8,::1/128)',
      )
    }
    console.warn(
      '[config] TRUST_PROXY=true is deprecated and ignored; configure TRUSTED_PROXY_CIDRS with explicit reverse-proxy addresses',
    )
  }

  const raw = env.TRUSTED_PROXY_CIDRS?.trim()
  const entries = (raw ?? '')
    .split(',')
    .map(entry => entry.trim().replace(/^\[|\]$/g, ''))
    .filter(Boolean)

  if (entries.length === 0) {
    if (production && !isLoopbackListenHost(resolveRelayListenHost(env))) {
      throw new Error(
        'TRUSTED_PROXY_CIDRS is required in production when RELAY_HOST is a non-loopback address; a publicly reachable listener must declare which reverse proxy may set forwarding headers',
      )
    }
    return false
  }

  for (const entry of entries) {
    if (!isValidIpOrCidr(entry)) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains an invalid IP or CIDR: ${entry}`)
    }
  }
  return entries
}

/** M-1: explicit listen address; production topologies set 127.0.0.1 behind a proxy. */
export function resolveRelayListenHost(env: NodeJS.ProcessEnv): string {
  return env.RELAY_HOST?.trim() || '0.0.0.0'
}

export function strictPositiveConfig(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive decimal integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive decimal integer`)
  }
  return value
}

export interface AuthRateLimitPolicyConfig {
  register: { ipMax: number; identityMax: number }
  login: { ipMax: number; identityMax: number }
  apple: { ipMax: number }
  emailSend: { ipMax: number; emailMax: number }
  emailVerify: { ipMax: number }
  bindSend: { ipMax: number; emailMax: number }
  bindVerify: { ipMax: number }
  deviceAuthorize: { perMinute: number; perHour: number }
  qrCreate: { perMinute: number; perHour: number }
  poll: { ipMax: number }
  confirm: { userMax: number; ipMax: number }
  tokenOps: { tokenMax: number; ipMax: number }
  wsTicket: { userMax: number; ipMax: number }
}

/**
 * M-2: endpoint policy budgets. Every value is adjustable through strict
 * positive-decimal-integer environment variables; any malformed value fails
 * startup (in production and development alike) rather than silently
 * disabling a limit. Windows are fixed in code alongside each policy family.
 */
export function resolveAuthRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): AuthRateLimitPolicyConfig {
  const s = strictPositiveConfig
  return {
    register: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_REGISTER_IP_MAX', 10),
      identityMax: s(env, 'AUTH_RATE_LIMIT_REGISTER_IDENTITY_MAX', 5),
    },
    login: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_LOGIN_IP_MAX', 10),
      identityMax: s(env, 'AUTH_RATE_LIMIT_LOGIN_IDENTITY_MAX', 5),
    },
    apple: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_APPLE_IP_MAX', 10),
    },
    emailSend: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_EMAIL_SEND_IP_MAX', 10),
      emailMax: s(env, 'AUTH_RATE_LIMIT_EMAIL_SEND_EMAIL_MAX', 5),
    },
    emailVerify: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_EMAIL_VERIFY_IP_MAX', 30),
    },
    bindSend: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_BIND_SEND_IP_MAX', 10),
      emailMax: s(env, 'AUTH_RATE_LIMIT_BIND_SEND_EMAIL_MAX', 5),
    },
    bindVerify: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_BIND_VERIFY_IP_MAX', 30),
    },
    deviceAuthorize: {
      perMinute: s(env, 'AUTH_RATE_LIMIT_DEVICE_AUTHORIZE_PER_MINUTE', 10),
      perHour: s(env, 'AUTH_RATE_LIMIT_DEVICE_AUTHORIZE_PER_HOUR', 100),
    },
    qrCreate: {
      perMinute: s(env, 'AUTH_RATE_LIMIT_QR_CREATE_PER_MINUTE', 10),
      perHour: s(env, 'AUTH_RATE_LIMIT_QR_CREATE_PER_HOUR', 100),
    },
    poll: {
      ipMax: s(env, 'AUTH_RATE_LIMIT_POLL_IP_MAX', 120),
    },
    confirm: {
      userMax: s(env, 'AUTH_RATE_LIMIT_CONFIRM_USER_MAX', 10),
      ipMax: s(env, 'AUTH_RATE_LIMIT_CONFIRM_IP_MAX', 30),
    },
    tokenOps: {
      tokenMax: s(env, 'AUTH_RATE_LIMIT_TOKEN_OPS_TOKEN_MAX', 30),
      ipMax: s(env, 'AUTH_RATE_LIMIT_TOKEN_OPS_IP_MAX', 120),
    },
    wsTicket: {
      userMax: s(env, 'AUTH_RATE_LIMIT_WS_TICKET_USER_MAX', 30),
      ipMax: s(env, 'AUTH_RATE_LIMIT_WS_TICKET_IP_MAX', 120),
    },
  }
}

/**
 * ADR-0003 grant key material resolution lives in extensions/capability-grant.ts
 * (resolveGrantKeyMaterial); re-exported here so the startup validation chain
 * has a single runtime-config surface.
 */
export { resolveGrantKeyMaterial } from './extensions/capability-grant.js'
import {
  DEFAULT_EXTENSION_RATE_LIMITS,
  type ExtensionRateLimitPolicies,
} from './extensions/rate-limit.js'

/**
 * ADR-0003 extension control-plane rate budgets. Every value is strictly
 * parsed as a positive decimal integer; malformed values fail startup in
 * every environment rather than silently disabling a limit.
 */
export function resolveExtensionRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): ExtensionRateLimitPolicies {
  const entries: Array<[keyof ExtensionRateLimitPolicies, string]> = [
    ['token', 'RELAY_EXTENSION_RATE_LIMIT_TOKEN'],
    ['feed', 'RELAY_EXTENSION_RATE_LIMIT_FEED'],
    ['ack', 'RELAY_EXTENSION_RATE_LIMIT_ACK'],
    ['snapshot', 'RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT'],
    ['status', 'RELAY_EXTENSION_RATE_LIMIT_STATUS'],
    ['usage', 'RELAY_EXTENSION_RATE_LIMIT_USAGE'],
    ['purge', 'RELAY_EXTENSION_RATE_LIMIT_PURGE'],
    ['grant', 'RELAY_EXTENSION_RATE_LIMIT_GRANT'],
    ['installations', 'RELAY_EXTENSION_RATE_LIMIT_INSTALLATIONS'],
  ]
  const resolved: ExtensionRateLimitPolicies = { ...DEFAULT_EXTENSION_RATE_LIMITS }
  for (const [key, name] of entries) {
    const raw = env[name]
    if (raw === undefined) continue
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`${name} must be a positive decimal integer`)
    }
    resolved[key] = Number(raw)
  }
  return resolved
}

const DEV_ONLY_PEPPER = 'dev-only-insecure-email-pepper-do-not-use-in-prod'

export interface EmailVerificationConfig {
  pepper: string
  devShortcutEnabled: boolean
  devEmail: string | null
  devCode: string | null
}

/**
 * Email-verification startup contract: production must provide an explicit
 * pepper of sufficient entropy and must never carry a DEV backdoor variable;
 * outside production the DEV shortcut only activates when both DEV_EMAIL and
 * a 6-digit DEV_EMAIL_CODE are configured.
 */
export function resolveEmailVerificationConfig(env: NodeJS.ProcessEnv): EmailVerificationConfig {
  const production = env.NODE_ENV === 'production'
  const devEmail = env.DEV_EMAIL?.trim() ?? ''
  const devCode = env.DEV_EMAIL_CODE?.trim() ?? ''

  if (production && (devEmail || devCode)) {
    throw new Error('DEV_EMAIL/DEV_EMAIL_CODE must not be set in production')
  }
  if (devEmail || devCode) {
    if (!devEmail || !/^\d{6}$/.test(devCode)) {
      throw new Error('DEV_EMAIL and a 6-digit DEV_EMAIL_CODE must be configured together')
    }
  }

  const pepper = env.AUTH_CODE_PEPPER?.trim() ?? ''
  if (production) {
    if (!pepper) {
      throw new Error('AUTH_CODE_PEPPER is required in production')
    }
    if (pepper.length < 32) {
      throw new Error('AUTH_CODE_PEPPER must be at least 32 characters')
    }
  }

  return {
    pepper: pepper || DEV_ONLY_PEPPER,
    devShortcutEnabled: !production && Boolean(devEmail && devCode),
    devEmail: devEmail || null,
    devCode: devCode || null,
  }
}
