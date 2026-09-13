import { createHash } from 'crypto'

import { lockSessionMaterializationFence } from '../db.js'

export type SessionDocumentFormat = 'markdown' | 'html'

export class SessionDocumentNotFoundError extends Error {
  constructor() {
    super('session document not found')
    this.name = 'SessionDocumentNotFoundError'
  }
}

export class SessionDocumentIntegrityError extends Error {
  constructor(message = 'session document integrity check failed') {
    super(message)
    this.name = 'SessionDocumentIntegrityError'
  }
}

export class SessionDocumentExpiredError extends Error {
  constructor() {
    super('session document upload expired')
    this.name = 'SessionDocumentExpiredError'
  }
}

export interface SessionDocumentRepositoryOptions {
  uploadTimeoutMs: number
  maxDocumentBytes?: number
  maxDocumentsPerSession?: number
  maxVersionsPerDocument?: number
  maxSessionBytes?: number
  maxUserBytes?: number
}

export interface StoredDocumentVersion {
  versionId: string
  documentId: string
  sessionId: string
  byteSize: number
  isLatest: boolean
  order: number
}

export type DocumentPruningPlan =
  | { accepted: true; deleteVersionIds: string[] }
  | { accepted: false; reason: 'session_quota' | 'user_quota'; deleteVersionIds: [] }

export function planSessionDocumentPruning(
  versions: StoredDocumentVersion[],
  incoming: { documentId: string; sessionId: string; byteSize: number },
  limits: Pick<Required<SessionDocumentRepositoryOptions>,
    'maxVersionsPerDocument' | 'maxSessionBytes' | 'maxUserBytes'>,
): DocumentPruningPlan {
  const ordered = [...versions].sort((left, right) => left.order - right.order)
  const selected = new Set<string>()
  const select = (candidate: StoredDocumentVersion): void => { selected.add(candidate.versionId) }
  const remainingBytes = (predicate: (version: StoredDocumentVersion) => boolean): number => versions
    .filter((item) => predicate(item) && !selected.has(item.versionId))
    .reduce((total, item) => total + item.byteSize, 0)

  const documentVersions = ordered.filter((item) => item.documentId === incoming.documentId)
  let excessVersions = documentVersions.length + 1 - limits.maxVersionsPerDocument
  for (const candidate of documentVersions) {
    if (excessVersions <= 0) break
    if (!candidate.isLatest) {
      select(candidate)
      excessVersions--
    }
  }
  if (excessVersions > 0) {
    return { accepted: false, reason: 'session_quota', deleteVersionIds: [] }
  }

  let sessionBytes = remainingBytes((item) => item.sessionId === incoming.sessionId) + incoming.byteSize
  for (const candidate of ordered) {
    if (sessionBytes <= limits.maxSessionBytes) break
    if (candidate.sessionId === incoming.sessionId && !candidate.isLatest && !selected.has(candidate.versionId)) {
      select(candidate)
      sessionBytes -= candidate.byteSize
    }
  }
  if (sessionBytes > limits.maxSessionBytes) {
    return { accepted: false, reason: 'session_quota', deleteVersionIds: [] }
  }

  let userBytes = remainingBytes(() => true) + incoming.byteSize
  for (const candidate of ordered) {
    if (userBytes <= limits.maxUserBytes) break
    if (!candidate.isLatest && !selected.has(candidate.versionId)) {
      select(candidate)
      userBytes -= candidate.byteSize
    }
  }
  if (userBytes > limits.maxUserBytes) {
    return { accepted: false, reason: 'user_quota', deleteVersionIds: [] }
  }
  return { accepted: true, deleteVersionIds: [...selected] }
}

export interface BeginDocumentUploadInput {
  userId: number
  sessionId: string
  daemonId: string
  daemonGeneration: number
  documentId: string
  versionId: string
  displayName: string
  format: SessionDocumentFormat
  sourceTurnId: string
  sourceEventId: string
  totalBytes: number
  sha256: string
  chunkCount: number
  capturedAt: Date
}

