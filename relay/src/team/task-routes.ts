import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import {parseTaskRequirements,type TaskRequirements} from './task-readiness.js'
import type { TeamCollaborationConfig } from './config.js'
import { TeamRepositoryError } from './repository.js'
import { TeamTaskService, type TeamTaskView, type TaskPoolFilter, type TaskRequirementHistory, type TaskRequirementReceipt, type TaskHolderReceipt } from './task-service.js'

export interface TeamTaskRouteService {
  selfHolderReceipt?(taskId: string, actorUserId: number, requestId: string): Promise<TaskHolderReceipt>
  requirementHistory?(taskId:string,actorUserId:number,beforeRevision?:number):Promise<TaskRequirementHistory>
  requirementReceipt?(taskId:string,actorUserId:number,kind:'save'|'override',requestId:string):Promise<TaskRequirementReceipt>
  updateRequirements?(input:{taskId:string;actorUserId:number;expectedRevision:number;requestId:string;requirements:TaskRequirements}):Promise<TeamTaskView>
  overrideRequirements?(input:{taskId:string;actorUserId:number;expectedRevision:number;requestId:string;reason:string}):Promise<TeamTaskView>
  listTasks(teamId: string, actorUserId: number, includeDeleted?: boolean, filter?:TaskPoolFilter): Promise<TeamTaskView[]>
  getTask(taskId: string, actorUserId: number): Promise<TeamTaskView>
  createTask(input: { teamId: string; actorUserId: number; title: string; background: string; requestId: string }): Promise<TeamTaskView>
  updateTask(input: { taskId: string; actorUserId: number; title?: string; background?: string; state?: 'open' | 'in_progress' | 'completed' | 'archived'; expectedRevision: number; requestId: string }): Promise<TeamTaskView>
  deleteTask(input: { taskId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<TeamTaskView>
  restoreTask(input: { taskId: string; actorUserId: number; expectedRevision: number; requestId: string }): Promise<TeamTaskView>
  setHolder(input: { taskId: string; actorUserId: number; holderUserId: number; active: boolean; expectedRevision: number; requestId: string }): Promise<TeamTaskView>
  linkSession(input: { taskId: string; sessionId: string; actorUserId: number; linked: boolean; expectedRevision: number; requestId: string }): Promise<TeamTaskView>
}

interface Dependencies {
  config: TeamCollaborationConfig
  service: TeamTaskRouteService
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
  const status = error.code === 'team_access_denied' ? 403
    : error.code === 'team_not_found' ? 404
    : error.code === 'creator_required' || error.code === 'membership_required' ? 403
      : error.code === 'capability_not_supported' ? 422
        : 409
  const retryable = ['revision_conflict', 'daemon_team_conflict', 'agent_unavailable', 'no_callable_agent'].includes(error.code)
  return fail(reply, status, error.code, error.message, retryable, error.currentRevision)
}

async function actor(authorization: string | undefined, reply: Reply, dependencies: Dependencies) {
  if (!authorization?.startsWith('Bearer ')) return { error: fail(reply, 401, 'authorization_required', 'Authorization required') }
  const token = authorization.slice('Bearer '.length).trim()
  const payload = token ? await dependencies.verifyAccessToken(token) : null
  return payload ?? { error: fail(reply, 401, 'invalid_token', 'Invalid token') }
}

function writable(reply: Reply, dependencies: Dependencies) {
  if ((dependencies.getDatabaseReady && !dependencies.getDatabaseReady()) || dependencies.config.collaboration !== 'on') {
    return fail(reply, 503, 'team_feature_disabled', 'Team collaboration writes are disabled', true)
  }
  return null
}

function object(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

function mutation(body: unknown, reply: Reply, revision = true) {
  const parsed = object(body)
  if (!parsed) return { error: fail(reply, 400, 'invalid_request', 'JSON object body required') }
  if ('actor_user_id' in parsed || 'creator_user_id' in parsed || 'user_id' in parsed) {
    return { error: fail(reply, 400, 'invalid_request', 'client-supplied identity fields are not allowed') }
  }
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id.trim() : ''
  if (!requestId || requestId.length > 128) return { error: fail(reply, 400, 'invalid_request', 'valid request_id is required') }
  if (revision && (!Number.isSafeInteger(parsed.expected_revision) || Number(parsed.expected_revision) < 1)) {
    return { error: fail(reply, 400, 'invalid_request', 'expected_revision must be a positive integer') }
  }
  return { body: parsed, requestId, expectedRevision: revision ? Number(parsed.expected_revision) : 0 }
}

function parameter(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

export function registerTeamTaskRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  for(const override of [false,true]){
    // Three 10k-code-unit fields can exceed 90 KB as UTF-8 and 180 KB
    // as escaped JSON. Keep the semantic limits, with a bounded transport
    // envelope that can carry every valid document without truncation.
    app.route({method:override?'POST':'PUT',url:'/api/team/tasks/:taskId/requirements'+(override?'/override':''),bodyLimit:(override?64:256)*1024,handler:async(request,reply)=>{
      const identity=await actor(request.headers.authorization,reply,dependencies)
      if('error' in identity)return identity.error
      const disabled=writable(reply,dependencies);if(disabled)return disabled
      if(dependencies.config.taskReadiness!=='on')return fail(reply,503,'team_feature_disabled','Task requirements writes are disabled',true)
      const parsed=mutation(request.body,reply);if('error' in parsed)return parsed.error
      const base={taskId:parameter(request.params,'taskId'),actorUserId:identity.userId,expectedRevision:parsed.expectedRevision,requestId:parsed.requestId}
      if(override){
        if(Object.keys(parsed.body).some(k=>!['request_id','expected_revision','reason'].includes(k)))return fail(reply,400,'invalid_request','unknown override field')
        const reason=typeof parsed.body.reason==='string'?parsed.body.reason.trim():''
        if(!reason||reason.length>1000||reason.includes('\0'))return fail(reply,400,'invalid_request','override reason required')
        if(!dependencies.service.overrideRequirements)return fail(reply,503,'team_feature_disabled','Task requirements unavailable',true)
        try{return {task:await dependencies.service.overrideRequirements({...base,reason})}}catch(error){return mapError(error,reply)}
      }
      if(Object.keys(parsed.body).some(k=>!['request_id','expected_revision','requirements'].includes(k)))return fail(reply,400,'invalid_request','unknown requirements field')
      let requirements:TaskRequirements
      try{requirements=parseTaskRequirements(parsed.body.requirements)}catch{return fail(reply,400,'invalid_request','invalid task requirements')}
      if(!dependencies.service.updateRequirements)return fail(reply,503,'team_feature_disabled','Task requirements unavailable',true)
      try{return {task:await dependencies.service.updateRequirements({...base,requirements})}}catch(error){return mapError(error,reply)}
    }})
  }

  app.get('/api/team/tasks/:taskId/holders/self/receipt', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const identity = await actor(request.headers.authorization, reply, dependencies)
    if ('error' in identity) return identity.error
    if (dependencies.getDatabaseReady && !dependencies.getDatabaseReady()) return fail(reply, 503, 'team_feature_disabled', 'Team storage is initializing', true)
    const query = (request.query ?? {}) as Record<string, unknown>, id = query.request_id
    if (Object.keys(query).some(k => k !== 'request_id') || typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 128 || id.includes('\0')) return fail(reply, 400, 'invalid_request', 'invalid holder receipt query')
    if (!dependencies.service.selfHolderReceipt) return fail(reply, 503, 'team_feature_disabled', 'Task holder receipts unavailable', true)
    try { return await dependencies.service.selfHolderReceipt(parameter(request.params, 'taskId'), identity.userId, id) }
    catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/tasks/:taskId/requirements/receipt',async(request,reply)=>{
    const identity=await actor(request.headers.authorization,reply,dependencies)
    if('error' in identity)return identity.error
    if(dependencies.getDatabaseReady&&!dependencies.getDatabaseReady())return fail(reply,503,'team_feature_disabled','Team storage is initializing',true)
    const query=(request.query??{}) as Record<string,unknown>,kind=query.kind,id=query.request_id
    if(Object.keys(query).some(k=>!['kind','request_id'].includes(k))||!['save','override'].includes(String(kind))||typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>128||id.includes('\0'))return fail(reply,400,'invalid_request','invalid requirements receipt query')
    if(!dependencies.service.requirementReceipt)return fail(reply,503,'team_feature_disabled','Task requirements unavailable',true)
    try{return await dependencies.service.requirementReceipt(parameter(request.params,'taskId'),identity.userId,kind as 'save'|'override',id)}catch(error){return mapError(error,reply)}
  })

  app.get('/api/team/tasks/:taskId/requirements/history',async(request,reply)=>{
    const identity=await actor(request.headers.authorization,reply,dependencies)
    if('error' in identity)return identity.error
    if(dependencies.getDatabaseReady&&!dependencies.getDatabaseReady())return fail(reply,503,'team_feature_disabled','Team storage is initializing',true)
    const query=(request.query??{}) as Record<string,unknown>,cursor=query.before_revision
    if(Object.keys(query).some(k=>k!=='before_revision')||(cursor!==undefined&&(typeof cursor!=='string'||!/^[1-9][0-9]*$/.test(cursor)||!Number.isSafeInteger(Number(cursor)))))return fail(reply,400,'invalid_request','invalid history cursor')
    if(!dependencies.service.requirementHistory)return fail(reply,503,'team_feature_disabled','Task requirements unavailable',true)
    try{return await dependencies.service.requirementHistory(parameter(request.params,'taskId'),identity.userId,cursor===undefined?undefined:Number(cursor))}catch(error){return mapError(error,reply)}
  })

  app.get('/api/team/teams/:teamId/tasks', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, dependencies)
    if ('error' in identity) return identity.error
    if (dependencies.getDatabaseReady && !dependencies.getDatabaseReady()) return fail(reply, 503, 'team_feature_disabled', 'Team storage is initializing', true)
    const query=(request.query??{}) as Record<string,unknown>
    if(Object.keys(query).some(k=>!['include_deleted','pool'].includes(k))||query.include_deleted!==undefined&&!['true','false'].includes(String(query.include_deleted)))return fail(reply,400,'invalid_request','invalid task filter')
    const includeDeleted=query.include_deleted==='true',filter=query.pool??'all'
    if(!['all','unclaimed','mine'].includes(String(filter))||(includeDeleted&&filter!=='all'))return fail(reply,400,'invalid_request','invalid task pool filter')
    try { return { tasks: await dependencies.service.listTasks(parameter(request.params, 'teamId'), identity.userId, includeDeleted,filter as TaskPoolFilter) } }
    catch (error) { return mapError(error, reply) }
  })

