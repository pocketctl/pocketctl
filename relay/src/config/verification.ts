/**
 * Email verification code primitives.
 *
 * Codes are generated with a CSPRNG and are only ever persisted as an
 * HMAC-SHA-256 digest keyed by a server-side pepper. Challenge identity is
 * derived (purpose + normalized email + user scope) so raw attacker-controlled
 * strings never become storage keys. Database-backed challenge lifecycle
 * (TTL, cooldown, attempt budgets, lockout) lives in db.ts and the constants
 * below are the single source of truth for both layers.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'

/** How long a freshly issued code stays valid. */
export const CODE_TTL_MS = 60_000
/** Minimum delay between two sends for the same challenge. */
export const SEND_COOLDOWN_MS = 60_000
/** Maximum failed verifies per challenge inside the failure window. */
export const MAX_VERIFY_ATTEMPTS = 5
/** Window in which failed verifies accumulate toward the attempt budget. */
export const FAILURE_WINDOW_MS = 15 * 60_000
/** How long a challenge stays locked after exhausting the attempt budget. */
export const LOCKOUT_MS = 15 * 60_000
/** Hex length of a SHA-256 digest. */
export const CODE_HMAC_LENGTH = 64

export type EmailChallengePurpose = 'login' | 'bind_email'

/** Generate a 6-digit verification code from a CSPRNG. */
export function generateCode(): string {
  return String(randomInt(100000, 1000000))
}

/** Digest a code with the server pepper; the plaintext is never persisted. */
export function codeHmac(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code, 'utf8').digest('hex')
}

/** Stable per-challenge identity derived from purpose + email + user scope. */
export function challengeKey(
  pepper: string,
  purpose: EmailChallengePurpose,
  normalizedEmail: string,
  userId: number | null,
): string {
  return createHmac('sha256', pepper)
    .update(`${purpose}:${normalizedEmail}:${userId ?? 'anon'}`, 'utf8')
    .digest('hex')
}

/** Constant-time comparison over the fixed-length hex digest. */
export function digestEquals(presented: string, stored: string): boolean {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(stored, 'utf8')
  return left.length === CODE_HMAC_LENGTH
    && right.length === CODE_HMAC_LENGTH
    && timingSafeEqual(left, right)
}

/** Irreversible fingerprint for logs; never log raw emails or codes. */
export function emailFingerprint(normalizedEmail: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(`fingerprint:${normalizedEmail}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
}

/**
 * Shared normalization for login and email-binding flows. Rejects anything
 * that is not a basic mailbox@domain structure within RFC length bounds.
 */
export function normalizeEmailAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length < 3 || email.length > 254) return null
  if (/[\s\u0000-\u001f\u007f]/.test(email)) return null
  const at = email.indexOf('@')
  if (at <= 0 || at !== email.lastIndexOf('@')) return null
  const mailbox = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (mailbox.length === 0 || mailbox.length > 64) return null
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(mailbox)) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null
  return email
}