export interface StoreDocumentChunkInput {
  userId: number
  sessionId: string
  documentId: string
  versionId: string
  chunkIndex: number
  byteOffset: number
  bytes: Buffer
  sha256: string
}

export interface CommitDocumentUploadInput {
  userId: number
  sessionId: string
  documentId: string
  versionId: string
  totalBytes: number
  sha256: string
}

export interface SessionDocumentAssemblyChunk {
  chunkIndex: number
  byteOffset: number
  bytes: Buffer
  sha256: string
}

export function assembleSessionDocument(
  chunks: SessionDocumentAssemblyChunk[],
  expected: { chunkCount: number; totalBytes: number; sha256: string },
): Buffer {
  if (chunks.length !== expected.chunkCount) {
    throw new SessionDocumentIntegrityError('document chunk count mismatch')
  }
  const ordered = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex)
  let nextOffset = 0
  for (let index = 0; index < ordered.length; index++) {
    const chunk = ordered[index]
    if (chunk.chunkIndex !== index || chunk.byteOffset !== nextOffset || chunk.bytes.length <= 0) {
      throw new SessionDocumentIntegrityError('document chunks are not exact and contiguous')
    }
    if (createHash('sha256').update(chunk.bytes).digest('hex') !== chunk.sha256) {
      throw new SessionDocumentIntegrityError('stored chunk digest mismatch')
    }
    nextOffset += chunk.bytes.length
  }
  if (nextOffset !== expected.totalBytes) {
    throw new SessionDocumentIntegrityError('assembled document size mismatch')
  }
  const bytes = Buffer.concat(ordered.map((chunk) => chunk.bytes), expected.totalBytes)
  if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new SessionDocumentIntegrityError('assembled document digest mismatch')
  }
  return bytes
}

export interface UnavailableDocumentInput {
  userId: number
  sessionId: string
  documentId: string
  displayName: string
  format: SessionDocumentFormat
  sourceTurnId: string
  sourceEventId: string
  reasonCode: string
  capturedAt: Date
}

export interface SessionDocumentMetadata {
  documentId: string
  displayName: string
  format: SessionDocumentFormat
  latestVersionId: string | null
  byteSize: number | null
  sha256: string | null
  sourceTurnId: string
  sourceEventId: string
  state: 'pending' | 'available' | 'unavailable'
  reasonCode: string | null
  capturedAt: Date
  committedAt: Date | null
}

interface TransactionClient {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>
  release(): void
}

export interface SessionDocumentRepositoryPool {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>
  connect(): Promise<TransactionClient>
}

interface UploadRow {
  version_id?: string
  user_id: number
  session_id: string
  document_id: string
  display_name?: string
  document_format?: SessionDocumentFormat
  source_turn_id?: string
  source_event_id?: string
  total_bytes: number
  sha256?: string
  chunk_count: number
  state: string
  captured_at?: Date
  expires_at: Date
}

interface ChunkRow {
  byte_offset: number
  byte_size: number
  sha256: string
  content_bytes: Buffer
}

export class SessionDocumentRepository {
  private readonly limits: Required<SessionDocumentRepositoryOptions>

  constructor(
    private readonly pool: SessionDocumentRepositoryPool,
    options: SessionDocumentRepositoryOptions,
  ) {
    if (!Number.isSafeInteger(options.uploadTimeoutMs) || options.uploadTimeoutMs <= 0) {
      throw new Error('uploadTimeoutMs must be a positive safe integer')
    }
    this.limits = {
      uploadTimeoutMs: options.uploadTimeoutMs,
      maxDocumentBytes: options.maxDocumentBytes ?? 2 * 1024 * 1024,
      maxDocumentsPerSession: options.maxDocumentsPerSession ?? 50,
      maxVersionsPerDocument: options.maxVersionsPerDocument ?? 5,
      maxSessionBytes: options.maxSessionBytes ?? 20 * 1024 * 1024,
      maxUserBytes: options.maxUserBytes ?? 100 * 1024 * 1024,
    }
  }

