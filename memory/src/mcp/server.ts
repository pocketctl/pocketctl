import { AsyncLocalStorage } from 'node:async_hooks'
import { McpServer, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { GrantGuard } from '../auth/grant-guard.js'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { MemoryApiError, errorBody } from '../api/errors.js'
import { registerMemoryTools } from './tools.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'

/**
 * Stateless read-only MCP endpoint (ADR-P1-05). The bearer Capability Grant
 * is verified BEFORE anything reaches the SDK; the verified installation
 * context travels to tool handlers through request-scoped async storage, so
 * tools can only ever see the caller's own installation. Only JSON responses
 * are served; no prompts, raw-payload resources, sampling, elicitation,
 * write tools, or server-initiated notifications exist.
 */

const requestScope = new AsyncLocalStorage<{ installationId: string }>()

export interface McpRouteDeps {
  pool: pg.Pool
  guard: GrantGuard
  policy: CorsHostPolicy
  rateLimiter?: { check(key: string): { allowed: boolean } }
  providerVersion: string
  recallEmbeddingTimeoutMs: number
  cursorSigningKey: string
  embed?: EmbeddingProvider & { provider: string; model: string }
  embeddingConsentFingerprint?: string
}

export function createMemoryMcpHandler(deps: McpRouteDeps): McpHttpHandler {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'pocketctl-memory', version: deps.providerVersion })
    registerMemoryTools(server, {
      pool: deps.pool,
      installationId: () => requestScope.getStore()?.installationId ?? '',
      recallEmbeddingTimeoutMs: deps.recallEmbeddingTimeoutMs,
      cursorSigningKey: deps.cursorSigningKey,
      ...(deps.embed ? { embed: deps.embed } : {}),
      ...(deps.embeddingConsentFingerprint
        ? { embeddingConsentFingerprint: deps.embeddingConsentFingerprint }
        : {}),
    })
    return server
  }, { responseMode: 'json' })
}

export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): void {
  const handler = createMemoryMcpHandler(deps)
  const authenticated = new WeakMap<object, string>()

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] !== '/mcp') return
    if (!deps.policy.hostAllowed(request.headers.host)) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'host rejected')))
      return reply
    }
    if (!deps.policy.originAllowed(request.headers.origin)) {
      reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'origin rejected')))
      return reply
    }
    if (request.method === 'POST') {
      try {
        const grant = await deps.guard.guard({
          authorization: request.headers.authorization,
          requiredService: 'memory.mcp',
        })
        if (deps.rateLimiter && !deps.rateLimiter.check(`memory.mcp:${grant.installationId}`).allowed) {
          reply.code(429).send(errorBody(new MemoryApiError('rate_limited', 'rate limit exceeded')))
          return reply
        }
        authenticated.set(request, grant.installationId)
      } catch (error) {
        if (error instanceof MemoryApiError) {
          reply.code(error.httpStatus).send(errorBody(error))
          return reply
        }
        reply.code(401).send(errorBody(new MemoryApiError('unauthorized', 'grant rejected')))
        return reply
      }
    }
  })

  app.get('/mcp', async (_request, reply) => {
    // Stateless JSON-only serving has no stream leg.
    reply.code(405)
    return errorBody(new MemoryApiError('invalid_request', 'POST only'))
  })

  app.post('/mcp', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const contentType = String(request.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      reply.code(415)
      return errorBody(new MemoryApiError('invalid_request', 'content-type must be application/json'))
    }
    const installationId = authenticated.get(request)
    if (!installationId) {
      reply.code(401)
      return errorBody(new MemoryApiError('unauthorized', 'grant rejected'))
    }

    const body = typeof request.body === 'string' || request.body === undefined
      ? request.body
      : JSON.stringify(request.body)
    const url = request.protocol === 'https'
      ? `https://${request.headers.host}${request.url}`
      : `http://${request.headers.host}${request.url}`
    const incoming = new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The SDK contract requires accepting both media types; the handler
        // may choose a single SSE-framed JSON-RPC response for a call.
        accept: 'application/json, text/event-stream',
        ...(request.headers['mcp-session-id']
          ? { 'mcp-session-id': String(request.headers['mcp-session-id']) }
          : {}),
      },
      ...(body !== undefined ? { body: body as string } : {}),
    })
    const response = await requestScope.run({ installationId }, () => handler.fetch(incoming))
    reply.code(response.status)
    const responseContentType = response.headers.get('content-type')
    if (responseContentType) reply.header('content-type', responseContentType)
    return Buffer.from(await response.arrayBuffer())
  })
}
