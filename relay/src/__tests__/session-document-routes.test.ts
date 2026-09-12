import Fastify from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { resolveSessionDocumentConfig } from '../session-documents/config.js'
import { SessionDocumentNotFoundError } from '../session-documents/repository.js'
import { registerSessionDocumentRoutes } from '../session-documents/routes.js'
import {
  buildStaticHTMLSnapshot,
  removeStaticDocumentChildFrames,
} from '../session-documents/static-snapshot.js'

const apps: Array<ReturnType<typeof Fastify>> = []

function appFor(overrides: Record<string, unknown> = {}) {
  const app = Fastify()
  apps.push(app)
  const repository = {
    listLatest: vi.fn().mockResolvedValue([{
      documentId: 'document-1', displayName: 'report.md', format: 'markdown',
      latestVersionId: 'version-1', byteSize: 5, sha256: 'a'.repeat(64),
      sourceTurnId: 'turn-1', sourceEventId: 'event-1', state: 'available', reasonCode: null,
      capturedAt: new Date('2026-09-11T00:00:00Z'), committedAt: new Date('2026-09-11T00:00:01Z'),
    }]),
    readCommittedContent: vi.fn(),
  }
  registerSessionDocumentRoutes(app, {
    pool: {} as any,
    repository,
    config: resolveSessionDocumentConfig({ RELAY_SESSION_DOCUMENT_LIST: 'on' }),
    verifyAccessToken: vi.fn(async (token: string) => token === 'valid' ? { userId: 7 } : null),
    ...overrides,
  } as any)
  return { app, repository }
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('session document list route', () => {
  test('requires authentication and applies private no-store headers', async () => {
    const { app, repository } = appFor()
    const response = await app.inject({ method: 'GET', url: '/api/sessions/session-1/documents' })

    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(repository.listLatest).not.toHaveBeenCalled()
  })

  test('returns bounded latest metadata without any document body', async () => {
    const { app, repository } = appFor()
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/documents',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(repository.listLatest).toHaveBeenCalledWith(7, 'session-1')
    expect(response.json()).toEqual({
      schema_version: 1,
      html_rendering: false,
      documents: [expect.objectContaining({
        document_id: 'document-1', version_id: 'version-1', display_name: 'report.md',
        format: 'markdown', state: 'available', byte_size: 5, sha256: 'a'.repeat(64),
      })],
    })
    expect(JSON.stringify(response.json())).not.toContain('content_bytes')
  })

  test.each(['foreign', 'unknown'])('returns the same not-found body for a %s session', async () => {
    const repository = { listLatest: vi.fn().mockRejectedValue(new SessionDocumentNotFoundError()), readCommittedContent: vi.fn() }
    const { app } = appFor({ repository })
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/session-hidden/documents',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: { code: 'document_not_found', message: 'Document not found' } })
  })

  test('hides the endpoint when list visibility is disabled', async () => {
    const { app, repository } = appFor({ config: resolveSessionDocumentConfig({}) })
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/documents',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(404)
    expect(repository.listLatest).not.toHaveBeenCalled()
  })
})

describe('session document content route', () => {
  test('returns owner-scoped bytes with digest metadata and non-navigable no-store headers', async () => {
    const content = Buffer.from('<h1>Static</h1><script>alert(1)</script>')
    const repository = {
      listLatest: vi.fn(),
      readCommittedContent: vi.fn().mockResolvedValue({
        bytes: content, byteSize: content.length, sha256: 'b'.repeat(64), format: 'html',
      }),
    }
    const { app } = appFor({ repository })
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/documents/document-1/versions/version-1/content',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(repository.readCommittedContent).toHaveBeenCalledWith(7, 'session-1', 'document-1', 'version-1')
    expect(response.body).toBe(content.toString())
    expect(response.headers['content-type']).toMatch(/^text\/plain/)
    expect(response.headers['content-type']).not.toContain('text/html')
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['x-document-sha256']).toBe('b'.repeat(64))
    expect(response.headers['x-document-size']).toBe(String(content.length))
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
  })

  test.each(['session', 'document', 'version'])('hides %s identifier substitution behind the same 404', async () => {
    const repository = { listLatest: vi.fn(), readCommittedContent: vi.fn().mockRejectedValue(new SessionDocumentNotFoundError()) }
    const { app } = appFor({ repository })
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/foreign-session/documents/foreign-document/versions/foreign-version/content',
      headers: { authorization: 'Bearer valid' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: { code: 'document_not_found', message: 'Document not found' } })
  })

  test('rate limits by authenticated user and session before reading bytes', async () => {
    const rateLimiter = { allow: vi.fn().mockReturnValue(false) }
    const { app, repository } = appFor({ rateLimiter })
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/documents/document-1/versions/version-1/content',
      headers: { authorization: 'Bearer valid' },
    })
    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('60')
    expect(rateLimiter.allow).toHaveBeenCalledWith(7, 'session-1')
    expect(repository.readCommittedContent).not.toHaveBeenCalled()
  })

  test('cannot turn the content API into an arbitrary host-path read', async () => {
    const repository = {
      listLatest: vi.fn(),
      readCommittedContent: vi.fn().mockResolvedValue({
        bytes: Buffer.from('stored snapshot'), byteSize: 15, sha256: 'f'.repeat(64), format: 'markdown',
      }),
    }
    const { app } = appFor({ repository })
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/documents/document-1/versions/version-1/content?path=%2Fetc%2Fpasswd',
      headers: { authorization: 'Bearer valid' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('stored snapshot')
    expect(repository.readCommittedContent).toHaveBeenCalledWith(7, 'session-1', 'document-1', 'version-1')
    expect(JSON.stringify(repository.readCommittedContent.mock.calls)).not.toContain('/etc/passwd')

    const extraPath = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/documents/document-1/versions/version-1/content/%2Fetc%2Fpasswd',
      headers: { authorization: 'Bearer valid' },
    })
    expect(extraPath.statusCode).toBe(404)
    expect(repository.readCommittedContent).toHaveBeenCalledTimes(1)
  })
})