  async beginUpload(input: BeginDocumentUploadInput): Promise<
    { status: 'pending' | 'duplicate' } | { status: 'rejected'; reason: 'session_quota' }
  > {
    if (input.totalBytes > this.limits.maxDocumentBytes) {
      throw new SessionDocumentIntegrityError('document exceeds configured byte limit')
    }
    return this.transaction(async (client) => {
      await lockSessionMaterializationFence(client, input.sessionId)
      await this.requireLiveOwnedSession(client, input.userId, input.sessionId)
      await client.query(`SELECT pg_advisory_xact_lock($1::int, 736421)`, [input.userId])
      const identityCount = await client.query<{ document_exists: boolean; document_count: string | number }>(
        `SELECT EXISTS (
           SELECT 1 FROM session_documents WHERE user_id = $1 AND session_id = $2 AND document_id = $3
         ) AS document_exists,
         COUNT(*)::text AS document_count
         FROM session_documents WHERE user_id = $1 AND session_id = $2`,
        [input.userId, input.sessionId, input.documentId],
      )
      const countRow = identityCount.rows[0]
      if (!countRow?.document_exists && Number(countRow?.document_count ?? 0) >= this.limits.maxDocumentsPerSession) {
        return { status: 'rejected' as const, reason: 'session_quota' as const }
      }
      const document = await client.query<{ document_id: string }>(
        `INSERT INTO session_documents
           (document_id, user_id, session_id, display_name, document_format,
            last_source_turn_id, last_source_event_id, state, reason_code, captured_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL, $8, NOW())
         ON CONFLICT (document_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             document_format = EXCLUDED.document_format,
             last_source_turn_id = EXCLUDED.last_source_turn_id,
             last_source_event_id = EXCLUDED.last_source_event_id,
             state = CASE WHEN session_documents.latest_version_id IS NULL THEN 'pending' ELSE session_documents.state END,
             reason_code = CASE WHEN session_documents.latest_version_id IS NULL THEN NULL ELSE session_documents.reason_code END,
             captured_at = EXCLUDED.captured_at,
             updated_at = NOW()
         WHERE session_documents.user_id = EXCLUDED.user_id
           AND session_documents.session_id = EXCLUDED.session_id
         RETURNING document_id`,
        [
          input.documentId, input.userId, input.sessionId, input.displayName, input.format,
          input.sourceTurnId, input.sourceEventId, input.capturedAt,
        ],
      )
      if (!document.rows[0]) throw new SessionDocumentIntegrityError('document identity belongs to another session')

      const expiresAt = new Date(input.capturedAt.getTime() + this.limits.uploadTimeoutMs)
      const upload = await client.query<{ version_id: string }>(
        `INSERT INTO session_document_uploads
           (version_id, user_id, session_id, document_id, daemon_id, daemon_generation,
            display_name, document_format, source_turn_id, source_event_id, total_bytes,
            sha256, chunk_count, state, captured_at, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14, $15, NOW())
         ON CONFLICT (version_id) DO UPDATE SET updated_at = session_document_uploads.updated_at
         WHERE session_document_uploads.user_id = EXCLUDED.user_id
           AND session_document_uploads.session_id = EXCLUDED.session_id
           AND session_document_uploads.document_id = EXCLUDED.document_id
           AND session_document_uploads.daemon_id = EXCLUDED.daemon_id
           AND session_document_uploads.daemon_generation = EXCLUDED.daemon_generation
           AND session_document_uploads.display_name = EXCLUDED.display_name
           AND session_document_uploads.document_format = EXCLUDED.document_format
           AND session_document_uploads.source_turn_id = EXCLUDED.source_turn_id
           AND session_document_uploads.source_event_id = EXCLUDED.source_event_id
           AND session_document_uploads.total_bytes = EXCLUDED.total_bytes
           AND session_document_uploads.sha256 = EXCLUDED.sha256
           AND session_document_uploads.chunk_count = EXCLUDED.chunk_count
           AND session_document_uploads.captured_at = EXCLUDED.captured_at
         RETURNING version_id`,
        [
          input.versionId, input.userId, input.sessionId, input.documentId,
          input.daemonId, input.daemonGeneration, input.displayName, input.format,
          input.sourceTurnId, input.sourceEventId, input.totalBytes, input.sha256,
          input.chunkCount, input.capturedAt, expiresAt,
        ],
      )
      if (!upload.rows[0]) {
        const committed = await client.query(
          `SELECT 1 FROM session_document_versions
           WHERE version_id = $1 AND user_id = $2 AND session_id = $3 AND document_id = $4
             AND byte_size = $5 AND sha256 = $6`,
          [input.versionId, input.userId, input.sessionId, input.documentId, input.totalBytes, input.sha256],
        )
        if (committed.rows[0]) return { status: 'duplicate' as const }
        throw new SessionDocumentIntegrityError('conflicting document begin')
      }
      return { status: 'pending' as const }
    })
  }

