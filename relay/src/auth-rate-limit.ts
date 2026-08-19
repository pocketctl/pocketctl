import { createHmac } from 'node:crypto'
import type pg from 'pg'
import { hitAuthRateLimit } from './db.js'

/**
 * M-2: PostgreSQL-backed, cross-instance HTTP authentication rate limiting.
 *
 * Reuses the `auth_rate_limits` atomic fixed-window counters introduced by the
 * High H-1 hardening — this module only adds the policy layer: per-IP and
 * per-identity buckets, HMAC-fingerprinted storage keys (no plaintext email,
 * IP, device code, user code or token ever reaches the database), strict
 * positive-integer budgets parsed at startup, and fail-closed behavior when
 * the counter backend is unavailable (creation/verification endpoints answer
 * 503 instead of silently allowing the request).
 */

export interface AuthRateLimitHitDecision {
  allowed: boolean
  retryAfterMs: number
  count: number
}

export type HitAuthRateLimitFn = (
  pool: pg.Pool,
  params: { limitKey: string; limit: number; windowMs: number; now: Date },
) => Promise<AuthRateLimitHitDecision>

export type AuthRateLimitEnforceDecision =
  | { ok: true }
  | { ok: false; status: 429; retryAfterMs: number }
  | { ok: false; status: 503 }

export interface AuthRateLimitBucketSpec {
  scope: string
  windowMs: number
  ip?: { value: string; limit: number }
  identity?: { value: string; limit: number }
}

/** Domain-separated HMAC fingerprint: the only thing persisted per subject. */
export function authRateLimitKey(pepper: string, scope: string, kind: 'ip' | 'identity', subject: string): string {
  return createHmac('sha256', pepper)
    .update(`auth-rate-limit:v1:${scope}:${kind}:${subject}`)
    .digest('hex')
}

export interface AuthRateLimiter {
  enforce(
    pool: pg.Pool,
    spec: AuthRateLimitBucketSpec & { now?: Date },
  ): Promise<AuthRateLimitEnforceDecision>
}

export function createAuthRateLimiter(deps: {
  pepper: string
  hit?: HitAuthRateLimitFn
}): AuthRateLimiter {
  const hit = deps.hit ?? hitAuthRateLimit
  const pepper = deps.pepper
  return {
    async enforce(pool, spec) {
      if (!spec.ip && !spec.identity) {
        throw new Error('auth rate limit spec needs at least one bucket')
      }
      const now = spec.now ?? new Date()
      const buckets = [
        ...(spec.ip ? [{ kind: 'ip' as const, subject: spec.ip.value, limit: spec.ip.limit }] : []),
        ...(spec.identity ? [{ kind: 'identity' as const, subject: spec.identity.value, limit: spec.identity.limit }] : []),
      ]
      for (const bucket of buckets) {
        let decision: AuthRateLimitHitDecision
        try {
          decision = await hit(pool, {
            limitKey: authRateLimitKey(pepper, spec.scope, bucket.kind, bucket.subject),
            limit: bucket.limit,
            windowMs: spec.windowMs,
            now,
          })
        } catch (error) {
          // Fail closed: a broken counter backend must not open the auth
          // endpoint. Log the error class only — never the subject.
          console.error(
            `[auth-rate-limit] backend error scope=${spec.scope} kind=${bucket.kind}:`,
            error instanceof Error ? error.name : typeof error,
          )
          return { ok: false, status: 503 }
        }
        if (!decision.allowed) {
          return { ok: false, status: 429, retryAfterMs: decision.retryAfterMs }
        }
      }
      return { ok: true }
    },
  }
}

/**
 * Apply a limiter decision to a Fastify reply. Returns true when the request
 * was rejected (the caller must return immediately); the 429 body carries no
 * information about which bucket tripped or whether the target exists.
 */
export function applyAuthRateLimitDecision(
  reply: { code(c: number): unknown; header(n: string, v: unknown): unknown },
  decision: AuthRateLimitEnforceDecision,
): boolean {
  if (decision.ok) return false
  if (decision.status === 429) {
    reply.header('Retry-After', Math.max(1, Math.ceil(decision.retryAfterMs / 1000)))
    reply.code(429)
  } else {
    reply.code(503)
  }
  return true
}
