import { createHash } from 'crypto'
import { describe, expect, test, vi } from 'vitest'

import {
  planSessionDocumentPruning,
  SessionDocumentRepository,
  type StoredDocumentVersion,
} from '../session-documents/repository.js'

const limits = {
  maxVersionsPerDocument: 2,
  maxSessionBytes: 10,
  maxUserBytes: 20,
}

const version = (
  versionId: string,
  documentId: string,
  sessionId: string,
  byteSize: number,
  isLatest: boolean,
  order: number,
): StoredDocumentVersion => ({ versionId, documentId, sessionId, byteSize, isLatest, order })

describe('session document quota planning', () => {
  test('rejects a new document identity after the per-session count limit', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }], rowCount: 1 }
      if (sql.includes('AS document_exists')) return { rows: [{ document_exists: false, document_count: '2' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    const repository = new SessionDocumentRepository({ query, connect: vi.fn(async () => client) } as any, {
      uploadTimeoutMs: 60_000, maxDocumentsPerSession: 2,
    })
    const digest = createHash('sha256').update('x').digest('hex')

    await expect(repository.beginUpload({
      userId: 7, sessionId: 's1', daemonId: 'daemon', daemonGeneration: 1,
      documentId: 'new-doc', versionId: 'v1', displayName: 'new.md', format: 'markdown',
      sourceTurnId: 't1', sourceEventId: 'e1', totalBytes: 1, sha256: digest,
      chunkCount: 1, capturedAt: new Date(),
    })).resolves.toEqual({ status: 'rejected', reason: 'session_quota' })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO session_documents'))).toBe(false)
  })

  test('prunes the oldest non-latest version when admitting a new document version', () => {
    const plan = planSessionDocumentPruning([
      version('v1', 'doc', 's1', 3, false, 1),
      version('v2', 'doc', 's1', 3, true, 2),
    ], { documentId: 'doc', sessionId: 's1', byteSize: 3 }, limits)

    expect(plan).toEqual({ accepted: true, deleteVersionIds: ['v1'] })
  })

  test('uses non-latest versions in the session and then the user without deleting a latest', () => {
    const plan = planSessionDocumentPruning([
      version('doc-latest', 'doc', 's1', 5, true, 4),
      version('same-session-old', 'other', 's1', 4, false, 1),
      version('same-session-latest', 'other', 's1', 4, true, 3),
      version('other-session-old', 'third', 's2', 4, false, 2),
      version('other-session-latest', 'third', 's2', 4, true, 5),
    ], { documentId: 'doc', sessionId: 's1', byteSize: 5 }, {
      maxVersionsPerDocument: 5, maxSessionBytes: 14, maxUserBytes: 19,
    })

    expect(plan).toEqual({
      accepted: true,
      deleteVersionIds: ['same-session-old', 'other-session-old'],
    })
  })

  test('rejects without selecting any latest version for deletion', () => {
    const sessionRejected = planSessionDocumentPruning([
      version('latest', 'doc', 's1', 10, true, 1),
    ], { documentId: 'doc', sessionId: 's1', byteSize: 1 }, limits)
    expect(sessionRejected).toEqual({ accepted: false, reason: 'session_quota', deleteVersionIds: [] })

    const userRejected = planSessionDocumentPruning([
      version('s1-latest', 'doc', 's1', 10, true, 1),
      version('s2-latest', 'other', 's2', 10, true, 2),
    ], { documentId: 'doc', sessionId: 's1', byteSize: 1 }, {
      maxVersionsPerDocument: 5, maxSessionBytes: 20, maxUserBytes: 20,
    })
    expect(userRejected).toEqual({ accepted: false, reason: 'user_quota', deleteVersionIds: [] })
  })

  test('commit quota rejection preserves the existing latest and stores no new body', async () => {
    const content = Buffer.from('hello')
    const digest = createHash('sha256').update(content).digest('hex')
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }], rowCount: 1 }
      if (sql.includes('FROM session_document_uploads') && sql.includes('FOR UPDATE')) return { rows: [{
        version_id: 'v-new', user_id: 7, session_id: 's1', document_id: 'd1',
        display_name: 'report.md', document_format: 'markdown', source_turn_id: 't1', source_event_id: 'e1',
        total_bytes: 5, sha256: digest, chunk_count: 1, state: 'pending',
        captured_at: new Date(), expires_at: new Date(Date.now() + 60_000),
      }], rowCount: 1 }
      if (sql.includes('FROM session_document_upload_chunks')) return { rows: [{
        chunk_index: 0, byte_offset: 0, byte_size: 5, sha256: digest, content_bytes: content,
      }], rowCount: 1 }
      if (sql.includes('FROM session_document_versions v') && sql.includes('JOIN session_documents d')) return { rows: [{
        version_id: 'v-latest', document_id: 'd1', session_id: 's1', byte_size: 5, is_latest: true,
        committed_at: new Date('2026-01-01T00:00:00Z'),
      }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    const repository = new SessionDocumentRepository({ query, connect: vi.fn(async () => client) } as any, {
      uploadTimeoutMs: 60_000,
      maxVersionsPerDocument: 5,
      maxSessionBytes: 5,
      maxUserBytes: 5,
    })

    await expect(repository.commitUpload({
      userId: 7, sessionId: 's1', documentId: 'd1', versionId: 'v-new', totalBytes: 5, sha256: digest,
    })).resolves.toEqual({ status: 'rejected', reason: 'session_quota', versionId: 'v-latest' })

    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO session_document_versions'))).toBe(false)
    const rejection = query.mock.calls.find(([sql]) => String(sql).includes("reason_code = 'session_quota'"))
    expect(String(rejection?.[0])).not.toContain('latest_version_id = NULL')
  })
})
