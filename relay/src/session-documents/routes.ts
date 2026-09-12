import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'

import type { SessionDocumentConfig } from './config.js'
import {
  SessionDocumentNotFoundError,
  type SessionDocumentMetadata,
  type SessionDocumentRepository,
} from './repository.js'
import {
  buildStaticHTMLSnapshot,
  STATIC_SNAPSHOT_WRAPPER_POLICY,
} from './static-snapshot.js'

interface SessionDocumentRouteDependencies {
  pool: pg.Pool
  repository: Pick<SessionDocumentRepository, 'listLatest' | 'readCommittedContent'>
  config: SessionDocumentConfig
  verifyAccessToken(token: string, pool: pg.Pool): Promise<{ userId: number } | null>
  rateLimiter?: { allow(userId: number, sessionId: string): boolean }
}

export class SessionDocumentReadLimiter {
  private readonly users = new Map<number, { window: number; count: number }>()
  private readonly sessions = new Map<string, { window: number; count: number }>()

  constructor(
    private readonly maxPerUser = 120,
    private readonly maxPerSession = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(userId: number, sessionId: string): boolean {
    const window = Math.floor(this.now() / this.windowMs)
    const user = this.users.get(userId)
    const sessionKey = `${userId}\0${sessionId}`
    const session = this.sessions.get(sessionKey)
    const userCount = user?.window === window ? user.count : 0
    const sessionCount = session?.window === window ? session.count : 0
    if (userCount >= this.maxPerUser || sessionCount >= this.maxPerSession) return false
    this.users.set(userId, { window, count: userCount + 1 })
    this.sessions.set(sessionKey, { window, count: sessionCount + 1 })
    if (this.users.size > 10_000 || this.sessions.size > 50_000) this.compact(window)
    return true
  }

  private compact(currentWindow: number): void {
    for (const [key, value] of this.users) if (value.window !== currentWindow) this.users.delete(key)
    for (const [key, value] of this.sessions) if (value.window !== currentWindow) this.sessions.delete(key)
  }
}

function privateHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, no-store')
  reply.header('Pragma', 'no-cache')
  reply.header('X-Content-Type-Options', 'nosniff')
}

function error(reply: FastifyReply, status: number, code: string, message: string) {
  reply.code(status)
  return { error: { code, message } }
}

function notFound(reply: FastifyReply) {
  return error(reply, 404, 'document_not_found', 'Document not found')
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && value === value.trim() && !value.startsWith('pending-') && !value.includes('\0')
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value === value.trim() && !value.includes('\0')
}

function attachmentName(displayName: string, format: 'markdown' | 'html'): string {
  const normalized = displayName.replace(/[\r\n\0]/g, '').trim()
  const fallbackBase = normalized
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100) || 'document'
  const fallback = format === 'html'
    ? `${fallbackBase.replace(/\.html?$/i, '') || 'document'}.static.html`
    : fallbackBase
  const utf8Name = format === 'html'
    ? `${normalized.replace(/\.html?$/i, '') || 'document'}.static.html`
    : normalized || 'document.md'
  return `attachment; filename="${fallback.replaceAll('"', '_')}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`
}

async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: SessionDocumentRouteDependencies,
): Promise<{ userId: number } | null> {
  privateHeaders(reply)
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  return dependencies.verifyAccessToken(authorization.slice(7), dependencies.pool)
}

function metadataDTO(document: SessionDocumentMetadata) {
  return {
    document_id: document.documentId,
    version_id: document.latestVersionId,
    display_name: document.displayName,
    format: document.format,
    state: document.state,
    reason: document.reasonCode,
    byte_size: document.byteSize,
    sha256: document.sha256,
    source_turn_id: document.sourceTurnId,
    source_event_id: document.sourceEventId,
    captured_at: document.capturedAt.toISOString(),
    committed_at: document.committedAt?.toISOString() ?? null,
  }
}