  app.post('/api/team/teams/:teamId/tasks', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, dependencies)
    if ('error' in identity) return identity.error
    const disabled = writable(reply, dependencies)
    if (disabled) return disabled
    const parsed = mutation(request.body, reply, false)
    if ('error' in parsed) return parsed.error
    const title = typeof parsed.body.title === 'string' ? parsed.body.title.trim() : ''
    const background = typeof parsed.body.background === 'string' ? parsed.body.background : ''
    if (!title || title.length > 240 || background.length > 100_000) return fail(reply, 400, 'invalid_request', 'title or background is invalid')
    try {
      const task = await dependencies.service.createTask({ teamId: parameter(request.params, 'teamId'), actorUserId: identity.userId, title, background, requestId: parsed.requestId })
      reply.code(201)
      return { task }
    } catch (error) { return mapError(error, reply) }
  })

  app.get('/api/team/tasks/:taskId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, dependencies)
    if ('error' in identity) return identity.error
    try { return { task: await dependencies.service.getTask(parameter(request.params, 'taskId'), identity.userId) } }
    catch (error) { return mapError(error, reply) }
  })

  app.patch('/api/team/tasks/:taskId', async (request, reply) => {
    const identity = await actor(request.headers.authorization, reply, dependencies)
    if ('error' in identity) return identity.error
    const disabled = writable(reply, dependencies)
    if (disabled) return disabled
    const parsed = mutation(request.body, reply)
    if ('error' in parsed) return parsed.error
    const title = parsed.body.title === undefined ? undefined : typeof parsed.body.title === 'string' ? parsed.body.title.trim() : null
    const background = parsed.body.background === undefined ? undefined : typeof parsed.body.background === 'string' ? parsed.body.background : null
    const state = parsed.body.state
    if ((title !== undefined && (!title || title.length > 240))
      || (background !== undefined && (background === null || background.length > 100_000))
      || (state !== undefined && !['open', 'in_progress', 'completed', 'archived'].includes(String(state)))
      || (title === undefined && background === undefined && state === undefined)) {
      return fail(reply, 400, 'invalid_request', 'task update is invalid')
    }
    try {
      return { task: await dependencies.service.updateTask({
        taskId: parameter(request.params, 'taskId'), actorUserId: identity.userId,
        ...(title === undefined ? {} : { title }), ...(background === undefined ? {} : { background }),
        ...(state === undefined ? {} : { state: state as 'open' | 'in_progress' | 'completed' | 'archived' }),
        expectedRevision: parsed.expectedRevision, requestId: parsed.requestId,
      }) }
    } catch (error) { return mapError(error, reply) }
  })

  for (const operation of ['delete', 'restore'] as const) {
    const method = operation === 'delete' ? 'delete' : 'post'
    const path = operation === 'delete' ? '/api/team/tasks/:taskId' : '/api/team/tasks/:taskId/restore'
    app[method](path, async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, dependencies)
      if ('error' in identity) return identity.error
      const disabled = writable(reply, dependencies)
      if (disabled) return disabled
      const parsed = mutation(request.body, reply)
      if ('error' in parsed) return parsed.error
      try {
        const input = { taskId: parameter(request.params, 'taskId'), actorUserId: identity.userId, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }
        return { task: operation === 'delete' ? await dependencies.service.deleteTask(input) : await dependencies.service.restoreTask(input) }
      } catch (error) { return mapError(error, reply) }
    })
  }

  for (const active of [true, false]) {
    const method = active ? 'post' : 'delete'
    app[method]('/api/team/tasks/:taskId/holders/self', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, dependencies)
      if ('error' in identity) return identity.error
      const disabled = writable(reply, dependencies)
      if (disabled) return disabled
      const parsed = mutation(request.body, reply)
      if ('error' in parsed) return parsed.error
      try {
        return { task: await dependencies.service.setHolder({ taskId: parameter(request.params, 'taskId'), actorUserId: identity.userId, holderUserId: identity.userId, active, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) }
      } catch (error) { return mapError(error, reply) }
    })

    const memberMethod = active ? 'put' : 'delete'
    app[memberMethod]('/api/team/tasks/:taskId/holders/:userId', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, dependencies)
      if ('error' in identity) return identity.error
      const disabled = writable(reply, dependencies)
      if (disabled) return disabled
      const parsed = mutation(request.body, reply)
      if ('error' in parsed) return parsed.error
      const holderUserId = Number(parameter(request.params, 'userId'))
      if (!Number.isSafeInteger(holderUserId) || holderUserId < 1) return fail(reply, 400, 'invalid_request', 'valid userId is required')
      try {
        return { task: await dependencies.service.setHolder({ taskId: parameter(request.params, 'taskId'), actorUserId: identity.userId, holderUserId, active, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) }
      } catch (error) { return mapError(error, reply) }
    })
  }

  for (const linked of [true, false]) {
    const method = linked ? 'put' : 'delete'
    app[method]('/api/team/tasks/:taskId/sessions/:sessionId', async (request, reply) => {
      const identity = await actor(request.headers.authorization, reply, dependencies)
      if ('error' in identity) return identity.error
      const disabled = writable(reply, dependencies)
      if (disabled) return disabled
      const parsed = mutation(request.body, reply)
      if ('error' in parsed) return parsed.error
      try {
        return { task: await dependencies.service.linkSession({ taskId: parameter(request.params, 'taskId'), sessionId: parameter(request.params, 'sessionId'), actorUserId: identity.userId, linked, expectedRevision: parsed.expectedRevision, requestId: parsed.requestId }) }
      } catch (error) { return mapError(error, reply) }
    })
  }
}

export function createTeamTaskRouteService(pool: pg.Pool): TeamTaskRouteService {
  return new TeamTaskService(pool)
}
