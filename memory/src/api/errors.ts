/**
 * Uniform bounded error envelope for every /api/v1/memory route. Missing,
 * cross-installation, stale-config, revoked and wrong-service grants are
 * indistinguishable from the caller's perspective.
 */

export type MemoryApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'revision_conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'feature_disabled'

const HTTP_STATUS: Record<MemoryApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  revision_conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  feature_disabled: 503,
}

export class MemoryApiError extends Error {
  readonly code: MemoryApiErrorCode
  readonly httpStatus: number

  constructor(code: MemoryApiErrorCode, message: string) {
    super(message)
    this.name = 'MemoryApiError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
  }
}

export function errorBody(error: MemoryApiError): { error: { code: string; message: string } } {
  return { error: { code: error.code, message: error.message } }
}