export function registerSessionDocumentRoutes(
  app: FastifyInstance,
  dependencies: SessionDocumentRouteDependencies,
): void {
  const rateLimiter = dependencies.rateLimiter ?? new SessionDocumentReadLimiter()
  app.get('/api/sessions/:sessionId/documents', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return error(reply, 401, 'unauthorized', 'Unauthorized')
    if (dependencies.config.listVisibility !== 'on') return notFound(reply)
    const sessionId = (req.params as { sessionId?: unknown }).sessionId
    if (!validSessionId(sessionId)) return notFound(reply)
    try {
      const documents = await dependencies.repository.listLatest(access.userId, sessionId)
      return {
        schema_version: 1,
        html_rendering: dependencies.config.htmlRendering === 'on',
        documents: documents.slice(0, dependencies.config.maxDocumentsPerSession).map(metadataDTO),
      }
    } catch (caught) {
      if (caught instanceof SessionDocumentNotFoundError) return notFound(reply)
      throw caught
    }
  })

  app.get('/api/sessions/:sessionId/documents/:documentId/versions/:versionId/content', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return error(reply, 401, 'unauthorized', 'Unauthorized')
    if (dependencies.config.listVisibility !== 'on') return notFound(reply)
    const params = req.params as Record<string, unknown>
    if (!validSessionId(params.sessionId) || !validOpaqueId(params.documentId)
      || !validOpaqueId(params.versionId)) return notFound(reply)
    if (!rateLimiter.allow(access.userId, params.sessionId)) {
      reply.header('Retry-After', '60')
      return error(reply, 429, 'rate_limited', 'Too many document requests')
    }
    try {
      const content = await dependencies.repository.readCommittedContent(
        access.userId, params.sessionId, params.documentId, params.versionId,
      )
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      reply.header('X-Document-SHA256', content.sha256)
      reply.header('X-Document-Size', String(content.byteSize))
      reply.header('X-Document-Format', content.format)
      reply.type('text/plain; charset=utf-8')
      return reply.send(content.bytes)
    } catch (caught) {
      if (caught instanceof SessionDocumentNotFoundError) return notFound(reply)
      throw caught
    }
  })

  app.get('/api/sessions/:sessionId/documents/:documentId/versions/:versionId/download', async (req, reply) => {
    const access = await authenticate(req, reply, dependencies)
    if (!access) return error(reply, 401, 'unauthorized', 'Unauthorized')
    if (dependencies.config.listVisibility !== 'on') return notFound(reply)
    const params = req.params as Record<string, unknown>
    if (!validSessionId(params.sessionId) || !validOpaqueId(params.documentId)
      || !validOpaqueId(params.versionId)) return notFound(reply)
    if (!rateLimiter.allow(access.userId, params.sessionId)) {
      reply.header('Retry-After', '60')
      return error(reply, 429, 'rate_limited', 'Too many document requests')
    }
    try {
      const content = await dependencies.repository.readCommittedContent(
        access.userId, params.sessionId, params.documentId, params.versionId,
      )
      if (content.format === 'html' && dependencies.config.htmlDownload !== 'on') {
        return notFound(reply)
      }
      reply.header('Content-Disposition', attachmentName(content.displayName, content.format))
      reply.header('X-Document-SHA256', content.sha256)
      reply.header('X-Document-Size', String(content.byteSize))
      reply.header('X-Document-Format', content.format)
      if (content.format === 'html') {
        reply.header('Content-Security-Policy', STATIC_SNAPSHOT_WRAPPER_POLICY)
        reply.type('text/html; charset=utf-8')
        return reply.send(buildStaticHTMLSnapshot(content.bytes.toString('utf8')))
      }
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      reply.type('text/plain; charset=utf-8')
      return reply.send(content.bytes)
    } catch (caught) {
      if (caught instanceof SessionDocumentNotFoundError) return notFound(reply)
      throw caught
    }
  })
}
