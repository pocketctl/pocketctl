import type {TeamExternalStopService,ExternalStopReport} from './external-stop.js'
import type { TeamExternalRecoveryService, ExternalRecoveryInput, ExternalRecoveryReport } from './external-recovery.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { TeamRepositoryError } from './repository.js'
import { DELIVERY_LIMITS, type AcceptanceInput, type DeliveryMutation, type PrepareSubmission, type TaskReviewPolicy } from './delivery-contract.js'
import type { TeamDeliveryService } from './delivery-service.js'
import type { TeamExternalAuthorizationService, ExternalAuthorizationRequest } from './external-authorization.js'
import type { TeamExternalUsageService, ExternalUsageRequest } from './external-usage.js'
import type { TeamStepInputService } from './step-input-service.js'

export type DeliveryRouteService = Pick<TeamDeliveryService, 'forAttempt' | 'sessionCards' | 'management' | 'getDelivery' | 'reviseSpec' | 'prepare' | 'uploadArtifact' | 'publish' | 'decide' | 'readArtifact' | 'revokeArtifact' | 'getReceipt' | 'lookupReceipt' | 'executionHistory' | 'listInbox' | 'markInboxSeen' | 'capabilities' | 'exportJobs' | 'reportExportStatus'>
interface Dependencies {
  externalStop?: Pick<TeamExternalStopService,'record'>
  externalRecovery?: Pick<TeamExternalRecoveryService,'get'|'enqueue'|'pending'|'report'>
  externalUsage?: Pick<TeamExternalUsageService, 'record'>
  externalAuthorization?: Pick<TeamExternalAuthorizationService, 'authorize'>
  service: DeliveryRouteService
  stepInputs?: Pick<TeamStepInputService, 'getManifest' | 'readArtifact'>
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady(): boolean
}
function fields(value: unknown, allowed: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TeamRepositoryError('invalid_request', 'unexpected fields or non-object body')
  }
  return value as Record<string, any>
}
function parameters(request: FastifyRequest): Record<string, string> {
  const params = request.params as Record<string, string>
  if (Object.values(params).some(v => !v || v.length > 128)) throw new TeamRepositoryError('invalid_request', 'invalid resource ID')
  for (const id of [params.submissionId,params.itemId,params.attemptId]) if (id && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new TeamRepositoryError('invalid_request', 'invalid resource ID')
  return params
}
function errorResponse(error: unknown, reply: FastifyReply) {
  if (!(error instanceof TeamRepositoryError)) throw error
  const status = error.code === 'invalid_request' || error.code === 'artifact_integrity' ? 400
    : ['team_access_denied', 'reviewer_required', 'creator_required', 'offer_owner_required'].includes(error.code) ? 403
      : error.code === 'team_not_found' ? 404 : ['team_feature_disabled','artifact_unavailable','source_busy', 'external_call_not_ready'].includes(error.code) ? 503 : 409
  return reply.code(status).send({ error: { code: error.code, message: error.message,
    retryable: ['artifact_unavailable', 'revision_conflict', 'team_feature_disabled', 'source_busy', 'external_call_not_ready'].includes(error.code),
    ...(error.currentRevision === undefined ? {} : { current_revision: error.currentRevision }) } })
}
export function registerTeamDeliveryRoutes(app: FastifyInstance, deps: Dependencies): void {
  const route = (handler: (request: FastifyRequest, reply: FastifyReply, actor: number, params: Record<string, string>) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store')
      const header = request.headers.authorization
      const identity = header?.startsWith('Bearer ') ? await deps.verifyAccessToken(header.slice(7).trim()) : null
      if (!identity) return reply.code(401).send({ error: { code: 'authorization_required', message: 'Authorization required', retryable: false } })
      if (!deps.getDatabaseReady()) return reply.code(503).send({ error: { code: 'database_unavailable', message: 'Database unavailable', retryable: true } })
      try { return await handler(request, reply, identity.userId, parameters(request)) }
      catch (error) { return errorResponse(error, reply) }
    }
  if(deps.externalStop){
    app.post('/api/team/daemons/:daemonId/calls/:callId/external-stop',{bodyLimit:32768},route(async(r,_reply,actor,p)=>deps.externalStop!.record(actor,p.daemonId,p.callId,fields(r.body,['authorization','request_id','native_session_id','state']) as ExternalStopReport)))
  }
  if (deps.externalRecovery) {
    const path='/api/team/sessions/:sessionId/calls/:callId/external-recovery'
    app.get(path,route(async(r,_reply,actor,p)=>{fields(r.query,[]);return deps.externalRecovery!.get(actor,p.sessionId,p.callId)}))
    app.post(path,{bodyLimit:4096},route(async(r,_reply,actor,p)=>deps.externalRecovery!.enqueue(actor,p.sessionId,p.callId,fields(r.body,['request_id','action','expected_query_id']) as ExternalRecoveryInput)))
    app.get('/api/team/daemons/:daemonId/external-recovery',route(async(r,_reply,actor,p)=>{fields(r.query,[]);return deps.externalRecovery!.pending(actor,p.daemonId)}))
    app.post('/api/team/daemons/:daemonId/calls/:callId/external-recovery',{bodyLimit:32768},route(async(r,_reply,actor,p)=>deps.externalRecovery!.report(actor,p.daemonId,p.callId,fields(r.body,['authorization','request_id','native_session_id','phase','operation_id','result']) as ExternalRecoveryReport)))
  }
  if (deps.externalAuthorization) {
    app.post('/api/team/daemons/:daemonId/calls/:callId/external-authorization', { bodyLimit: 16384 }, route(async (r, _reply, actor, p) => {
      const body = fields(r.body, ['authorization', 'request_id', 'native_session_id', 'phase'])
      return deps.externalAuthorization!.authorize(actor, p.daemonId, p.callId, body as ExternalAuthorizationRequest)
    }))
  }
  if (deps.externalUsage) {
    app.post('/api/team/daemons/:daemonId/calls/:callId/external-usage', { bodyLimit: 512 * 1024 }, route(async (r, _reply, actor, p) => {
      const body = fields(r.body, ['authorization', 'request_id', 'native_session_id', 'phase', 'remote_task_id', 'usage'])
      return deps.externalUsage!.record(actor, p.daemonId, p.callId, body as ExternalUsageRequest)
    }))
  }
  if (deps.stepInputs) {
    const base='/api/team/daemons/:daemonId/calls/:callId/step-inputs'
    app.get(base,route(async(r,_reply,actor,p)=>{
      fields(r.query,[])
      return deps.stepInputs!.getManifest(p.callId,p.daemonId,actor)
    }))
    app.get(`${base}/:attemptId/:submissionId/artifacts/:artifactId`,route(async(r,reply,actor,p)=>{
      fields(r.query,[])
      const file=await deps.stepInputs!.readArtifact(p.callId,p.daemonId,actor,p.attemptId,p.submissionId,p.artifactId)
      reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox")
        .header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.manifest.name).replace(/'/g,'%27')}`)
        .header('X-Content-SHA256',file.manifest.sha256).type('application/octet-stream')
      return reply.send(file.bytes)
    }))
  }
  app.get('/api/team/daemons/:daemonId/delivery-jobs', route(async (r, _reply, actor, p) => {
    const query = fields(r.query, ['after', 'include_steps'])
    if (query.include_steps !== undefined && !['true', 'false'].includes(query.include_steps)) throw new TeamRepositoryError('invalid_request', 'invalid step job selection')
    if (query.after !== undefined && typeof query.after !== 'string') throw new TeamRepositoryError('invalid_request', 'invalid cursor')
    return deps.service.exportJobs(p.daemonId, actor, query.after ?? '', query.include_steps === 'true')
  }))
  app.get('/api/team/sessions/:sessionId/delivery-cards', route(async (r, _reply, actor, p) => {
    const q=fields(r.query,['after']);if(q.after!==undefined&&typeof q.after!=='string')throw new TeamRepositoryError('invalid_request','invalid cursor')
    return deps.service.sessionCards(p.sessionId,actor,q.after??'')
  }))
  app.get('/api/team/teams/:teamId/delivery-capabilities', route(async (_r, _reply, actor, p) => deps.service.capabilities(p.teamId, actor)))
  app.get('/api/team/delivery-inbox', route(async (r, _reply, actor) => {
    const query = fields(r.query, ['include_steps'])
    if (query.include_steps !== undefined && !['true', 'false'].includes(query.include_steps)) throw new TeamRepositoryError('invalid_request', 'invalid step Inbox selection')
    return deps.service.listInbox(actor, query.include_steps === 'true')
  }))
  app.post('/api/team/delivery-inbox/:itemId/seen', route(async (r, _reply, actor, p) => {
    fields(r.body, []); return deps.service.markInboxSeen(actor, p.itemId)
  }))
  const registerScope = (base: string, stepScope = false) => {
    const service = (p: Record<string, string>): DeliveryRouteService => {
      if (!stepScope) return deps.service
      if (!deps.service.forAttempt) throw new TeamRepositoryError('capability_not_supported', 'step delivery unavailable')
      return deps.service.forAttempt(p.attemptId)
    }
    app.post(`${base}/exports/:callId/daemons/:daemonId/status`,route(async(r,_reply,actor,p)=>service(p).reportExportStatus(p.taskId,actor,p.daemonId,p.callId,
      fields(r.body,['expected_revision','phase','error_code']) as {expected_revision:number;phase:string;error_code:string})))
    app.get(`${base}/executions`, route(async (_r, _reply, actor, p) => service(p).executionHistory(p.taskId, actor)))
    const mutationKeys = ['request_id', 'expected_revision']
    app.get(base, route(async (_r, _reply, actor, p) => service(p).getDelivery(p.taskId, actor)))
    if (!stepScope) app.get(`${base}/management`, route(async (_r, _reply, actor, p) => service(p).management(p.taskId, actor)))
    app.get(`${base}/receipts/:requestId`, route(async (_r, _reply, actor, p) => service(p).getReceipt(p.taskId, actor, p.requestId)))
    app.get(`${base}/receipt-lookup/:requestId`, route(async (_r, _reply, actor, p) => service(p).lookupReceipt(p.taskId, actor, p.requestId)))
    if (!stepScope) app.post(`${base}/specs`, route(async (r, _reply, actor, p) => {
      const body = fields(r.body, [...mutationKeys, 'goal', 'acceptance', 'policy'])
      return service(p).reviseSpec(p.taskId, actor, body as DeliveryMutation & { goal: string; acceptance: string; policy: TaskReviewPolicy })
    }))
    app.post(`${base}/submissions`, route(async (r, reply, actor, p) => {
      const body = fields(r.body, [...mutationKeys, 'spec_revision', 'source_call_id', 'summary', 'code_revision', 'artifacts', 'evidence', 'contribution_ids', 'publish_scope'])
      if (Array.isArray(body.artifacts)) body.artifacts.forEach(a => fields(a, ['id', 'name', 'mime_type', 'byte_size', 'sha256', 'required']))
      if (Array.isArray(body.evidence)) body.evidence.forEach(e => fields(e, ['check_id', 'result', 'artifact_id', 'code_revision', 'source_kind']))
      const result = await service(p).prepare(p.taskId, actor, body as PrepareSubmission)
      reply.code(201); return result
    }))
    // Base64 encodes complete three-byte groups and pads the last group to four
    // characters. Rounding after multiplication rejects valid near-limit files.
    const maxEncodedArtifactBytes = 4 * Math.ceil(DELIVERY_LIMITS.artifactBytes / 3)
    app.put(`${base}/submissions/:submissionId/artifacts/:artifactId`, { bodyLimit: maxEncodedArtifactBytes + 4096 }, route(async (r, _reply, actor, p) => {
      const body = fields(r.body, ['content_base64'])
      if (typeof body.content_base64 !== 'string' || !body.content_base64.length || body.content_base64.length > maxEncodedArtifactBytes) throw new TeamRepositoryError('invalid_request', 'canonical base64 content required')
      const bytes = Buffer.from(body.content_base64, 'base64')
      if (bytes.toString('base64') !== body.content_base64) throw new TeamRepositoryError('invalid_request', 'canonical base64 content required')
      return service(p).uploadArtifact(p.taskId, actor, p.submissionId, p.artifactId, bytes)
    }))
    app.post(`${base}/submissions/:submissionId/publish`, route(async (r, _reply, actor, p) =>
      service(p).publish(p.taskId, actor, p.submissionId, fields(r.body, mutationKeys) as DeliveryMutation)))
    app.post(`${base}/decisions`, route(async (r, _reply, actor, p) =>
      service(p).decide(p.taskId, actor, fields(r.body, [...mutationKeys, 'submission_id', 'spec_revision', 'decision', 'reason', 'verified_checks']) as AcceptanceInput)))
    app.get(`${base}/submissions/:submissionId/artifacts/:artifactId`, route(async (_r, reply, actor, p) => {
      const file = await service(p).readArtifact(p.taskId, actor, p.submissionId, p.artifactId)
      reply.header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.manifest.name).replace(/'/g, '%27')}`)
        .header('X-Content-SHA256', file.manifest.sha256).type('application/octet-stream')
      return reply.send(file.bytes)
    }))
    app.post(`${base}/submissions/:submissionId/artifacts/:artifactId/revoke`, route(async (r, _reply, actor, p) =>
      service(p).revokeArtifact(p.taskId, actor, p.submissionId, p.artifactId, fields(r.body, [...mutationKeys, 'reason']) as DeliveryMutation & { reason: string })))
  }
  registerScope('/api/team/tasks/:taskId/delivery')
  registerScope('/api/team/tasks/:taskId/attempts/:attemptId/delivery', true)
}
