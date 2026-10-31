import type { FastifyInstance } from 'fastify'
import { GitProjectError, parseGitProject, type GitProjectService } from './git-projects.js'

export function registerGitProjectRoutes(app: FastifyInstance, deps: {
  service: GitProjectService; enabled: () => boolean; getDatabaseReady: () => boolean
  verifyAccessToken: (token: string) => Promise<{ userId: number } | null>
  initializeMemory?: (teamId: string, actor: number) => Promise<{ installation_id: string }>
}) {
  const route = (method: 'GET' | 'POST', url: string) => app.route({ method, url, bodyLimit: 16 * 1024,
    handler: async (request, reply) => {
      const failure = (status: number, code: string) => reply.code(status).send({ error: { code, message: code } })
      const header = request.headers.authorization
      const actor = header?.startsWith('Bearer ') ? await deps.verifyAccessToken(header.slice(7)) : null
      if (!actor) return failure(401, 'authorization_required')
      if (!deps.getDatabaseReady() || !deps.enabled()) return failure(503, 'team_feature_disabled')
      try {
        if (method === 'GET') return await deps.service.list(actor.userId)
        const input = parseGitProject(request.body)
        const team = (request.params as { teamId: string }).teamId
        if (!/^ctm_[a-zA-Z0-9-]{1,100}$/.test(team)) return failure(400, 'invalid_request')
        const result = await deps.service.create(team, actor.userId, input)
        return reply.code(result.created ? 201 : 200).send({ project: result.project })
      } catch (error) {
        if (!(error instanceof GitProjectError)) {
          app.log.error({ code: error instanceof Error ? error.name : 'unknown' }, 'Git project request failed')
          return failure(500, 'project_unavailable')
        }
        const status = error.code === 'invalid_request' ? 400 : ['creator_required', 'team_access_denied'].includes(error.code) ? 403 : 409
        return failure(status, error.code)
      }
    },
  })
  route('GET', '/api/team/git-projects')
  route('POST', '/api/team/teams/:teamId/git-projects')
  app.post('/api/team/teams/:teamId/git-memory', { bodyLimit: 1024 }, async (request, reply) => {
    const header = request.headers.authorization
    const actor = header?.startsWith('Bearer ') ? await deps.verifyAccessToken(header.slice(7)) : null
    const fail = (status:number, code:string) => reply.code(status).send({error:{code,message:code}})
    if (!actor) return fail(401,'authorization_required')
    if (!deps.enabled() || !deps.getDatabaseReady() || !deps.initializeMemory) return fail(503,'team_feature_disabled')
    const teamId = (request.params as {teamId:string}).teamId
    const body = request.body as Record<string,unknown> | null
    if (!/^ctm_[a-zA-Z0-9-]{1,100}$/.test(teamId) || !body || Object.keys(body).length !== 1 || body.confirm_shared_memory !== true) return fail(400,'invalid_request')
    try { return await deps.initializeMemory(teamId, actor.userId) }
    catch (error) { return fail(error instanceof GitProjectError ? 403 : 503, error instanceof GitProjectError ? error.code : 'team_feature_disabled') }
  })
}
