import { createHash } from 'crypto'

import type { MaterializationInput, MaterializationResult } from '../materialization/types.js'
import type {
  BeginDocumentUploadInput,
  CommitDocumentUploadInput,
  SessionDocumentFormat,
  StoreDocumentChunkInput,
  UnavailableDocumentInput,
} from './repository.js'

export const SESSION_DOCUMENT_EVENT_TYPES = new Set([
  'session_document_begin',
  'session_document_chunk',
  'session_document_commit',
])

export function isSessionDocumentArtifactEvent(eventType: string): boolean {
  return SESSION_DOCUMENT_EVENT_TYPES.has(eventType)
}

export class SessionDocumentProtocolError extends Error {
  constructor(message = 'invalid session document record') {
    super(message)
    this.name = 'SessionDocumentProtocolError'
  }
}

interface ArtifactRepository {
  beginUpload(input: BeginDocumentUploadInput): Promise<unknown>
  recordUnavailable(input: UnavailableDocumentInput): Promise<unknown>
  storeChunk(input: StoreDocumentChunkInput): Promise<unknown>
  commitUpload(input: CommitDocumentUploadInput): Promise<unknown>
}

interface ArtifactLimits {
  maxDocumentBytes: number
  maxChunkBytes: number
}

export interface SessionDocumentObservation {
  type: 'begin' | 'chunk' | 'commit' | 'unavailable'
  state: string
  documentId: string
  versionId: string | null
  byteCount: number
  digestPrefix: string | null
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || value !== value.trim() || value.includes('\0')) {
    throw new SessionDocumentProtocolError(`${name} is invalid`)
  }
  return value
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionDocumentProtocolError(`${name} is invalid`)
  }
  return Number(value)
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SessionDocumentProtocolError(`${name} is invalid`)
  }
  return value
}

function format(value: unknown): SessionDocumentFormat {
  if (value !== 'markdown' && value !== 'html') throw new SessionDocumentProtocolError('document_format is invalid')
  return value
}

function capturedAt(value: unknown): Date {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new SessionDocumentProtocolError('captured_at is invalid')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new SessionDocumentProtocolError('captured_at is invalid')
  return parsed
}

function strictBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SessionDocumentProtocolError('chunk_data is invalid')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new SessionDocumentProtocolError('chunk_data is invalid')
  return bytes
}

function emptyResult(inserted: boolean): MaterializationResult {
  return { eventId: null, inserted, completed: true, deliveries: [] }
}

