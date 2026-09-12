import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'

export type SessionDocumentFormat = 'markdown' | 'html'
export type SessionDocumentAvailability = 'pending' | 'available' | 'unavailable'

export interface SessionDocumentMetadata {
  documentId: string
  versionId: string
  displayName: string
  format: SessionDocumentFormat
  state: SessionDocumentAvailability
  reason: string | null
  byteSize: number
  sha256: string
  sourceTurnId: string
  sourceEventId: string
  capturedAt: string
  committedAt: string | null
}

export interface SessionDocumentList {
  htmlRendering: boolean
  documents: SessionDocumentMetadata[]
}

export interface SessionDocumentContent {
  text: string
  bytes: Uint8Array
  format: SessionDocumentFormat
  byteSize: number
  sha256: string
}

export type SessionDocumentClientErrorCode =
  | 'network_error'
  | 'ownership_failure'
  | 'rate_limited'
  | 'invalid_response'
  | 'invalid_encoding'
  | 'integrity_failed'
  | 'request_failed'

export class SessionDocumentApiError extends Error {
  readonly status: number
  readonly code: SessionDocumentClientErrorCode

  constructor(status: number, code: SessionDocumentClientErrorCode, message = 'Document request failed') {
    super(message)
    this.name = 'SessionDocumentApiError'
    this.status = status
    this.code = code
  }
}

function endpoint(path: string): string {
  return `${getRelayOrigin()}${path}`
}

function encodePath(value: string): string {
  return encodeURIComponent(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function responseError(status: number, body?: unknown): SessionDocumentApiError {
  if (status === 401 || status === 403 || status === 404) {
    return new SessionDocumentApiError(status, 'ownership_failure', 'Document unavailable')
  }
  if (status === 429) return new SessionDocumentApiError(status, 'rate_limited', 'Too many document requests')
  const envelope = asRecord(body)
  const detail = asRecord(envelope?.error)
  return new SessionDocumentApiError(status, 'request_failed', typeof detail?.message === 'string' ? detail.message : undefined)
}

async function authenticatedFetch(path: string, init: RequestInit = {}, allowRefresh = true): Promise<Response> {
  const { accessToken, doRefreshToken } = useAuth()
  const headers = new Headers(init.headers)
  if (accessToken.value) headers.set('Authorization', `Bearer ${accessToken.value}`)
  let response: Response
  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    throw new SessionDocumentApiError(0, 'network_error', 'Network request failed')
  }
  if (response.status === 401 && allowRefresh && await doRefreshToken()) {
    return authenticatedFetch(path, init, false)
  }
  return response
}

function requiredString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function parseMetadata(value: unknown): SessionDocumentMetadata | null {
  const item = asRecord(value)
  if (!item) return null
  const documentId = requiredString(item.document_id, 128)
  const versionId = requiredString(item.version_id, 128)
  const displayName = requiredString(item.display_name, 255)
  const format = item.format === 'markdown' || item.format === 'html' ? item.format : null
  const state = item.state === 'pending' || item.state === 'available' || item.state === 'unavailable' ? item.state : null
  const byteSize = typeof item.byte_size === 'number' && Number.isSafeInteger(item.byte_size) && item.byte_size >= 0
    ? item.byte_size : null
  const sha256 = typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) ? item.sha256 : null
  const sourceTurnId = requiredString(item.source_turn_id, 128)
  const sourceEventId = requiredString(item.source_event_id, 128)
  const capturedAt = requiredString(item.captured_at, 64)
  const committedAt = item.committed_at === null ? null : requiredString(item.committed_at, 64)
  const reason = item.reason === null ? null : requiredString(item.reason, 64)
  if (!documentId || !versionId || !displayName || !format || !state || byteSize === null || !sha256
    || !sourceTurnId || !sourceEventId || !capturedAt || item.committed_at !== null && !committedAt
    || item.reason !== null && !reason) return null
  return {
    documentId, versionId, displayName, format, state, reason, byteSize, sha256,
    sourceTurnId, sourceEventId, capturedAt, committedAt,
  }
}

export async function listSessionDocuments(sessionId: string): Promise<SessionDocumentList> {
  const response = await authenticatedFetch(`/api/sessions/${encodePath(sessionId)}/documents`, {
    method: 'GET', headers: { Accept: 'application/json' },
  })
  let body: unknown
  try { body = await response.json() } catch { body = null }
  if (!response.ok) throw responseError(response.status, body)
  const envelope = asRecord(body)
  if (envelope?.schema_version !== 1 || typeof envelope.html_rendering !== 'boolean'
    || !Array.isArray(envelope.documents) || envelope.documents.length > 50) {
    throw new SessionDocumentApiError(response.status, 'invalid_response')
  }
  const documents = envelope.documents.map(parseMetadata)
  if (documents.some((item) => item === null)) throw new SessionDocumentApiError(response.status, 'invalid_response')
  return { htmlRendering: envelope.html_rendering, documents: documents as SessionDocumentMetadata[] }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

function contentPath(sessionId: string, metadata: SessionDocumentMetadata, suffix: 'content' | 'download'): string {
  return `/api/sessions/${encodePath(sessionId)}/documents/${encodePath(metadata.documentId)}`
    + `/versions/${encodePath(metadata.versionId)}/${suffix}`
}

export async function fetchSessionDocumentContent(
  sessionId: string,
  metadata: SessionDocumentMetadata,
): Promise<SessionDocumentContent> {
  const response = await authenticatedFetch(contentPath(sessionId, metadata, 'content'), {
    method: 'GET', headers: { Accept: 'text/plain' },
  })
  if (!response.ok) {
    let body: unknown
    try { body = await response.json() } catch { body = null }
    throw responseError(response.status, body)
  }
  const responseSize = Number(response.headers.get('x-document-size'))
  const responseDigest = response.headers.get('x-document-sha256')
  const responseFormat = response.headers.get('x-document-format')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!Number.isSafeInteger(responseSize) || responseSize !== bytes.byteLength
    || responseSize !== metadata.byteSize || responseDigest !== metadata.sha256
    || responseFormat !== metadata.format || await sha256(bytes) !== metadata.sha256) {
    throw new SessionDocumentApiError(response.status, 'integrity_failed', 'Document integrity check failed')
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    throw new SessionDocumentApiError(response.status, 'invalid_encoding', 'Document is not valid UTF-8')
  }
  return { text, bytes, format: metadata.format, byteSize: bytes.byteLength, sha256: metadata.sha256 }
}

export async function fetchSessionDocumentDownload(
  sessionId: string,
  metadata: SessionDocumentMetadata,
): Promise<Blob> {
  const response = await authenticatedFetch(contentPath(sessionId, metadata, 'download'), {
    method: 'GET', headers: { Accept: 'text/plain,text/html' },
  })
  if (!response.ok) throw responseError(response.status)
  return response.blob()
}
