/**
 * Shared fixed-window limiter for the extension control plane. Keys combine
 * an endpoint scope with the remote address. The window state is
 * process-local: a deployment of N Relay instances yields an aggregate
 * budget of roughly N x max-per-window, so operators needing exact global
 * budgets scale the env knobs down accordingly (see the operations runbook's
 * rate-limit section). The provider token endpoint additionally keeps its
 * own limiter; the shared PostgreSQL auth limiter guards the front door.
 */
export interface ExtensionRateLimiter {
  check(key: string): { allowed: boolean; retryAfterMs?: number }
}

export interface ExtensionRateLimitPolicies {
  token: number
  feed: number
  ack: number
  snapshot: number
  status: number
  usage: number
  purge: number
  grant: number
  installations: number
}

export const DEFAULT_EXTENSION_RATE_LIMITS: ExtensionRateLimitPolicies = {
  token: 30,
  feed: 120,
  ack: 240,
  snapshot: 60,
  status: 120,
  usage: 60,
  purge: 60,
  grant: 60,
  installations: 120,
}

export const EXTENSION_RATE_LIMIT_WINDOW_MS = 60_000

export function createExtensionRateLimiter(options: {
  windowMs?: number
  maxPerWindow: number
  now?: () => number
}): ExtensionRateLimiter {
  const windowMs = options.windowMs ?? EXTENSION_RATE_LIMIT_WINDOW_MS
  const max = Math.max(1, Math.trunc(options.maxPerWindow))
  const now = options.now ?? (() => Date.now())
  let windows = new Map<string, { startedAt: number; count: number }>()
  return {
    check(key: string) {
      if (typeof key !== 'string' || key.length > 256) key = 'unknown'
      const timestamp = now()
      // Bounded memory: rebuild whenever the map grows past a hard cap.
      if (windows.size > 10_000) windows = new Map()
      const current = windows.get(key)
      if (!current || timestamp - current.startedAt >= windowMs) {
        windows.set(key, { startedAt: timestamp, count: 1 })
        return { allowed: true }
      }
      current.count++
      if (current.count > max) {
        return { allowed: false, retryAfterMs: windowMs - (timestamp - current.startedAt) }
      }
      return { allowed: true }
    },
  }
}

export function createExtensionRateLimiterSet(policies: ExtensionRateLimitPolicies) {
  return {
    token: createExtensionRateLimiter({ maxPerWindow: policies.token }),
    feed: createExtensionRateLimiter({ maxPerWindow: policies.feed }),
    ack: createExtensionRateLimiter({ maxPerWindow: policies.ack }),
    snapshot: createExtensionRateLimiter({ maxPerWindow: policies.snapshot }),
    status: createExtensionRateLimiter({ maxPerWindow: policies.status }),
    usage: createExtensionRateLimiter({ maxPerWindow: policies.usage }),
    purge: createExtensionRateLimiter({ maxPerWindow: policies.purge }),
    grant: createExtensionRateLimiter({ maxPerWindow: policies.grant }),
    installations: createExtensionRateLimiter({ maxPerWindow: policies.installations }),
  }
}

/** Reply payload for a denied request; fail closed, never partial data. */
export function rateLimitedResponse(retryAfterMs?: number): {
  status: number
  body: { error: { code: string; message: string } }
  retryAfterSeconds?: number
} {
  return {
    status: 429,
    body: { error: { code: 'invalid_request', message: 'rate limit exceeded' } },
    ...(retryAfterMs !== undefined
      ? { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }
      : {}),
  }
}
