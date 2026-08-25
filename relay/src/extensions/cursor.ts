import { createHash, createHmac, randomBytes } from 'crypto'

/**
 * Relay-signed opaque feed cursor (v1). The HMAC binds the cursor to one
 * installation, lease epoch, config version and event-filter fingerprint,
 * and carries an expiry; any tampering or mismatch fails closed.
 */
export interface FeedCursorV1 {
  v: 1
  installation_id: string
  feed_id: string
  lease_epoch: string
  config_version: string
  filter_hash: string
  exp: number
}

/** Real HMAC-SHA256; the frozen design forbids secret-prefix hashing. */
function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function encodeFeedCursor(
  cursor: FeedCursorV1,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  return `${payload}.${hmac(secret, payload)}`
}

export function decodeFeedCursor(
  token: string,
  secret: string,
  now: number = Date.now(),
): FeedCursorV1 | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expected = hmac(secret, payload)
  if (signature.length !== expected.length) return null
  if (!timingSafeEqualString(signature, expected)) return null
  let cursor: FeedCursorV1
  try {
    cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (cursor.v !== 1
    || typeof cursor.installation_id !== 'string'
    || !/^[0-9]+$/.test(cursor.feed_id)
    || !/^[0-9]+$/.test(cursor.lease_epoch)
    || !/^[0-9]+$/.test(cursor.config_version)
    || typeof cursor.filter_hash !== 'string'
    || typeof cursor.exp !== 'number' || !Number.isFinite(cursor.exp)) {
    return null
  }
  if (cursor.exp * 1000 <= now) return null
  return cursor
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

/** Stable fingerprint of an installation's effective event filter. */
export function filterHashForInstallation(eventFilter: Record<string, unknown>): string {
  const canonical = JSON.stringify({
    daemon_ids: sortedStringArray(eventFilter.daemon_ids),
    agent_types: sortedStringArray(eventFilter.agent_types),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

function sortedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').sort()
}

export function newLeaseToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * The stored lease binding hashes the token together with the issued cursor
 * position, so an ack can only advance the checkpoint to a position Relay
 * actually served under that exact lease.
 */
export function leaseBindingHash(input: {
  installationId: string
  leaseEpoch: number | string
  leaseToken: string
  cursorFeedId: number | string
}): Buffer {
  return createHash('sha256')
    .update(`${input.installationId}:${input.leaseEpoch}:${input.leaseToken}:${input.cursorFeedId}`)
    .digest()
}
