/**
 * Bounded, redaction-first logging. Log lines may only carry fixed event
 * names, allowlisted error codes and low-cardinality fields; anything
 * resembling tokens, cursors, lease material, absolute paths or session
 * bodies is dropped or masked before serialization.
 */

export const ERROR_CODE_ALLOWLIST = Object.freeze([
  'relay_unavailable',
  'provider_auth_failed',
  'cursor_expired',
  'snapshot_required',
  'feed_integrity',
  'projection_backlog',
  'purge_failed',
  'snapshot_failed',
  'missing_from_relay',
  'unsupported_envelope_version',
  'invalid_envelope',
  'stale_lease',
  'rate_limited',
  'handler_failed',
] as const)

export type MemoryErrorCode = typeof ERROR_CODE_ALLOWLIST[number]

export function isAllowedErrorCode(value: string): value is MemoryErrorCode {
  return (ERROR_CODE_ALLOWLIST as readonly string[]).includes(value)
}

const MAX_VALUE_LENGTH = 256
export const SENSITIVE_FIELD_NAMES = new Set([
  'session_id', 'turn_id', 'lease_token', 'cursor', 'token', 'authorization',
  'body', 'payload', 'prompt', 'text', 'secret', 'jwt', 'provider_client_secret',
  'hmac_key', 'password', 'receipt_material',
  // Phase 1: model-facing and user-authored content fields.
  'statement', 'excerpt', 'query', 'document', 'system_prompt', 'model_output',
  'candidates', 'evidence', 'grant', 'detail',
])

const ABSOLUTE_PATH_PATTERN = /(?:^|\s)\/(?:[^\s/]+\/)*[^\s]*/g
const JWT_OR_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*\b/g
const LONG_OPAQUE_PATTERN = /\b[A-Za-z0-9_+/=-]{40,}\b/g

/** Mask token-shaped and path-shaped substrings, then bound the length. */
export function redactSensitive(input: string): string {
  let output = input
    .replace(JWT_OR_TOKEN_PATTERN, '[redacted]')
    .replace(LONG_OPAQUE_PATTERN, '[redacted]')
    .replace(ABSOLUTE_PATH_PATTERN, ' [path]')
  if (output.length > MAX_VALUE_LENGTH) {
    output = `${output.slice(0, MAX_VALUE_LENGTH)}…[truncated]`
  }
  return output
}

/**
 * One structured log line: sensitive field names disappear entirely, other
 * values are redacted and bounded. Level and event stay fixed vocabulary.
 */
export function structuredLogLine(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): string {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD_NAMES.has(key)) continue
    if (typeof value === 'string') {
      safe[key] = redactSensitive(value)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safe[key] = value
    } else {
      safe[key] = '[omitted]'
    }
  }
  return JSON.stringify({ level, event, ...safe })
}

/** Logger emitting bounded lines through the provided sink (default stdout). */
export function createMemoryLogger(
  level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  sink: (line: string) => void = line => console.log(line),
) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  return {
    log(entryLevel: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
      if (order[entryLevel] < order[level]) return
      sink(structuredLogLine(entryLevel, event, fields))
    },
  }
}
