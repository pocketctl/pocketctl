import { createHash } from 'crypto'
import { describe, expect, test, vi } from 'vitest'

import { SessionDocumentArtifactMaterializer } from '../session-documents/materializer.js'

const digest = createHash('sha256').update('hello').digest('hex')

function input(eventType: string, payload: Record<string, unknown>) {
  return {
    inboxId: 11, userId: 7, daemonId: 'daemon-1', daemonGeneration: 12, sessionId: 'session-1', eventType,
    receivedAt: new Date('2026-09-11T00:00:00Z'), context: {}, payload: { type: eventType, ...payload },
  }
}

describe('SessionDocumentArtifactMaterializer', () => {
  test('maps begin, chunks, and commit into the artifact repository without chat deliveries', async () => {
    const repository = {
      beginUpload: vi.fn().mockResolvedValue({ status: 'pending' }),
      recordUnavailable: vi.fn(),
      storeChunk: vi.fn().mockResolvedValue({ status: 'stored' }),
      commitUpload: vi.fn().mockResolvedValue({ status: 'committed', versionId: 'version-1' }),
    }
    const materializer = new SessionDocumentArtifactMaterializer(repository as never, {
      maxDocumentBytes: 2 * 1024 * 1024, maxChunkBytes: 48 * 1024,
    })
    const common = { session_id: 'session-1', document_id: 'document-1', version_id: 'version-1' }

    const beginResult = await materializer.materialize(input('session_document_begin', {
      ...common, event_id: 'begin-1', display_name: 'report.md', document_format: 'markdown',
      source_event_id: 'source-1', turn_id: 'turn-1', total_bytes: 5, content_hash: digest,
      captured_at: '2026-09-11T00:00:00Z', chunk_count: 1,
    }))
    const chunkResult = await materializer.materialize(input('session_document_chunk', {
      ...common, event_id: 'chunk-1', chunk_index: 0, byte_offset: 0,
      chunk_data: Buffer.from('hello').toString('base64'), chunk_hash: digest,
    }))
    const commitResult = await materializer.materialize(input('session_document_commit', {
      ...common, event_id: 'commit-1', total_bytes: 5, content_hash: digest,
    }))

    expect(repository.beginUpload).toHaveBeenCalledOnce()
    expect(repository.storeChunk).toHaveBeenCalledWith(expect.objectContaining({ bytes: Buffer.from('hello') }))
    expect(repository.commitUpload).toHaveBeenCalledOnce()
    for (const result of [beginResult, chunkResult]) {
      expect(result.eventId).toBeNull()
      expect(result.deliveries).toEqual([])
    }
    expect(commitResult.eventId).toBeNull()
    expect(commitResult.deliveries).toEqual([expect.objectContaining({
      audience: 'user', userId: 7, sessionId: 'session-1', type: 'session_documents_changed',
      payload: {
        type: 'session_documents_changed', session_id: 'session-1',
        document_id: 'document-1', version_id: 'version-1',
      },
    })])
    expect(JSON.stringify(commitResult.deliveries)).not.toContain('chunk_data')
    expect(JSON.stringify(commitResult.deliveries)).not.toContain('hello')
  })

  test('rejects malformed content before the repository sees any body', async () => {
    const repository = { beginUpload: vi.fn(), recordUnavailable: vi.fn(), storeChunk: vi.fn(), commitUpload: vi.fn() }
    const materializer = new SessionDocumentArtifactMaterializer(repository as never, {
      maxDocumentBytes: 5, maxChunkBytes: 4,
    })

    await expect(materializer.materialize(input('session_document_chunk', {
      session_id: 'session-1', document_id: 'document-1', version_id: 'version-1', event_id: 'chunk-1',
      chunk_index: 0, byte_offset: 0, chunk_data: 'not-base64!', chunk_hash: digest,
    }))).rejects.toMatchObject({ name: 'SessionDocumentProtocolError' })
    expect(repository.storeChunk).not.toHaveBeenCalled()
  })

  test('emits bounded metadata telemetry without body or host path fields', async () => {
    const observations: unknown[] = []
    const repository = {
      beginUpload: vi.fn(), recordUnavailable: vi.fn(),
      storeChunk: vi.fn().mockResolvedValue({ status: 'stored' }), commitUpload: vi.fn(),
    }
    const materializer = new SessionDocumentArtifactMaterializer(repository as never, {
      maxDocumentBytes: 100, maxChunkBytes: 100,
    }, (observation) => observations.push(observation))
    await materializer.materialize(input('session_document_chunk', {
      session_id: 'session-1', document_id: 'document-1', version_id: 'version-1', event_id: 'chunk-1',
      chunk_index: 0, byte_offset: 0, chunk_data: Buffer.from('hello').toString('base64'), chunk_hash: digest,
    }))

    expect(observations).toEqual([{
      type: 'chunk', state: 'stored', documentId: 'document-1', versionId: 'version-1',
      byteCount: 5, digestPrefix: digest.slice(0, 12),
    }])
    expect(JSON.stringify(observations)).not.toContain('hello')
    expect(JSON.stringify(observations)).not.toContain('path')
  })
})
