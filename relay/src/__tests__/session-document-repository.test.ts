import { createHash } from 'crypto'
import { describe, expect, test, vi } from 'vitest'

import {
  SessionDocumentIntegrityError,
  SessionDocumentNotFoundError,
  SessionDocumentRepository,
} from '../session-documents/repository.js'

function mockPool(handler: (sql: string, params: unknown[]) => { rows?: any[]; rowCount?: number }) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: [], rowCount: 0, ...handler(sql, params) }))
  const client = { query, release: vi.fn() }
  return { pool: { query, connect: vi.fn(async () => client) } as any, query, client }
}

const begin = {
  userId: 7,
  sessionId: 'session-1',
  daemonId: 'daemon-1',
  daemonGeneration: 12,
  documentId: 'document-1',
  versionId: 'version-1',
  displayName: 'report.md',
  format: 'markdown' as const,
  sourceTurnId: 'turn-1',
  sourceEventId: 'event-1',
  totalBytes: 5,
  sha256: createHash('sha256').update('hello').digest('hex'),
  chunkCount: 1,
  capturedAt: new Date('2026-09-11T00:00:00Z'),
}

describe('SessionDocumentRepository', () => {
  test('idempotently starts an owner-scoped upload with a bounded expiry', async () => {
    const { pool, query } = mockPool((sql) => {
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }] }
      if (sql.includes('INSERT INTO session_documents')) return { rows: [{ document_id: begin.documentId }], rowCount: 1 }
      if (sql.includes('INSERT INTO session_document_uploads')) return { rows: [{ version_id: begin.versionId }], rowCount: 1 }
      return {}
    })
    const repository = new SessionDocumentRepository(pool, { uploadTimeoutMs: 60_000 })

    await expect(repository.beginUpload(begin)).resolves.toEqual({ status: 'pending' })
    const uploadCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO session_document_uploads'))
    expect(uploadCall?.[1]?.some((value: unknown) => value instanceof Date
      && value.toISOString() === '2026-09-11T00:01:00.000Z')).toBe(true)
    expect(query).toHaveBeenCalledWith('COMMIT')
  })

  test('rejects begin for an unknown or tombstoned session before creating document state', async () => {
    const { pool, query } = mockPool((sql) => sql.includes('AS session_allowed')
      ? { rows: [{ session_allowed: false, tombstoned: true }] }
      : {})
    const repository = new SessionDocumentRepository(pool, { uploadTimeoutMs: 60_000 })

    await expect(repository.beginUpload(begin)).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO session_documents'))).toBe(false)
    const fence = query.mock.calls.findIndex(([sql]) => String(sql).includes('pg_advisory_xact_lock'))
    expect(fence).toBeGreaterThan(0)
    expect(fence).toBeLessThan(query.mock.calls.findIndex(([sql]) => String(sql).includes('AS session_allowed')))
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  test.each(['chunk', 'commit'])('terminally rejects a late %s for a tombstoned session before document writes', async (kind) => {
    const { pool, query } = mockPool((sql) => sql.includes('AS session_allowed')
      ? { rows: [{ session_allowed: false, tombstoned: true }] }
      : {})
    const repository = new SessionDocumentRepository(pool, { uploadTimeoutMs: 60_000 })
    const action = kind === 'chunk'
      ? repository.storeChunk({
        userId: 7, sessionId: 'session-1', documentId: 'document-1', versionId: 'version-1',
        chunkIndex: 0, byteOffset: 0, bytes: Buffer.from('hello'), sha256: begin.sha256,
      })
      : repository.commitUpload({
        userId: 7, sessionId: 'session-1', documentId: 'document-1', versionId: 'version-1',
        totalBytes: 5, sha256: begin.sha256,
      })

    await expect(action).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('AS session_allowed'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => /INSERT INTO session_document_(?:upload_chunks|versions)/.test(String(sql)))).toBe(false)
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  test('accepts an identical duplicate chunk without storing a second copy', async () => {
    const bytes = Buffer.from('hello')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const { pool, query } = mockPool((sql) => {
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }] }
      if (sql.includes('FROM session_document_uploads') && sql.includes('FOR UPDATE')) {
        return { rows: [{ user_id: 7, session_id: 'session-1', document_id: 'document-1', total_bytes: 5, chunk_count: 1, state: 'pending', expires_at: new Date(Date.now() + 60_000) }] }
      }
      if (sql.includes('FROM session_document_upload_chunks') && sql.includes('chunk_index =')) {
        return { rows: [{ byte_offset: 0, byte_size: 5, sha256, content_bytes: bytes }] }
      }
      return {}
    })
    const repository = new SessionDocumentRepository(pool, { uploadTimeoutMs: 60_000 })

    await expect(repository.storeChunk({
      userId: 7, sessionId: 'session-1', documentId: 'document-1', versionId: 'version-1',
      chunkIndex: 0, byteOffset: 0, bytes, sha256,
    })).resolves.toEqual({ status: 'duplicate' })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO session_document_upload_chunks'))).toBe(false)
  })

  test('rejects conflicting duplicate and out-of-range chunks without affecting other uploads', async () => {
    const bytes = Buffer.from('hello')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const uploadRow = { user_id: 7, session_id: 'session-1', document_id: 'document-1', total_bytes: 5, chunk_count: 1, state: 'pending', expires_at: new Date(Date.now() + 60_000) }
    const conflicting = mockPool((sql) => {
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }] }
      if (sql.includes('FROM session_document_uploads') && sql.includes('FOR UPDATE')) return { rows: [uploadRow] }
      if (sql.includes('FROM session_document_upload_chunks') && sql.includes('chunk_index =')) {
        return { rows: [{ byte_offset: 1, byte_size: 5, sha256, content_bytes: bytes }] }
      }
      return {}
    })
    await expect(new SessionDocumentRepository(conflicting.pool, { uploadTimeoutMs: 60_000 }).storeChunk({
      userId: 7, sessionId: 'session-1', documentId: 'document-1', versionId: 'version-1',
      chunkIndex: 0, byteOffset: 0, bytes, sha256,
    })).rejects.toBeInstanceOf(SessionDocumentIntegrityError)

    const outOfRange = mockPool((sql) => {
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }] }
      return sql.includes('FROM session_document_uploads') ? { rows: [uploadRow] } : {}
    })
    await expect(new SessionDocumentRepository(outOfRange.pool, { uploadTimeoutMs: 60_000 }).storeChunk({
      userId: 7, sessionId: 'session-1', documentId: 'document-1', versionId: 'version-1',
      chunkIndex: 1, byteOffset: 5, bytes: Buffer.from('x'), sha256: createHash('sha256').update('x').digest('hex'),
    })).rejects.toBeInstanceOf(SessionDocumentIntegrityError)
  })

  test('expires incomplete assemblies and performs complete owner-scoped reads', async () => {
    const { pool, query } = mockPool((sql, params) => {
      if (sql.includes('DELETE FROM session_document_uploads')) return { rows: [{ version_id: 'v1' }, { version_id: 'v2' }], rowCount: 2 }
      if (sql.includes('FROM session_documents d') && sql.includes('JOIN session_document_versions')) {
        expect(params).toEqual([7, 's', 'd', 'v'])
        return { rows: [{ content_bytes: Buffer.from('safe'), byte_size: 4, sha256: 'a'.repeat(64), document_format: 'html', display_name: 'safe.html' }] }
      }
      return {}
    })
    const repository = new SessionDocumentRepository(pool, { uploadTimeoutMs: 60_000 })

    await expect(repository.expireUploads(new Date('2026-09-11T01:00:00Z'))).resolves.toBe(2)
    await expect(repository.readCommittedContent(7, 's', 'd', 'v')).resolves.toEqual({
      bytes: Buffer.from('safe'), byteSize: 4, sha256: 'a'.repeat(64), format: 'html', displayName: 'safe.html',
    })
    expect(query.mock.calls.some(([, params]) => Array.isArray(params) && params.join(',') === '7,s,d,v')).toBe(true)
  })
})
