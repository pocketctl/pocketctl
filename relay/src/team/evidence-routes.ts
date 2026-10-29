import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { TeamEvidenceService, TrustedEvidenceInput } from './evidence-service.js'
import { TeamRepositoryError } from './repository.js'

export function registerTeamEvidenceRoutes(app: FastifyInstance, deps: {
  service: TeamEvidenceService
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady(): boolean
}) {
  const route = (read: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      if (!deps.getDatabaseReady()) return reply.code(503).send({ error: { code: 'database_unavailable' } })
      if (Object.keys(request.query as object).length) throw new TeamRepositoryError('invalid_request', 'unexpected evidence query')
      const { taskId, connectorId, evidenceId } = request.params as { taskId: string; connectorId: string; evidenceId: string }
      if (!read) return await deps.service.receive(taskId, connectorId, request.headers.authorization, request.body as TrustedEvidenceInput)
      const header = request.headers.authorization
      const actor = header?.startsWith('Bearer ') ? await deps.verifyAccessToken(header.slice(7).trim()) : null
      if (!actor) throw new TeamRepositoryError('authorization_required', 'authorization required')
      const report = await deps.service.readReport(taskId, evidenceId, actor.userId)
      return reply.header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', `attachment; filename="evidence-${evidenceId}.txt"`).header('X-Content-SHA256', report.sha256)
        .type('text/plain; charset=utf-8').send(report.bytes)
    } catch (error) {
      if (!(error instanceof TeamRepositoryError)) throw error
      const status = error.code === 'authorization_required' ? 401 : error.code === 'team_access_denied' ? 403
        : error.code === 'team_not_found' ? 404 : error.code === 'team_feature_disabled' ? 503
          : ['invalid_request','artifact_integrity'].includes(error.code) ? 400 : 409
      return reply.code(status).send({ error: { code: error.code, message: error.message, retryable: false } })
    }
  }
  app.post('/api/team-evidence/connectors/:connectorId/tasks/:taskId/reports', { bodyLimit: 3 * 1024 * 1024 }, route(false))
  app.get('/api/team/tasks/:taskId/trusted-evidence/:evidenceId/report', route(true))
}