  async recordUnavailable(input: UnavailableDocumentInput): Promise<void> {
    await this.transaction(async (client) => {
      await lockSessionMaterializationFence(client, input.sessionId)
      await this.requireLiveOwnedSession(client, input.userId, input.sessionId)
      const result = await client.query(
        `INSERT INTO session_documents
           (document_id, user_id, session_id, display_name, document_format,
            last_source_turn_id, last_source_event_id, state, reason_code, captured_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'unavailable', $8, $9, NOW())
         ON CONFLICT (document_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             document_format = EXCLUDED.document_format,
             last_source_turn_id = EXCLUDED.last_source_turn_id,
             last_source_event_id = EXCLUDED.last_source_event_id,
             state = 'unavailable', reason_code = EXCLUDED.reason_code,
             captured_at = EXCLUDED.captured_at, updated_at = NOW()
         WHERE session_documents.user_id = EXCLUDED.user_id
           AND session_documents.session_id = EXCLUDED.session_id
         RETURNING document_id`,
        [
          input.documentId, input.userId, input.sessionId, input.displayName, input.format,
          input.sourceTurnId, input.sourceEventId, input.reasonCode, input.capturedAt,
        ],
      )
      if (!result.rows[0]) throw new SessionDocumentIntegrityError('document identity belongs to another session')
    })
  }

  async storeChunk(input: StoreDocumentChunkInput): Promise<{ status: 'stored' | 'duplicate' }> {
    const digest = createHash('sha256').update(input.bytes).digest('hex')
    if (digest !== input.sha256) throw new SessionDocumentIntegrityError('chunk digest mismatch')
    return this.transaction(async (client) => {
      await lockSessionMaterializationFence(client, input.sessionId)
      await this.requireLiveOwnedSession(client, input.userId, input.sessionId)
      const uploadResult = await client.query<UploadRow>(
        `SELECT user_id, session_id, document_id, total_bytes, chunk_count, state, expires_at
         FROM session_document_uploads
         WHERE version_id = $1
         FOR UPDATE`,
        [input.versionId],
      )
      const upload = uploadResult.rows[0]
      if (!upload || upload.user_id !== input.userId || upload.session_id !== input.sessionId
        || upload.document_id !== input.documentId) throw new SessionDocumentNotFoundError()
      if (upload.state !== 'pending') throw new SessionDocumentIntegrityError('upload is not pending')
      if (new Date(upload.expires_at).getTime() <= Date.now()) throw new SessionDocumentExpiredError()
      if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex >= upload.chunk_count
        || !Number.isInteger(input.byteOffset) || input.byteOffset < 0
        || input.bytes.length <= 0 || input.byteOffset + input.bytes.length > upload.total_bytes) {
        throw new SessionDocumentIntegrityError('chunk range outside declared upload')
      }

      const existing = await client.query<ChunkRow>(
        `SELECT byte_offset, byte_size, sha256, content_bytes
         FROM session_document_upload_chunks
         WHERE version_id = $1 AND chunk_index = $2`,
        [input.versionId, input.chunkIndex],
      )
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.byte_offset === input.byteOffset && row.byte_size === input.bytes.length
          && row.sha256 === input.sha256 && Buffer.from(row.content_bytes).equals(input.bytes)) {
          return { status: 'duplicate' as const }
        }
        throw new SessionDocumentIntegrityError('conflicting duplicate chunk')
      }

