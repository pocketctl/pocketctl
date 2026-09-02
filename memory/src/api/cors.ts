import type { FastifyInstance } from 'fastify'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { MemoryApiError, errorBody } from './errors.js'

const registered = new WeakSet<FastifyInstance>()

/** Shared by independently registered REST surfaces, including Skill shadow mode. */
export function registerMemoryCors(app: FastifyInstance, policy: CorsHostPolicy): void {
  if (registered.has(app)) return
  registered.add(app)
  app.addHook('onRequest', async (request, reply) => {
    if (!policy.hostAllowed(request.headers.host)) {
      return reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'host rejected')))
    }
    if (!policy.originAllowed(request.headers.origin)) {
      return reply.code(403).send(errorBody(new MemoryApiError('forbidden', 'origin rejected')))
    }
    if (request.headers.origin) {
      reply.header('access-control-allow-origin', request.headers.origin)
      reply.header('vary', 'origin')
    }
  })
  app.options('/api/v1/memory/*', async (_request, reply) => {
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    reply.header('access-control-allow-headers', 'authorization, content-type, idempotency-key')
    reply.header('access-control-max-age', '600')
    return ''
  })
}
