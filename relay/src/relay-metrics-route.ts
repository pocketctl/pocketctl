import type { FastifyInstance } from 'fastify'

export function registerRelayMetricsRoute(
  app: FastifyInstance,
  dependencies: {
    verifyAccessToken(token: string): Promise<unknown>
    metrics(): Promise<string>
  },
): void {
  app.get('/internal/metrics', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401)
      return { error: 'authorization required' }
    }
    if (!await dependencies.verifyAccessToken(authHeader.slice(7))) {
      reply.code(401)
      return { error: 'invalid token' }
    }
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    return dependencies.metrics()
  })
}