export class SessionDocumentArtifactMaterializer {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly limits: ArtifactLimits,
    private readonly observe?: (observation: SessionDocumentObservation) => void,
  ) {}

  async materialize(input: MaterializationInput): Promise<MaterializationResult> {
    if (input.userId === null || !input.sessionId || !isSessionDocumentArtifactEvent(input.eventType)) {
      throw new SessionDocumentProtocolError()
    }
    const payload = input.payload
    const sessionId = boundedString(payload.session_id, 'session_id', 64)
    if (sessionId !== input.sessionId) throw new SessionDocumentProtocolError('session identity mismatch')
    const documentId = boundedString(payload.document_id, 'document_id', 128)
    boundedString(payload.event_id, 'event_id', 256)

    if (input.eventType === 'session_document_begin') {
      const displayName = boundedString(payload.display_name, 'display_name', 255)
      if (displayName.includes('/') || displayName.includes('\\')) {
        throw new SessionDocumentProtocolError('display_name must be a basename')
      }
      const common = {
        userId: input.userId,
        sessionId,
        documentId,
        displayName,
        format: format(payload.document_format),
        sourceTurnId: boundedString(payload.turn_id, 'turn_id', 128),
        sourceEventId: boundedString(payload.source_event_id, 'source_event_id', 256),
        capturedAt: capturedAt(payload.captured_at),
      }
      if (payload.document_state === 'unavailable') {
        const reasonCode = boundedString(payload.document_reason, 'document_reason', 32)
        await this.repository.recordUnavailable({ ...common, reasonCode })
        this.record({
          type: 'unavailable', state: reasonCode, documentId, versionId: null,
          byteCount: 0, digestPrefix: null,
        })
        return emptyResult(true)
      }
      if (payload.document_state !== undefined && payload.document_state !== 'pending') {
        throw new SessionDocumentProtocolError('document_state is invalid')
      }
      const totalBytes = nonNegativeInteger(payload.total_bytes, 'total_bytes')
      const chunkCount = nonNegativeInteger(payload.chunk_count, 'chunk_count')
      if (totalBytes > this.limits.maxDocumentBytes
        || (totalBytes === 0) !== (chunkCount === 0)) {
        throw new SessionDocumentProtocolError('declared document bounds are invalid')
      }
      const result = await this.repository.beginUpload({
        ...common,
        daemonId: input.daemonId,
        daemonGeneration: Number(input.daemonGeneration ?? 0),
        versionId: boundedString(payload.version_id, 'version_id', 128),
        totalBytes,
        sha256: sha256(payload.content_hash, 'content_hash'),
        chunkCount,
      })
      this.record({
        type: 'begin', state: String((result as { status?: string }).status ?? 'unknown'),
        documentId, versionId: String(payload.version_id), byteCount: totalBytes,
        digestPrefix: String(payload.content_hash).slice(0, 12),
      })
      return emptyResult((result as { status?: string }).status !== 'duplicate')
    }

    const versionId = boundedString(payload.version_id, 'version_id', 128)
    if (input.eventType === 'session_document_chunk') {
      const bytes = strictBase64(payload.chunk_data)
      if (bytes.length > this.limits.maxChunkBytes) throw new SessionDocumentProtocolError('chunk exceeds limit')
      const chunkHash = sha256(payload.chunk_hash, 'chunk_hash')
      if (createHash('sha256').update(bytes).digest('hex') !== chunkHash) {
        throw new SessionDocumentProtocolError('chunk digest mismatch')
      }
      const result = await this.repository.storeChunk({
        userId: input.userId, sessionId, documentId, versionId,
        chunkIndex: nonNegativeInteger(payload.chunk_index, 'chunk_index'),
        byteOffset: nonNegativeInteger(payload.byte_offset, 'byte_offset'),
        bytes, sha256: chunkHash,
      })
      this.record({
        type: 'chunk', state: String((result as { status?: string }).status ?? 'unknown'),
        documentId, versionId, byteCount: bytes.length, digestPrefix: chunkHash.slice(0, 12),
      })
      return emptyResult((result as { status?: string }).status !== 'duplicate')
    }

    const result = await this.repository.commitUpload({
      userId: input.userId, sessionId, documentId, versionId,
      totalBytes: nonNegativeInteger(payload.total_bytes, 'total_bytes'),
      sha256: sha256(payload.content_hash, 'content_hash'),
    })
    this.record({
      type: 'commit', state: String((result as { status?: string }).status ?? 'unknown'),
      documentId, versionId, byteCount: Number(payload.total_bytes),
      digestPrefix: String(payload.content_hash).slice(0, 12),
    })
    const status = String((result as { status?: string }).status ?? 'unknown')
    if (status !== 'committed' && status !== 'duplicate') return emptyResult(false)
    const committedVersionId = boundedString(
      (result as { versionId?: unknown }).versionId, 'committed_version_id', 128,
    )
    return {
      eventId: null,
      inserted: status === 'committed',
      completed: true,
      deliveries: [{
        inboxId: input.inboxId,
        daemonId: input.daemonId,
        eventId: null,
        userId: input.userId,
        audience: 'user',
        sessionId,
        requestId: null,
        ordinal: 0,
        deliveryKey: `document:${documentId}:${committedVersionId}:user:0`,
        type: 'session_documents_changed',
        payload: {
          type: 'session_documents_changed',
          session_id: sessionId,
          document_id: documentId,
          version_id: committedVersionId,
        },
      }],
    }
  }

  private record(observation: SessionDocumentObservation): void {
    try {
      this.observe?.(observation)
    } catch {
      // Observability must never change artifact commit/ack behavior.
    }
  }
}
