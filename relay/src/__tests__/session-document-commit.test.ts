import { createHash } from 'crypto'
import { describe, expect, test, vi } from 'vitest'

import {
  assembleSessionDocument,
  SessionDocumentIntegrityError,
  SessionDocumentRepository,
} from '../session-documents/repository.js'

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('session document commit', () => {
  test('assembles exact contiguous bytes and verifies the final digest', () => {
    const bytes = assembleSessionDocument([
      { chunkIndex: 0, byteOffset: 0, bytes: Buffer.from('hel'), sha256: sha('hel') },
      { chunkIndex: 1, byteOffset: 3, bytes: Buffer.from('lo'), sha256: sha('lo') },
    ], { chunkCount: 2, totalBytes: 5, sha256: sha('hello') })

    expect(bytes).toEqual(Buffer.from('hello'))
  })

  test.each([
    {
      name: 'missing chunk',
      chunks: [{ chunkIndex: 0, byteOffset: 0, bytes: Buffer.from('hel'), sha256: sha('hel') }],
      expected: { chunkCount: 2, totalBytes: 5, sha256: sha('hello') },
    },
    {
      name: 'gap',
      chunks: [
        { chunkIndex: 0, byteOffset: 0, bytes: Buffer.from('he'), sha256: sha('he') },
        { chunkIndex: 1, byteOffset: 3, bytes: Buffer.from('lo'), sha256: sha('lo') },
      ],
      expected: { chunkCount: 2, totalBytes: 5, sha256: sha('hello') },
    },
    {
      name: 'final digest mismatch',
      chunks: [{ chunkIndex: 0, byteOffset: 0, bytes: Buffer.from('hello'), sha256: sha('hello') }],
      expected: { chunkCount: 1, totalBytes: 5, sha256: sha('other') },
    },
  ])('rejects $name without exposing partial content', ({ chunks, expected }) => {
    expect(() => assembleSessionDocument(chunks, expected)).toThrow(SessionDocumentIntegrityError)
  })

  test('atomically promotes a verified upload and removes its assembly', async () => {
    const content = Buffer.from('hello')
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => {
      queries.push(sql)
      if (sql.includes('AS session_allowed')) return { rows: [{ session_allowed: true, tombstoned: false }], rowCount: 1 }
      if (sql.includes('FROM session_document_uploads') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          version_id: 'v1', user_id: 7, session_id: 's1', document_id: 'd1',
          display_name: 'report.md', document_format: 'markdown', source_turn_id: 't1',
          source_event_id: 'e1', total_bytes: 5, sha256: sha(content), chunk_count: 1,
          state: 'pending', captured_at: new Date('2026-09-11T00:00:00Z'),
          expires_at: new Date(Date.now() + 60_000),
        }], rowCount: 1 }
      }
      if (sql.includes('FROM session_document_upload_chunks') && sql.includes('ORDER BY')) {
        return { rows: [{ chunk_index: 0, byte_offset: 0, byte_size: 5, sha256: sha(content), content_bytes: content }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO session_document_versions')) return { rows: [{ version_id: 'v1' }], rowCount: 1 }
      if (sql.includes('UPDATE session_documents')) return { rows: [{ document_id: 'd1' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    const repository = new SessionDocumentRepository({ query, connect: vi.fn(async () => client) } as any, { uploadTimeoutMs: 60_000 })

    await expect(repository.commitUpload({
      userId: 7, sessionId: 's1', documentId: 'd1', versionId: 'v1',
      totalBytes: 5, sha256: sha(content),
    })).resolves.toEqual({ status: 'committed', versionId: 'v1' })

    expect(queries.findIndex((sql) => sql.includes('INSERT INTO session_document_versions')))
      .toBeLessThan(queries.findIndex((sql) => sql.includes('UPDATE session_documents')))
    expect(queries.findIndex((sql) => sql.includes('UPDATE session_documents')))
      .toBeLessThan(queries.findIndex((sql) => sql.includes('DELETE FROM session_document_uploads')))
    expect(queries.at(-1)).toBe('COMMIT')
  })
})
