import type { ExtensionErrorCode } from './types.js'

const ERROR_STATUS_BY_CODE: Record<ExtensionErrorCode, number> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  stale_lease: 409,
  installation_paused: 409,
  cursor_expired: 410,
  installation_revoked: 403,
  feature_disabled: 503,
})

/** Fixed HTTP status for a frozen extension error code. */
export function extensionErrorStatus(code: ExtensionErrorCode): number {
  return ERROR_STATUS_BY_CODE[code]
}

/**
 * Typed extension API error. The message must stay free of payloads, tokens,
 * cursors and lease material — routes log the code, not the message body.
 * Optional machine-readable flags (e.g. snapshot_required) surface beside the
 * error object and must stay bounded and content-free.
 */
export class ExtensionApiError extends Error {
  readonly code: ExtensionErrorCode
  readonly httpStatus: number
  /** Optional machine-readable details merged into the error response. */
  readonly details?: Record<string, unknown>

  constructor(code: ExtensionErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ExtensionApiError'
    this.code = code
    this.httpStatus = extensionErrorStatus(code)
    this.details = details
  }
}

export function isExtensionApiError(value: unknown): value is ExtensionApiError {
  return value instanceof ExtensionApiError
}