      const overlap = await client.query(
        `SELECT 1 FROM session_document_upload_chunks
         WHERE version_id = $1
           AND byte_offset < $2
           AND byte_offset + byte_size > $3
         LIMIT 1`,
        [input.versionId, input.byteOffset + input.bytes.length, input.byteOffset],
      )
      if (overlap.rows[0]) throw new SessionDocumentIntegrityError('overlapping chunk range')

      await client.query(
        `INSERT INTO session_document_upload_chunks
           (version_id, chunk_index, byte_offset, byte_size, sha256, content_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.versionId, input.chunkIndex, input.byteOffset, input.bytes.length, input.sha256, input.bytes],
      )
      return { status: 'stored' as const }
    })
  }

  async commitUpload(
    input: CommitDocumentUploadInput,
  ): Promise<
    | { status: 'committed' | 'duplicate'; versionId: string }
    | { status: 'rejected'; reason: 'session_quota' | 'user_quota'; versionId: string | null }
  > {
    const outcome = await this.transaction(async (client) => {
      await lockSessionMaterializationFence(client, input.sessionId)
      await this.requireLiveOwnedSession(client, input.userId, input.sessionId)
      const uploadResult = await client.query<UploadRow>(
        `SELECT version_id, user_id, session_id, document_id, display_name, document_format,
                source_turn_id, source_event_id, total_bytes, sha256, chunk_count,
                state, captured_at, expires_at
         FROM session_document_uploads
         WHERE version_id = $1
         FOR UPDATE`,
        [input.versionId],
      )
      const upload = uploadResult.rows[0]
      if (!upload || upload.user_id !== input.userId || upload.session_id !== input.sessionId
        || upload.document_id !== input.documentId) throw new SessionDocumentNotFoundError()
      if (upload.state !== 'pending') throw new SessionDocumentIntegrityError('upload is not pending')
      if (new Date(upload.expires_at).getTime() <= Date.now()) throw new SessionDocumentExpiredError()

      if (upload.total_bytes !== input.totalBytes || upload.sha256 !== input.sha256) {
        await this.failUploadIntegrity(client, input)
        return { error: new SessionDocumentIntegrityError('commit does not match begin') }
      }
      const chunkResult = await client.query<any>(
        `SELECT chunk_index, byte_offset, byte_size, sha256, content_bytes
         FROM session_document_upload_chunks
         WHERE version_id = $1
         ORDER BY chunk_index ASC`,
        [input.versionId],
      )

      let bytes: Buffer
      try {
        bytes = assembleSessionDocument(chunkResult.rows.map((row) => ({
          chunkIndex: Number(row.chunk_index),
          byteOffset: Number(row.byte_offset),
          bytes: Buffer.from(row.content_bytes),
          sha256: row.sha256,
        })), {
          chunkCount: upload.chunk_count,
          totalBytes: upload.total_bytes,
          sha256: upload.sha256,
        })
      } catch (error) {
        await this.failUploadIntegrity(client, input)
        return { error: error instanceof Error ? error : new SessionDocumentIntegrityError() }
      }

      await client.query(`SELECT pg_advisory_xact_lock($1::int, 736421)`, [input.userId])
      const existingDigest = await client.query<{ version_id: string }>(
        `SELECT version_id FROM session_document_versions
         WHERE user_id = $1 AND session_id = $2 AND document_id = $3 AND sha256 = $4`,
        [input.userId, input.sessionId, input.documentId, input.sha256],
      )
      let duplicateVersionId = existingDigest.rows[0]?.version_id
      if (!duplicateVersionId) {
        const stored = await client.query<any>(
          `SELECT v.version_id, v.document_id, v.session_id, v.byte_size,
                  (d.latest_version_id = v.version_id) AS is_latest,
                  v.committed_at
           FROM session_document_versions v
           JOIN session_documents d ON d.document_id = v.document_id
           WHERE v.user_id = $1
           ORDER BY v.committed_at ASC, v.version_id ASC
           FOR UPDATE OF v, d`,
          [input.userId],
        )
        const versions: StoredDocumentVersion[] = stored.rows.map((row, index) => ({
          versionId: row.version_id,
          documentId: row.document_id,
          sessionId: row.session_id,
          byteSize: Number(row.byte_size),
          isLatest: row.is_latest === true,
          order: row.committed_at instanceof Date ? row.committed_at.getTime() : index,
        }))
        const plan = planSessionDocumentPruning(versions, {
          documentId: input.documentId,
          sessionId: input.sessionId,
          byteSize: bytes.length,
        }, this.limits)
        if (!plan.accepted) {
          const latestVersionId = versions.find((version) => version.documentId === input.documentId && version.isLatest)?.versionId ?? null
          await this.rejectUploadForQuota(client, input, plan.reason)
          return { result: { status: 'rejected' as const, reason: plan.reason, versionId: latestVersionId } }
        }
        if (plan.deleteVersionIds.length > 0) {
          await client.query(
            `DELETE FROM session_document_versions
             WHERE user_id = $1 AND version_id = ANY($2::varchar[])`,
            [input.userId, plan.deleteVersionIds],
          )
        }
      }

      const inserted = duplicateVersionId ? { rows: [] as { version_id: string }[] } : await client.query<{ version_id: string }>(
        `INSERT INTO session_document_versions
           (version_id, user_id, session_id, document_id, source_turn_id, source_event_id,
            byte_size, sha256, captured_at, content_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (document_id, sha256) DO NOTHING
         RETURNING version_id`,
        [
          input.versionId, input.userId, input.sessionId, input.documentId,
          upload.source_turn_id, upload.source_event_id, upload.total_bytes,
          upload.sha256, upload.captured_at, bytes,
        ],
      )
      let committedVersionId = duplicateVersionId ?? inserted.rows[0]?.version_id
      let duplicate = duplicateVersionId !== undefined
      if (!committedVersionId) {
        const existing = await client.query<{ version_id: string }>(
          `SELECT version_id FROM session_document_versions
           WHERE user_id = $1 AND session_id = $2 AND document_id = $3 AND sha256 = $4`,
          [input.userId, input.sessionId, input.documentId, input.sha256],
        )
        committedVersionId = existing.rows[0]?.version_id
        if (!committedVersionId) throw new SessionDocumentIntegrityError('version identity conflict')
        duplicate = true
      }

      const promoted = await client.query(
        `UPDATE session_documents
         SET latest_version_id = $4, state = 'available', reason_code = NULL,
             last_source_turn_id = $5, last_source_event_id = $6,
             captured_at = $7, updated_at = NOW()
         WHERE user_id = $1 AND session_id = $2 AND document_id = $3
         RETURNING document_id`,
        [
          input.userId, input.sessionId, input.documentId, committedVersionId,
          upload.source_turn_id, upload.source_event_id, upload.captured_at,
        ],
      )
      if (!promoted.rows[0]) throw new SessionDocumentNotFoundError()
      await client.query(
        `DELETE FROM session_document_uploads
         WHERE version_id = $1 AND user_id = $2 AND session_id = $3 AND document_id = $4`,
        [input.versionId, input.userId, input.sessionId, input.documentId],
      )
      return {
        result: { status: duplicate ? 'duplicate' as const : 'committed' as const, versionId: committedVersionId },
      }
    })
    if ('error' in outcome) throw outcome.error
    return outcome.result
  }

  async expireUploads(now = new Date()): Promise<number> {
    const result = await this.pool.query<{ version_id: string }>(
      `DELETE FROM session_document_uploads
       WHERE expires_at <= $1
       RETURNING version_id`,
      [now],
    )
    return result.rows.length
  }

  async listLatest(userId: number, sessionId: string): Promise<SessionDocumentMetadata[]> {
    const owned = await this.pool.query(
      `SELECT 1 FROM sessions WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    )
    if (!owned.rows[0]) throw new SessionDocumentNotFoundError()
    const result = await this.pool.query<any>(
      `SELECT d.document_id, d.display_name, d.document_format, d.latest_version_id,
              d.last_source_turn_id, d.last_source_event_id, d.state, d.reason_code,
              d.captured_at, v.byte_size, v.sha256, v.committed_at
       FROM session_documents d
       LEFT JOIN session_document_versions v
         ON v.document_id = d.document_id AND v.version_id = d.latest_version_id
       WHERE d.user_id = $1 AND d.session_id = $2
       ORDER BY d.updated_at DESC, d.document_id ASC`,
      [userId, sessionId],
    )
    return result.rows.map((row) => ({
      documentId: row.document_id,
      displayName: row.display_name,
      format: row.document_format,
      latestVersionId: row.latest_version_id,
      byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
      sha256: row.sha256 ?? null,
      sourceTurnId: row.last_source_turn_id,
      sourceEventId: row.last_source_event_id,
      state: row.state,
      reasonCode: row.reason_code ?? null,
      capturedAt: row.captured_at,
      committedAt: row.committed_at ?? null,
    }))
  }