describe('session document download route', () => {
  test('downloads Markdown as inert plain text', async () => {
    const repository = {
      listLatest: vi.fn(),
      readCommittedContent: vi.fn().mockResolvedValue({
        bytes: Buffer.from('# Report\n<script>alert(1)</script>'), byteSize: 34,
        sha256: 'c'.repeat(64), format: 'markdown', displayName: 'report.md',
      }),
    }
    const { app } = appFor({ repository })
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/documents/document-1/versions/version-1/download',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/^text\/plain/)
    expect(response.headers['content-disposition']).toContain('attachment')
    expect(response.headers['content-disposition']).toContain('report.md')
  })

  test('keeps HTML download hidden until its independent security gate is enabled', async () => {
    const repository = {
      listLatest: vi.fn(),
      readCommittedContent: vi.fn().mockResolvedValue({
        bytes: Buffer.from('<h1>Report</h1>'), byteSize: 15,
        sha256: 'd'.repeat(64), format: 'html', displayName: 'report.html',
      }),
    }
    const { app } = appFor({ repository })
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/documents/document-1/versions/version-1/download',
      headers: { authorization: 'Bearer valid' },
    })
    expect(response.statusCode).toBe(404)
  })

  test('downloads enabled HTML only as a sandboxed static wrapper', async () => {
    const hostile = '<script>parent.document.body.innerHTML="owned"</script><img src="https://attacker.invalid/x">'
    const repository = {
      listLatest: vi.fn(),
      readCommittedContent: vi.fn().mockResolvedValue({
        bytes: Buffer.from(hostile), byteSize: Buffer.byteLength(hostile),
        sha256: 'e'.repeat(64), format: 'html', displayName: 'report.html',
      }),
    }
    const config = resolveSessionDocumentConfig({
      RELAY_SESSION_DOCUMENT_LIST: 'on',
      RELAY_SESSION_DOCUMENT_HTML_DOWNLOAD: 'on',
    })
    const { app } = appFor({ repository, config })
    const response = await app.inject({
      method: 'GET', url: '/api/sessions/session-1/documents/document-1/versions/version-1/download',
      headers: { authorization: 'Bearer valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/^text\/html/)
    expect(response.headers['content-disposition']).toContain('attachment')
    expect(response.body).toContain('<iframe sandbox')
    expect(response.body).not.toContain('<script>parent.document')
    expect(response.body).toContain('&lt;script&gt;')
    expect(response.body).toContain("default-src 'none'")
  })

  test('static wrapper escapes attribute boundaries and grants no sandbox capability', () => {
    const wrapper = buildStaticHTMLSnapshot('\"><script>alert(1)</script>')
    expect(wrapper).toContain('<iframe sandbox=""')
    expect(wrapper).not.toMatch(/allow-(scripts|same-origin|forms|popups|top-navigation)/)
    expect(wrapper).not.toContain('\"><script>alert(1)</script>')
    expect(wrapper).toContain('&quot;&gt;&lt;script&gt;')
  })

  test('static wrapper removes child browsing contexts while preserving surrounding content', () => {
    const source = '<p>before</p><iframe src="https://attacker.invalid/frame">fallback</iframe><frame src=x><p>after</p>'
    const staticSource = removeStaticDocumentChildFrames(source)
    const wrapper = buildStaticHTMLSnapshot(source)

    expect(staticSource).toBe('<p>before</p>fallback<p>after</p>')
    expect(wrapper).toContain('&lt;p&gt;before&lt;/p&gt;fallback&lt;p&gt;after&lt;/p&gt;')
    expect(wrapper).not.toMatch(/&lt;\/?(?:iframe|frame)\b/i)
  })
})
