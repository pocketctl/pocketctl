import { describe, expect, test, vi } from 'vitest'

import { initDB } from '../db.js'
import { initSessionDocumentSchema } from '../session-documents/schema.js'

describe('session document schema bootstrap', () => {
  test('creates owner-scoped projections, immutable versions, uploads, and chunks', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await initSessionDocumentSchema({ query } as never)

    expect(query).toHaveBeenCalledOnce()
    const sql = String(query.mock.calls[0]?.[0]).replace(/\s+/g, ' ')
    for (const table of [
      'session_documents',
      'session_document_versions',
      'session_document_uploads',
      'session_document_upload_chunks',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(sql).toContain('FOREIGN KEY (user_id, session_id) REFERENCES sessions(user_id, session_id) ON DELETE CASCADE')
    expect(sql).toContain('FOREIGN KEY (user_id, session_id, document_id) REFERENCES session_documents(user_id, session_id, document_id) ON DELETE CASCADE')
    expect(sql).toContain('UNIQUE (document_id, sha256)')
    expect(sql).toContain('PRIMARY KEY (version_id, chunk_index)')
    expect(sql).toContain('REFERENCES session_document_uploads(version_id) ON DELETE CASCADE')
    expect(sql).toContain('prevent_session_document_version_update')
    expect(sql).toContain('idx_session_documents_session_latest')
    expect(sql).toContain('idx_session_document_versions_prune')
    expect(sql).toContain('idx_session_document_uploads_expiry')
  })

  test('is included in the serialized main database bootstrap', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await initDB({ query } as never)

    const statements = query.mock.calls.map((call) => String(call[0])).join('\n')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS session_documents')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS session_document_versions')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS session_document_uploads')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS session_document_upload_chunks')
  })
})