  async readCommittedContent(
    userId: number,
    sessionId: string,
    documentId: string,
    versionId: string,
  ): Promise<{
    bytes: Buffer
    byteSize: number
    sha256: string
    format: SessionDocumentFormat
    displayName: string
  }> {
    const result = await this.pool.query<any>(
      `SELECT v.content_bytes, v.byte_size, v.sha256, d.document_format, d.display_name
       FROM session_documents d
       JOIN session_document_versions v
         ON v.document_id = d.document_id AND v.version_id = $4
       WHERE d.user_id = $1 AND d.session_id = $2 AND d.document_id = $3`,
      [userId, sessionId, documentId, versionId],
    )
    const row = result.rows[0]
    if (!row) throw new SessionDocumentNotFoundError()
    return {
      bytes: Buffer.from(row.content_bytes),
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      format: row.document_format,
      displayName: row.display_name,
    }
  }

  private async requireLiveOwnedSession(
    client: TransactionClient,
    userId: number,
    sessionId: string,
  ): Promise<void> {
    const result = await client.query<{ session_allowed: boolean; tombstoned: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sessions WHERE user_id = $1 AND session_id = $2
       ) AS session_allowed,
       EXISTS (
         SELECT 1 FROM deleted_sessions WHERE session_id = $2
       ) AS tombstoned`,
      [userId, sessionId],
    )
    const row = result.rows[0]
    if (!row?.session_allowed || row.tombstoned) throw new SessionDocumentNotFoundError()
  }

  private async failUploadIntegrity(
    client: TransactionClient,
    input: CommitDocumentUploadInput,
  ): Promise<void> {
    await client.query(
      `UPDATE session_document_uploads
       SET state = 'failed', reason_code = 'integrity_failed', updated_at = NOW()
       WHERE version_id = $1 AND user_id = $2 AND session_id = $3 AND document_id = $4`,
      [input.versionId, input.userId, input.sessionId, input.documentId],
    )
    await client.query(
      `UPDATE session_documents
       SET state = 'unavailable', reason_code = 'integrity_failed', updated_at = NOW()
       WHERE user_id = $1 AND session_id = $2 AND document_id = $3`,
      [input.userId, input.sessionId, input.documentId],
    )
  }

  private async rejectUploadForQuota(
    client: TransactionClient,
    input: CommitDocumentUploadInput,
    reason: 'session_quota' | 'user_quota',
  ): Promise<void> {
    await client.query(
      `UPDATE session_documents
       SET state = 'unavailable', reason_code = '${reason}', updated_at = NOW()
       WHERE user_id = $1 AND session_id = $2 AND document_id = $3`,
      [input.userId, input.sessionId, input.documentId],
    )
    await client.query(
      `DELETE FROM session_document_uploads
       WHERE version_id = $1 AND user_id = $2 AND session_id = $3 AND document_id = $4`,
      [input.versionId, input.userId, input.sessionId, input.documentId],
    )
  }

  private async transaction<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
