import { validateReviewPolicy } from './delivery-contract.js'
import { isTeamProvider } from './types.js'
import type { FastifyInstance } from 'fastify'

import type { TeamCollaborationConfig } from './config.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamSessionService } from './session-service.js'
import type { TeamContextService } from './context-service.js'
import type { TeamContextReference, TeamMessageTargetMode, TeamProvider, TeamSessionState } from './types.js'

interface Dependencies {
  config: TeamCollaborationConfig
  service: TeamSessionService
  readStateService?: import('./read-state-service.js').TeamReadStateService
  agentConfigService?: import('./agent-config-service.js').TeamAgentConfigService
  contextService?: TeamContextService
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  getDatabaseReady?: () => boolean
}

type Reply = { code(status: number): unknown }
function fail(reply: Reply, status: number, code: string, message: string, retryable = false, currentRevision?: number) {
  reply.code(status)
  return { error: { code, message, retryable, ...(currentRevision === undefined ? {} : { current_revision: currentRevision }) } }
}
function mapError(error: unknown, reply: Reply) {
  if (!(error instanceof TeamRepositoryError)) throw error
  const status = error.code === 'invalid_request' ? 400 : error.code === 'team_feature_disabled' ? 503 : error.code === 'reviewer_required' ? 403 : error.code === 'team_access_denied' ? 403
    : error.code === 'team_not_found' ? 404
    : ['creator_required', 'participant_required', 'offer_owner_required'].includes(error.code) ? 403
      : error.code === 'agent_unavailable' ? 423 : 409
  return fail(reply, status, error.code, error.message,
    ['revision_conflict', 'context_revision_conflict', 'agent_unavailable', 'no_callable_agent'].includes(error.code), error.currentRevision)
}
async function actor(authorization: string | undefined, reply: Reply, deps: Dependencies) {
  if (!authorization?.startsWith('Bearer ')) return { error: fail(reply, 401, 'authorization_required', 'Authorization required') }
  const payload = await deps.verifyAccessToken(authorization.slice(7).trim())
  return payload ?? { error: fail(reply, 401, 'invalid_token', 'Invalid token') }
}
function writable(reply: Reply, deps: Dependencies) {
  if ((deps.getDatabaseReady && !deps.getDatabaseReady()) || deps.config.collaboration !== 'on') return fail(reply, 503, 'team_feature_disabled', 'Team collaboration writes are disabled', true)
  return null
}
function body(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function mutation(value: unknown, reply: Reply, revision = true) {
  const parsed = body(value)
  if (!parsed) return { error: fail(reply, 400, 'invalid_request', 'JSON object body required') }
  if (['actor_user_id', 'author_user_id', 'owner_user_id', 'creator_user_id','user_id'].some(key => key in parsed)) return { error: fail(reply, 400, 'invalid_request', 'client-supplied identity fields are not allowed') }
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id.trim() : ''
  if (!requestId || requestId.length > 128) return { error: fail(reply, 400, 'invalid_request', 'valid request_id is required') }
  if (revision && (!Number.isSafeInteger(parsed.expected_revision) || Number(parsed.expected_revision) < 1)) return { error: fail(reply, 400, 'invalid_request', 'expected_revision must be a positive integer') }
  return { parsed, requestId, expectedRevision: revision ? Number(parsed.expected_revision) : 0 }
}
function param(params: unknown, key: string) {
  const value = (params as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

function validConfig(value: unknown): boolean {
  const c = body(value)
  if (!c || Object.keys(c).some(k=>!['mode','override','capability_revision','request_id','expected_config_revision'].includes(k)) || !['default','custom'].includes(String(c.mode))) return false
  if (c.capability_revision !== undefined && typeof c.capability_revision !== 'string') return false
  const override = c.override === undefined ? {} : body(c.override)
  return override !== null && Object.entries(override).every(([k,v]) => ['model','permission_profile'].includes(k) ? typeof v === 'string' && v.length > 0 : k === 'reasoning_effort' && (v === null || typeof v === 'string'))
}

export function registerTeamSessionRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.post('/api/team/sessions/:sessionId/tasks/:taskId/execute', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
    const b = parsed.parsed
    if (Object.keys(b).some(k => !['request_id','expected_revision','expected_task_revision','spec_revision','context_version','target_offer_ids'].includes(k))) return fail(reply,400,'invalid_request','unexpected field')
    try { return await deps.service.executeTask({ sessionId: param(request.params,'sessionId'), taskId: param(request.params,'taskId'), actorUserId: identity.userId,
      request_id: parsed.requestId, expected_revision: parsed.expectedRevision, ...(b.expected_task_revision === undefined ? {} : {expected_task_revision: b.expected_task_revision as number}), spec_revision: b.spec_revision as number,
      context_version: b.context_version as number, target_offer_ids: b.target_offer_ids as string[] }) } catch (error) { return mapError(error,reply) }
  })
  app.get('/api/team/teams/:teamId/sessions', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const query = request.query as { daemon_id?: string; provider?: string } | null
    const provider = isTeamProvider(query?.provider) ? query.provider : undefined
    try { return { sessions: await deps.service.listSessions(param(request.params, 'teamId'), identity.userId, { daemonId: query?.daemon_id, provider }) } }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/teams/:teamId/sessions', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
    const title = typeof parsed.parsed.title === 'string' ? parsed.parsed.title.trim() : ''
    const taskId = parsed.parsed.task_id === undefined || parsed.parsed.task_id === null ? null : typeof parsed.parsed.task_id === 'string' ? parsed.parsed.task_id : undefined
    const agentConfigs = parsed.parsed.agent_configs
    const offerIds = parsed.parsed.offer_ids ?? []
    const participantUserIds = parsed.parsed.participant_user_ids ?? []
    if (!title || title.length > 240 || taskId === undefined
      || !Array.isArray(offerIds) || offerIds.length > 16 || !offerIds.every(id => typeof id === 'string' && id.length > 0)
      || !Array.isArray(participantUserIds) || participantUserIds.length > 100 || !participantUserIds.every(id => Number.isSafeInteger(id) && id > 0)) {
      return fail(reply, 400, 'invalid_request', 'title, task_id, offer_ids, or participant_user_ids is invalid')
    }
    if(agentConfigs!==undefined&&body(agentConfigs)&&Object.keys(agentConfigs as object).length&&deps.config.agentConfig!=='on')return fail(reply,503,'team_feature_disabled','Agent configuration is disabled',true)
    if (agentConfigs !== undefined && (!body(agentConfigs) || Object.values(agentConfigs as object).some(c => !validConfig(c)))) return fail(reply,400,'invalid_request','invalid Agent configuration')
    try {
      const session = await deps.service.createSession({ teamId: param(request.params, 'teamId'), actorUserId: identity.userId, title, taskId, offerIds: [...new Set(offerIds)], participantUserIds: [...new Set(participantUserIds)], ...(agentConfigs === undefined ? {} : {agentConfigs:agentConfigs as Parameters<TeamSessionService['createSession']>[0]['agentConfigs']}), requestId: parsed.requestId })
      reply.code(201); return { session }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/sessions/:sessionId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    try { return { session: await deps.service.getSession(param(request.params, 'sessionId'), identity.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.patch('/api/team/sessions/:sessionId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
    const title = parsed.parsed.title === undefined ? undefined : typeof parsed.parsed.title === 'string' ? parsed.parsed.title.trim() : null
    const state = parsed.parsed.state as TeamSessionState | undefined
    if ((title !== undefined && (!title || title.length > 240)) || (state !== undefined && !['active', 'paused', 'ended', 'archived'].includes(state)) || (title === undefined && state === undefined)) return fail(reply, 400, 'invalid_request', 'session update is invalid')
    try { return { session: await deps.service.updateSession({ sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, ...(title === undefined ? {} : { title }), ...(state === undefined ? {} : { state }), expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) } }
    catch (error) { return mapError(error, reply) }
  })

  for (const active of [true, false]) {
    const method = active ? 'put' : 'delete'
    app[method]('/api/team/sessions/:sessionId/participants/:userId', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const disabled = writable(reply, deps); if (disabled) return disabled
      const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
      const userId = Number(param(request.params, 'userId')); if (!Number.isSafeInteger(userId) || userId < 1) return fail(reply, 400, 'invalid_request', 'valid userId is required')
      const input = { sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }
      try { return { session: active ? await deps.service.addParticipant(input) : await deps.service.removeParticipant(input) } }
      catch (error) { return mapError(error, reply) }
    })
    app[method]('/api/team/sessions/:sessionId/agent-bindings/:offerId', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const disabled = writable(reply, deps); if (disabled) return disabled
      const parsed = mutation(request.body, reply); if ('error' in parsed) return parsed.error
      try { return { session: await deps.service.changeBinding({ sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, offerId: param(request.params, 'offerId'), active, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) } }
      catch (error) { return mapError(error, reply) }
    })
  }

  app.post('/api/team/sessions/:sessionId/tasks',async(request,reply)=>{
    const identity=await actor(request.headers.authorization,reply,deps);if('error' in identity)return identity.error
    const disabled=writable(reply,deps);if(disabled)return disabled
    const parsed=mutation(request.body,reply,false);if('error' in parsed)return parsed.error
    const b=parsed.parsed
    if(typeof b.instruction!=='string'||!b.instruction.trim()||typeof b.acceptance!=='string'||!b.acceptance.trim()
      ||!Array.isArray(b.target_offer_ids)||!b.target_offer_ids.length||b.target_offer_ids.length>16||!b.target_offer_ids.every(id=>typeof id==='string')
      ||!Number.isSafeInteger(b.context_version)||Number(b.context_version)<0||(b.reference_event_id!=null&&typeof b.reference_event_id!=='string'))return fail(reply,400,'invalid_request','instruction, acceptance, targets and materials version required')
    if (b.review_policy !== undefined) { try { validateReviewPolicy(b.review_policy) } catch(e) { return mapError(e,reply) } }
    try{const result=await deps.service.assignTask({sessionId:param(request.params,'sessionId'),actorUserId:identity.userId,requestId:parsed.requestId,instruction:b.instruction.trim(),acceptance:b.acceptance.trim(),targetOfferIds:b.target_offer_ids,contextVersion:Number(b.context_version),referenceEventId:b.reference_event_id as string|null|undefined,...(b.review_policy === undefined ? {} : {reviewPolicy:b.review_policy as import('./delivery-contract.js').TaskReviewPolicy})});reply.code(201);return result}catch(e){return mapError(e,reply)}
  })

  app.get('/api/team/sessions/:sessionId/tasks/by-request/:requestId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    // Read recovery remains available when new collaboration writes are disabled.
    try { return await deps.service.taskByRequest(param(request.params, 'sessionId'), identity.userId, param(request.params, 'requestId')) }
    catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/sessions/:sessionId/messages/by-request/:requestId',async(request,reply)=>{
    const identity=await actor(request.headers.authorization,reply,deps);if('error' in identity)return identity.error
    try{return await deps.service.messageByRequest(param(request.params,'sessionId'),identity.userId,param(request.params,'requestId'))}catch(e){return mapError(e,reply)}
  })
  if(deps.readStateService) app.put('/api/team/sessions/:sessionId/read-position',async(request,reply)=>{
    const identity=await actor(request.headers.authorization,reply,deps);if('error' in identity)return identity.error
    const b=body(request.body)
    if(!b||!Number.isSafeInteger(b.event_seq)||Number(b.event_seq)<0)return fail(reply,400,'invalid_request','valid event_seq required')
    try{return await deps.readStateService!.advance(param(request.params,'sessionId'),identity.userId,Number(b.event_seq))}catch(e){return mapError(e,reply)}
  })

  app.get('/api/team/sessions/:sessionId/calls', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    try { return { calls: await deps.service.listCalls(param(request.params, 'sessionId'), identity.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/sessions/:sessionId/events', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const query = request.query as { after_seq?: string; limit?: string } | null
    const afterSeq = Math.max(0, Number.parseInt(query?.after_seq ?? '0', 10) || 0)
    const limit = Math.min(100, Math.max(1, Number.parseInt(query?.limit ?? '50', 10) || 50))
    try { return await deps.service.listEvents(param(request.params, 'sessionId'), identity.userId, afterSeq, limit) }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/sessions/:sessionId/events', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
    const disabled = writable(reply, deps); if (disabled) return disabled
    const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
    const content = typeof parsed.parsed.content === 'string' ? parsed.parsed.content.trim() : ''
    const targetMode = parsed.parsed.target_mode as TeamMessageTargetMode
    const rawTargets=parsed.parsed.target_offer_ids
    if(rawTargets!==undefined && (!Array.isArray(rawTargets)||!rawTargets.every((id:unknown)=>typeof id==='string')))return fail(reply,400,'invalid_request','target_offer_ids must contain strings')
    const targetOfferIds = (rawTargets??[]) as string[]
    const referenceEventId = parsed.parsed.reference_event_id === undefined || parsed.parsed.reference_event_id === null ? null : typeof parsed.parsed.reference_event_id === 'string' ? parsed.parsed.reference_event_id : undefined
    if (!content || content.length > 64_000 || !['offers', 'all', 'discussion'].includes(targetMode) || referenceEventId === undefined) return fail(reply, 400, 'invalid_request', 'message content or targets are invalid')
    try {
      const result = await deps.service.appendMessage({ sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId, requestId: parsed.requestId, content, targetMode, targetOfferIds, referenceEventId })
      reply.code(201); return result
    } catch (error) { return mapError(error, reply) }
  })

  if (deps.agentConfigService) {
    app.put('/api/team/teams/:teamId/agents/:offerId/config-policy',async(request,reply)=>{
      const identity=await actor(request.headers.authorization,reply,deps);if('error' in identity)return identity.error
      const disabled=writable(reply,deps);if(disabled)return disabled
      if(deps.config.agentConfig!=='on')return fail(reply,503,'team_feature_disabled','Agent configuration disabled',true)
      const parsed=mutation(request.body,reply,false);if('error' in parsed)return parsed.error
      const b=parsed.parsed
      if(Object.keys(b).some(k=>!['request_id','expected_policy_revision','overridable_fields'].includes(k))||!Number.isSafeInteger(b.expected_policy_revision)||Number(b.expected_policy_revision)<1||!Array.isArray(b.overridable_fields)||!b.overridable_fields.every(f=>typeof f==='string'&&['model','reasoning_effort'].includes(f)))return fail(reply,400,'invalid_request','invalid sharing policy')
      try{return await deps.agentConfigService!.updatePolicy({teamId:param(request.params,'teamId'),offerId:param(request.params,'offerId'),actorUserId:identity.userId,requestId:parsed.requestId,expectedRevision:Number(b.expected_policy_revision),fields:b.overridable_fields as string[]})}catch(error){return mapError(error,reply)}
    })
    app.get('/api/team/teams/:teamId/agents/:offerId/capabilities',async (request,reply) => {
      if(deps.config.agentConfig!=='on')return fail(reply,503,'team_feature_disabled','Agent configuration disabled',true)
      const identity = await actor(request.headers.authorization,reply,deps); if ('error' in identity) return identity.error
      try {return {capabilities:await deps.agentConfigService!.offerCapabilities(param(request.params,'teamId'),param(request.params,'offerId'),identity.userId)}} catch(e) {return mapError(e,reply)}
    })
    app.get('/api/team/sessions/:sessionId/agent-bindings/:offerId/capabilities',async (request,reply) => {
      if(deps.config.agentConfig!=='on')return fail(reply,503,'team_feature_disabled','Agent configuration disabled',true)
      const identity = await actor(request.headers.authorization,reply,deps); if ('error' in identity) return identity.error
      try {return {capabilities:await deps.agentConfigService!.capabilities(param(request.params,'sessionId'),param(request.params,'offerId'),identity.userId)}} catch(e) {return mapError(e,reply)}
    })
    app.put('/api/team/sessions/:sessionId/agent-bindings/:offerId/config',async (request,reply) => {
      if(deps.config.agentConfig!=='on')return fail(reply,503,'team_feature_disabled','Agent configuration disabled',true)
      const identity = await actor(request.headers.authorization,reply,deps); if ('error' in identity) return identity.error
      const disabled = writable(reply,deps); if (disabled) return disabled
      const parsed = mutation(request.body,reply,false); if ('error' in parsed) return parsed.error
      const b = parsed.parsed
      if (!validConfig(b) || !Number.isSafeInteger(b.expected_config_revision) || Number(b.expected_config_revision)<1 || typeof b.capability_revision !== 'string') return fail(reply,400,'invalid_request','invalid configuration revision or body')
      try {return {config:await deps.agentConfigService!.update({sessionId:param(request.params,'sessionId'),offerId:param(request.params,'offerId'),actorUserId:identity.userId,requestId:parsed.requestId,
        expectedRevision:Number(b.expected_config_revision),mode:b.mode as 'default'|'custom',override:(b.override ?? {}) as import('./types.js').TeamRuntimeConfig,capabilityRevision:b.capability_revision})}} catch(e) {return mapError(e,reply)}
    })
  }

  if (deps.contextService) {
    app.get('/api/team/sessions/:sessionId/context', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const rawVersion = (request.query as { version?: string } | null)?.version
      const version = rawVersion === undefined ? undefined : Number.parseInt(rawVersion, 10)
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) return fail(reply, 400, 'invalid_request', 'version must be a positive integer')
      try { return { context: await deps.contextService!.get(param(request.params, 'sessionId'), identity.userId, version) } }
      catch (error) { return mapError(error, reply) }
    })

    app.post('/api/team/sessions/:sessionId/context', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, deps); if ('error' in identity) return identity.error
      const disabled = writable(reply, deps); if (disabled) return disabled
      const parsed = mutation(request.body, reply, false); if ('error' in parsed) return parsed.error
      const expectedRevision = Number(parsed.parsed.expected_revision)
      const goal = typeof parsed.parsed.goal === 'string' ? parsed.parsed.goal.trim() : ''
      const consensus = Array.isArray(parsed.parsed.consensus) && parsed.parsed.consensus.every(item => typeof item === 'string')
        ? (parsed.parsed.consensus as string[]).map(item => item.trim()).filter(Boolean) : null
      const openQuestions = Array.isArray(parsed.parsed.open_questions) && parsed.parsed.open_questions.every(item => typeof item === 'string')
        ? (parsed.parsed.open_questions as string[]).map(item => item.trim()).filter(Boolean) : null
      const rawReferences = Array.isArray(parsed.parsed.references) ? parsed.parsed.references : null
      const references: TeamContextReference[] | null = rawReferences?.every(reference => {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return false
        const value = reference as Record<string, unknown>
        if (typeof value.source_id !== 'string' || typeof value.source_version !== 'string') return false
        if (value.source_kind === 'team_event') return value.owner_scope_id === null && value.installation_id === null
        return ['memory_claim', 'memory_evidence', 'wiki_section'].includes(String(value.source_kind))
          && typeof value.owner_scope_id === 'string' && typeof value.installation_id === 'string'
      }) ? rawReferences as TeamContextReference[] : null
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !goal || goal.length > 16_000
        || !consensus || consensus.length > 50 || consensus.some(item => item.length > 4_000)
        || !openQuestions || openQuestions.length > 50 || openQuestions.some(item => item.length > 4_000)
        || !references || references.length > 100) {
        return fail(reply, 400, 'invalid_request', 'context payload is invalid')
      }
      try {
        const result = await deps.contextService!.create({
          sessionId: param(request.params, 'sessionId'), actorUserId: identity.userId,
          expectedRevision, requestId: parsed.requestId, goal, consensus, openQuestions, references,
        })
        reply.code(201); return result
      } catch (error) { return mapError(error, reply) }
    })
  }
}
