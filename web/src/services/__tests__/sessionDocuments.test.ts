import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'

const accessToken = ref('user-token')
const doRefreshToken = vi.fn()

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ accessToken, doRefreshToken }),
}))
vi.mock('../../composables/useEnv', () => ({ getRelayOrigin: () => 'https://relay.example' }))

import {
  SessionDocumentApiError,
  fetchSessionDocumentContent,
  listSessionDocuments,
} from '../sessionDocuments'

const digest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

describe('sessionDocuments client', () => {
  beforeEach(() => {
    accessToken.value = 'user-token'
    doRefreshToken.mockReset().mockResolvedValue(false)
    vi.restoreAllMocks()
  })

  test('lists bounded typed metadata using authenticated no-store request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema_version: 1,
      html_rendering: false,
      documents: [{
        document_id: 'doc-1', version_id: 'ver-1', display_name: 'notes.md', format: 'markdown',
        state: 'available', reason: null, byte_size: 5, sha256: digest,
        source_turn_id: 'turn-1', source_event_id: 'event-1',
        captured_at: '2026-09-11T00:00:00.000Z', committed_at: '2026-09-11T00:00:01.000Z',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await listSessionDocuments('session / 1')

    expect(result.documents[0]).toMatchObject({ documentId: 'doc-1', byteSize: 5, format: 'markdown' })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://relay.example/api/sessions/session%20%2F%201/documents',
      expect.objectContaining({ cache: 'no-store', credentials: 'include', redirect: 'error' }),
    )
    expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer user-token')
  })

  test('verifies the exact bytes against metadata and response integrity headers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('hello', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-document-sha256': digest,
        'x-document-size': '5',
        'x-document-format': 'markdown',
      },
    }))

    const content = await fetchSessionDocumentContent('session-1', {
      documentId: 'doc-1', versionId: 'ver-1', displayName: 'notes.md', format: 'markdown',
      state: 'available', reason: null, byteSize: 5, sha256: digest,
      sourceTurnId: 'turn-1', sourceEventId: 'event-1', capturedAt: 'now', committedAt: 'now',
    })

    expect(content.text).toBe('hello')
    expect(content.bytes).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
  })

  test.each([
    ['metadata size', { body: 'hello!', size: '6', hash: digest, format: 'markdown' }],
    ['response size', { body: 'hello', size: '4', hash: digest, format: 'markdown' }],
    ['digest', { body: 'hello', size: '5', hash: '0'.repeat(64), format: 'markdown' }],
    ['format', { body: 'hello', size: '5', hash: digest, format: 'html' }],
  ])('rejects an integrity mismatch in %s', async (_label, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(response.body, {
      status: 200,
      headers: {
        'x-document-sha256': response.hash,
        'x-document-size': response.size,
        'x-document-format': response.format,
      },
    }))
    const metadata = {
      documentId: 'doc-1', versionId: 'ver-1', displayName: 'notes.md', format: 'markdown' as const,
      state: 'available' as const, reason: null, byteSize: 5, sha256: digest,
      sourceTurnId: 'turn-1', sourceEventId: 'event-1', capturedAt: 'now', committedAt: 'now',
    }

    await expect(fetchSessionDocumentContent('session-1', metadata)).rejects.toMatchObject({
      code: 'integrity_failed',
    })
  })

  test('refreshes once on 401 and maps ownership failure without leaking identifiers', async () => {
    doRefreshToken.mockResolvedValueOnce(true)
    accessToken.value = 'expired'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockImplementationOnce(async (_url, init) => {
        accessToken.value = 'fresh'
        return new Response(JSON.stringify({ error: { code: 'document_not_found' } }), {
          status: 404, headers: { 'content-type': 'application/json' },
        })
      })

    let caught: unknown
    try { await listSessionDocuments('session-secret') } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(SessionDocumentApiError)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect((caught as SessionDocumentApiError).code).toBe('ownership_failure')
  })
})
