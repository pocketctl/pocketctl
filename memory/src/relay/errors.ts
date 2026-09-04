/**
 * Typed Relay errors. `code` comes from a fixed allowlist so logs and metrics
 * stay bounded; messages never contain response bodies, tokens, cursors or
 * lease material.
 */
export type RelayErrorCode =
  | 'network'
  | 'timeout'
  | 'response_too_large'
  | 'provider_auth_failed'
  | 'unauthorized'
  | 'rate_limited'
  | 'stale_lease'
  | 'cursor_expired'
  | 'installation_paused'
  | 'installation_revoked'
  | 'not_found'
  | 'invalid_request'
  | 'forbidden'
  | 'feature_disabled'
  | 'relay_error'

/** Relay extension error codes that may appear in an error body. */
const BODY_CODES = new Set([
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'stale_lease',
  'cursor_expired',
  'installation_paused',
  'installation_revoked',
  'feature_disabled',
])

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

export class RelayRequestError extends Error {
  readonly operation: string
  readonly code: RelayErrorCode
  readonly status?: number
  readonly retryAfterMs?: number
  readonly snapshotRequired?: boolean

  constructor(input: {
    operation: string
    code: RelayErrorCode
    status?: number
    retryAfterMs?: number
    snapshotRequired?: boolean
  }) {
    // The message is composed from fixed parts only — never the body.
    super(`${input.operation} failed with ${input.code}`)
    this.name = 'RelayRequestError'
    this.operation = input.operation
    this.code = input.code
    this.status = input.status
    this.retryAfterMs = input.retryAfterMs
    this.snapshotRequired = input.snapshotRequired
  }
}

/** Map a Relay error body ({error:{code, ...details}}) to a typed error. */
export function relayErrorFromBody(
  operation: string,
  status: number,
  body: unknown,
): RelayRequestError {
  const parsed = body as { error?: { code?: unknown; snapshot_required?: unknown } } | null
  const rawCode = typeof parsed?.error?.code === 'string' ? parsed.error.code : ''
  const code = (BODY_CODES.has(rawCode) ? rawCode : 'relay_error') as RelayErrorCode
  // Details (e.g. snapshot_required) nest inside the error envelope.
  return new RelayRequestError({
    operation,
    code,
    status,
    snapshotRequired: parsed?.error?.snapshot_required === true ? true : undefined,
  })
}
