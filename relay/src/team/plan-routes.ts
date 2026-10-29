import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { TeamTaskContextService } from './task-context-service.js'
import type { TaskPlanInput } from './plan-contract.js'
import type { TeamPlanService } from './plan-service.js'
import type { PlanControlInput, TeamPlanExecutionService } from './plan-execution-service.js'
import { TeamRepositoryError } from './repository.js'

export function registerTeamPlanRoutes(app: FastifyInstance, deps: {
  service: Pick<TeamPlanService, 'getPlan' | 'saveDraft' | 'lookupReceipt'> & Partial<Pick<TeamPlanService, 'editingOptions'>>
  context?: Pick<TeamTaskContextService, 'resolve'>
  execution?: Pick<TeamPlanExecutionService, 'getExecution' | 'control' | 'lookupReceipt'>
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady(): boolean
}): void {
  const route = (run: (request: FastifyRequest, actor: number, params: { taskId: string; requestId?: string }) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store')
      const header = request.headers.authorization
      const actor = header?.startsWith('Bearer ') ? await deps.verifyAccessToken(header.slice(7).trim()) : null
      if (!actor) return reply.code(401).send({ error: { code: 'authorization_required', retryable: false } })
      if (!deps.getDatabaseReady()) return reply.code(503).send({ error: { code: 'database_unavailable', retryable: true } })
      try {
        const params = request.params as { taskId: string; requestId?: string }
        if (Object.values(params).some(value => !value || value.length > 128)) throw new TeamRepositoryError('invalid_request', 'invalid resource ID')
        return await run(request, actor.userId, params)
      } catch (error) {
        if (!(error instanceof TeamRepositoryError)) throw error
        const status = error.code === 'invalid_request' ? 400 : ['creator_required', 'reviewer_required', 'participant_required', 'team_access_denied'].includes(error.code) ? 403
          : error.code === 'team_not_found' ? 404 : error.code === 'team_feature_disabled' ? 503 : 409
        return reply.code(status).send({ error: { code: error.code, message: error.message, retryable: ['revision_conflict', 'context_revision_conflict'].includes(error.code),
          ...(error.currentRevision === undefined ? {} : { current_revision: error.currentRevision }) } })
      }
    }
  if (deps.context) {
    const context = deps.context
    app.get('/api/team/tasks/:taskId/context', route(async (request, actor, params) => {
      const query = request.query as Record<string, unknown>
      if (Object.keys(query).some(k => k !== 'attempt_id') || (query.attempt_id !== undefined && typeof query.attempt_id !== 'string')) throw new TeamRepositoryError('invalid_request', 'invalid task context query')
      return context.resolve(params.taskId, actor, query.attempt_id as string | undefined)
    }))
  }
  const base = '/api/team/tasks/:taskId/plan'
  app.get(base, route(async (request, actor, params) => {
    const query = request.query as Record<string, unknown>
    if (Object.keys(query).some(key => key !== 'revision') || (query.revision !== undefined && (typeof query.revision !== 'string' || !/^[1-9]\d*$/.test(query.revision)))) throw new TeamRepositoryError('invalid_request', 'invalid plan query')
    return deps.service.getPlan(params.taskId, actor, query.revision === undefined ? undefined : Number(query.revision))
  }))
  if(deps.service.editingOptions) app.get(`${base}/options`, route(async (_request,actor,params)=>deps.service.editingOptions!(params.taskId,actor)))
  app.post(base, { bodyLimit: 128 * 1024 }, route(async (request, actor, params) => deps.service.saveDraft(params.taskId, actor, request.body as TaskPlanInput)))
  app.get(`${base}/receipt-lookup/:requestId`, route(async (_request, actor, params) => deps.service.lookupReceipt(params.taskId, actor, params.requestId!)))
  if (deps.execution) {
    const execution = deps.execution
    const noQuery = (request: FastifyRequest) => {
      if (Object.keys(request.query as object).length) throw new TeamRepositoryError('invalid_request', 'unexpected execution query')
    }
    app.get(`${base}/execution`, route(async (request, actor, params) => { noQuery(request); return execution.getExecution(params.taskId, actor) }))
    app.post(`${base}/execution`, { bodyLimit: 4096 }, route(async (request, actor, params) => { noQuery(request); return execution.control(params.taskId, actor, request.body as PlanControlInput) }))
    app.get(`${base}/execution/receipt-lookup/:requestId`, route(async (request, actor, params) => { noQuery(request); return execution.lookupReceipt(params.taskId, actor, params.requestId!) }))
  }
}
