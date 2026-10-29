import { useLocale } from '../composables/useLocale'
import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'
import { resetScopedMemoryAuthorization } from './memoryClient'
import type {
  TeamAgentCandidate,
  TeamAgentOffer,
  TeamApiErrorBody,
  TeamCapabilities,
  TeamCallSummary,
  TeamContextSnapshot,
  TeamEvent,
  TeamInvitation,
  TeamMember,
  TeamMessageTargetMode,
  TeamMemoryBinding,
  TeamProvider,
  TeamRun,
  TeamSession,
  TeamSessionState,
  TeamSessionSummary,
  TeamSummary,
  TeamTask,
  TeamTaskState,
  TeamTaskPoolFilter,
  TeamTaskRequirementsInput,
  TeamTaskRequirementOverrideInput,
  TeamTaskRequirementHistory,
} from '../types/team'

export class TeamApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean

  constructor(status: number, body: TeamApiErrorBody) {
    const error = body.error ?? {}
    super(error.message || 'Team request failed')
    this.name = 'TeamApiError'
    this.status = status
    this.code = error.code || 'request_failed'
    this.retryable = error.retryable === true
  }
}

export type TeamRequestIdentity = {userId:number;origin:string;isCurrent?:()=>boolean}
interface TeamRequestOptions {
  identity?: TeamRequestIdentity
  responseType?: 'blob'
  timeoutMs?: number
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: Record<string, unknown>
  headers?:Record<string,string>
}

function requestID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function teamRequest<T>(path: string, options: TeamRequestOptions = {}, allowRefresh = true): Promise<T> {
  const { accessToken, doRefreshToken, user, canReadOfflineTeams } = useAuth()
  if (canReadOfflineTeams?.value) throw new TeamApiError(0, { error: { code: 'offline', message: useLocale().t('team.offline_navigation'), retryable: true } })
  const requireIdentity=()=>{if(options.identity && (user?.value?.id!==options.identity.userId || getRelayOrigin()!==options.identity.origin || options.identity.isCurrent?.()===false))throw new TeamApiError(409,{error:{code:'request_identity_changed',message:'账号、Relay 或操作状态已变化，原请求已保留。'}})}
  requireIdentity()
  let response: Response
  let body: T | TeamApiErrorBody
  const controller = options.timeoutMs ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined
  try {
    response = await fetch(`${getRelayOrigin()}${path}`, {
      method: options.method ?? 'GET',
      ...(controller ? { signal: controller.signal } : {}),
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...options.headers,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken.value ? { Authorization: `Bearer ${accessToken.value}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (response.ok && options.responseType === 'blob') return await response.blob() as T
    body = await response.json().catch(error => {
      // A successful status with an incomplete body cannot confirm a mutation.
      if (response.ok) throw error
      return {}
    }) as T | TeamApiErrorBody
  } catch {
    throw new TeamApiError(0, {
      error: { code: 'network_error', message: 'Network request failed', retryable: true },
    })
  }
  finally { if (timer !== undefined) clearTimeout(timer) }
  if (response.status === 401 && allowRefresh) {
    requireIdentity()
    if(await doRefreshToken()){requireIdentity();return teamRequest<T>(path, options, false)}
    // An expired access token followed by an unavailable refresh endpoint is
    // not an authoritative denial of the cached Team data.
    if (canReadOfflineTeams?.value) throw new TeamApiError(0, { error: { code: 'offline', message: useLocale().t('team.offline_navigation'), retryable: true } })
  }
  requireIdentity()
  if (!response.ok) throw new TeamApiError(response.status, body as TeamApiErrorBody)
  return body as T
}

export async function getTeamCapabilities(): Promise<TeamCapabilities> {
 const snapshot=await teamRequest<TeamCapabilities>('/api/team/capabilities')
 if(snapshot.collaboration || snapshot.reads_enabled!==undefined)return snapshot
 // Older Relay versions do not distinguish entitled history readers from a
 // disabled write rollout. The authorized read endpoint is the authority.
 try{await teamRequest('/api/team/teams');return {...snapshot,reads_enabled:true}}catch{return {...snapshot,reads_enabled:false}}
}
export async function saveTeamConfigPolicy(team:string,offer:string,revision:number,fields:string[],key:string):Promise<{policy_revision:number;overridable_fields:Array<'model'|'reasoning_effort'>}>{
 return teamRequest(`/api/team/teams/${encodeURIComponent(team)}/agents/${encodeURIComponent(offer)}/config-policy`,{method:'PUT',body:{request_id:key,expected_policy_revision:revision,overridable_fields:fields}})
}

export async function listTeams(): Promise<TeamSummary[]> {
  return (await teamRequest<{ teams: TeamSummary[] }>('/api/team/teams')).teams
}

export async function getTeam(teamID: string): Promise<TeamSummary> {
  return (await teamRequest<{ team: TeamSummary }>(`/api/team/teams/${encodeURIComponent(teamID)}`)).team
}

export async function createTeam(name: string, description?: string): Promise<TeamSummary> {
  return (await teamRequest<{ team: TeamSummary }>('/api/team/teams', {
    method: 'POST', body: { request_id: requestID(), name, ...(description ? {description} : {}) },
  })).team
}

export async function listTeamMembers(teamID: string): Promise<TeamMember[]> {
  return (await teamRequest<{ members: TeamMember[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/members`)).members
}

export async function listMyInvitations(): Promise<TeamInvitation[]> {
  return (await teamRequest<{ invitations: TeamInvitation[] }>('/api/team/invitations')).invitations
}

export async function listTeamInvitations(teamID: string): Promise<TeamInvitation[]> {
  return (await teamRequest<{ invitations: TeamInvitation[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/invitations`)).invitations
}

export async function inviteTeamMember(teamID: string, email: string, expectedRevision: number, role: import('../types/team').TeamRole = 'member'): Promise<TeamInvitation> {
  return (await teamRequest<{ invitation: TeamInvitation }>(`/api/team/teams/${encodeURIComponent(teamID)}/invitations`, {
    method: 'POST', body: { request_id: requestID(), expected_revision: expectedRevision, email, role },
  })).invitation
}

export async function respondToTeamInvitation(invitation: TeamInvitation, action: 'accept' | 'decline'): Promise<void> {
  await teamRequest(`/api/team/invitations/${encodeURIComponent(invitation.id)}/${action}`, {
    method: 'POST', body: { request_id: requestID(), expected_revision: invitation.revision },
  })
}

export async function revokeTeamInvitation(invitation: TeamInvitation): Promise<TeamInvitation> {
  return (await teamRequest<{ invitation: TeamInvitation }>(`/api/team/invitations/${encodeURIComponent(invitation.id)}`, {
    method: 'DELETE', body: { request_id: requestID(), expected_revision: invitation.revision },
  })).invitation
}

export async function listMyTeamAgentCandidates(): Promise<TeamAgentCandidate[]> {
  return (await teamRequest<{ agents: TeamAgentCandidate[] }>('/api/team/agent-candidates')).agents
}

export async function listTeamAgentCandidates(teamID: string): Promise<TeamAgentCandidate[]> {
  return (await teamRequest<{ agents: TeamAgentCandidate[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/agent-candidates`)).agents
}

export async function listTeamAgentOffers(teamID: string): Promise<TeamAgentOffer[]> {
  return (await teamRequest<{ offers: TeamAgentOffer[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/agent-offers`)).offers
}

export async function addTeamAgentOffer(teamID: string, candidate: Pick<TeamAgentCandidate, 'daemon_id' | 'provider'>, expectedRevision: number): Promise<TeamAgentOffer> {
  return (await teamRequest<{ offer: TeamAgentOffer }>(`/api/team/teams/${encodeURIComponent(teamID)}/agent-offers`, {
    method: 'POST',
    body: {
      request_id: requestID(), expected_revision: expectedRevision,
      daemon_id: candidate.daemon_id, provider: candidate.provider, runtime_profile_id: null,
    },
  })).offer
}

export async function revokeTeamAgentOffer(offer: TeamAgentOffer): Promise<TeamAgentOffer> {
  return (await teamRequest<{ offer: TeamAgentOffer }>(`/api/team/agent-offers/${encodeURIComponent(offer.id)}`, {
    method: 'DELETE', body: { request_id: requestID(), expected_revision: offer.revision },
  })).offer
}

export async function removeTeamMember(teamID: string, member: TeamMember): Promise<TeamMember> {
  return (await teamRequest<{ membership: TeamMember }>(`/api/team/teams/${encodeURIComponent(teamID)}/members/${encodeURIComponent(member.id)}`, {
    method: 'DELETE', body: { request_id: requestID(), expected_revision: member.revision },
  })).membership
}

export async function leaveTeam(team: TeamSummary, membershipRevision: number): Promise<void> {
  await teamRequest(`/api/team/teams/${encodeURIComponent(team.id)}/leave`, {
    method: 'POST', body: { request_id: requestID(), expected_revision: membershipRevision },
  })
}

export async function dissolveTeam(team: TeamSummary): Promise<void> {
  await teamRequest(`/api/team/teams/${encodeURIComponent(team.id)}`, {
    method: 'DELETE', body: { request_id: requestID(), expected_revision: team.revision },
  })
}

export async function getTeamMemoryBinding(teamID: string): Promise<TeamMemoryBinding | null> {
  try {
    const binding = (await teamRequest<{ binding: TeamMemoryBinding | null }>(
      `/api/team/teams/${encodeURIComponent(teamID)}/memory-binding`,
    )).binding
    if (!binding || binding.access_state !== 'available') resetScopedMemoryAuthorization()
    return binding
  } catch (error) {
    if (error instanceof TeamApiError && [403, 404, 409, 503].includes(error.status)) {
      resetScopedMemoryAuthorization()
    }
    throw error
  }
}

export async function bindTeamMemory(
  teamID: string,
  installationID: string,
  expectedRevision: number,
): Promise<TeamMemoryBinding> {
  const binding = (await teamRequest<{ binding: TeamMemoryBinding }>(
    `/api/team/teams/${encodeURIComponent(teamID)}/memory-binding`,
    {
      method: 'PUT',
      body: {
        request_id: requestID(),
        expected_revision: expectedRevision,
        installation_id: installationID,
      },
    },
  )).binding
  resetScopedMemoryAuthorization()
  return binding
}

export async function removeTeamMemoryBinding(binding: TeamMemoryBinding): Promise<void> {
  await teamRequest(`/api/team/teams/${encodeURIComponent(binding.team_id)}/memory-binding`, {
    method: 'DELETE',
    body: { request_id: requestID(), expected_revision: binding.revision },
  })
  resetScopedMemoryAuthorization()
}

export async function listTeamTasks(teamID: string, includeDeleted = true, pool: TeamTaskPoolFilter = 'all', identity?: TeamRequestIdentity): Promise<TeamTask[]> {
  const query = pool !== 'all' ? `?pool=${encodeURIComponent(pool)}` : includeDeleted ? '?include_deleted=true' : ''
  return (await teamRequest<{ tasks: TeamTask[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/tasks${query}`, {identity})).tasks
}

export async function getTeamTask(taskID: string, identity?: TeamRequestIdentity): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(taskID)}`, {identity})).task
}

export async function createTeamTask(teamID: string, title: string, background: string): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/teams/${encodeURIComponent(teamID)}/tasks`, {
    method: 'POST', body: { request_id: requestID(), title, background },
  })).task
}

export async function updateTeamTask(task: TeamTask, input: { title?: string; background?: string; state?: Exclude<TeamTaskState, 'deleted'> }): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(task.id)}`, {
    method: 'PATCH', body: { request_id: requestID(), expected_revision: task.revision, ...input },
  })).task
}

export interface TeamTaskHolderInput { request_id: string; expected_revision: number }
export interface TeamTaskHolderReceipt { task_id: string; actor_user_id: number; request_id: string; found: boolean; response: TeamTask | null }

// Recovery callers must persist input before sending and pass the original
// identity. The convenience wrapper below is retained for existing callers.
export async function mutateTeamTaskSelfHolder(taskID: string, active: boolean, input: TeamTaskHolderInput, identity?: TeamRequestIdentity): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(taskID)}/holders/self`, {
    method: active ? 'POST' : 'DELETE', body: { request_id: input.request_id, expected_revision: input.expected_revision }, identity, timeoutMs: 15000,
  })).task
}
export async function findTeamTaskSelfHolder(taskID: string, originalRequestID: string, identity: TeamRequestIdentity): Promise<TeamTaskHolderReceipt> {
  return teamRequest(`/api/team/tasks/${encodeURIComponent(taskID)}/holders/self/receipt?request_id=${encodeURIComponent(originalRequestID)}`, { identity, timeoutMs: 15000 })
}
export async function setTeamTaskSelfHolder(task: TeamTask, active: boolean): Promise<TeamTask> {
  return mutateTeamTaskSelfHolder(task.id, active, { request_id: requestID(), expected_revision: task.revision })
}

export async function setTeamTaskHolder(task: TeamTask, userID: number, active: boolean): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(task.id)}/holders/${userID}`, {
    method: active ? 'PUT' : 'DELETE', body: { request_id: requestID(), expected_revision: task.revision },
  })).task
}

export async function deleteTeamTask(task: TeamTask): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(task.id)}`, {
    method: 'DELETE', body: { request_id: requestID(), expected_revision: task.revision },
  })).task
}

export async function restoreTeamTask(task: TeamTask): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(task.id)}/restore`, {
    method: 'POST', body: { request_id: requestID(), expected_revision: task.revision },
  })).task
}

export async function listTeamSessions(teamID: string, filters: { daemonID?: string; provider?: TeamProvider } = {}): Promise<TeamSessionSummary[]> {
  const query = new URLSearchParams()
  if (filters.daemonID) query.set('daemon_id', filters.daemonID)
  if (filters.provider) query.set('provider', filters.provider)
  const suffix = query.size ? `?${query}` : ''
  return (await teamRequest<{ sessions: TeamSessionSummary[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/sessions${suffix}`)).sessions
}

export async function getTeamSession(sessionID: string): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/sessions/${encodeURIComponent(sessionID)}`)).session
}

export async function createTeamSession(teamID: string, input: { title: string; taskID?: string | null; offerIDs: string[];participantUserIDs?:number[];agentConfigs?:Record<string,{mode:'default'|'custom';override?:Partial<import('../types/team').TeamRuntimeConfig>;capability_revision?:string}>;requestID?:string }): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/teams/${encodeURIComponent(teamID)}/sessions`, {
    method: 'POST', body: { request_id: input.requestID ?? requestID(), title: input.title, task_id: input.taskID ?? null, offer_ids: input.offerIDs,participant_user_ids:input.participantUserIDs??[],...(input.agentConfigs?{agent_configs:input.agentConfigs}:{}) },
  })).session
}

export async function updateTeamSession(session: TeamSession, input: { title?: string; state?: TeamSessionState }): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PATCH', body: { request_id: requestID(), expected_revision: session.revision, ...input },
  })).session
}

export async function listTeamCalls(sessionID: string): Promise<TeamCallSummary[]> {
  return (await teamRequest<{ calls: TeamCallSummary[] }>(`/api/team/sessions/${encodeURIComponent(sessionID)}/calls`)).calls
}

export async function listTeamEvents(sessionID: string, afterSequence = 0, limit = 100): Promise<{ events: TeamEvent[]; next_cursor: number | null;shared_high_water?:number;completed_through?:number;reset_required?:boolean;retained_after_seq?:number }> {
  return teamRequest(`/api/team/sessions/${encodeURIComponent(sessionID)}/events?after_seq=${afterSequence}&limit=${limit}`)
}

export async function appendTeamMessage(sessionID: string, input: { content: string; targetMode: TeamMessageTargetMode; targetOfferIDs?: string[]; referenceEventID?: string | null;requestID?:string }): Promise<{ event: TeamEvent; call_ids: string[] }> {
  return teamRequest(`/api/team/sessions/${encodeURIComponent(sessionID)}/events`, {
    method: 'POST',
    body: {
      request_id: input.requestID ?? requestID(), content: input.content, target_mode: input.targetMode,
      target_offer_ids: input.targetOfferIDs ?? [], reference_event_id: input.referenceEventID ?? null,
    },
  })
}

export async function getTeamContext(sessionID: string, version?: number): Promise<TeamContextSnapshot | null> {
  const query = version === undefined ? '' : `?version=${version}`
  return (await teamRequest<{ context: TeamContextSnapshot | null }>(`/api/team/sessions/${encodeURIComponent(sessionID)}/context${query}`)).context
}

export async function createTeamContext(sessionID: string, input: {
  expectedRevision: number
  goal: string
  consensus: string[]
  openQuestions: string[]
  references: TeamContextSnapshot['references']
}): Promise<TeamContextSnapshot> {
  return (await teamRequest<{ context: TeamContextSnapshot }>(
    `/api/team/sessions/${encodeURIComponent(sessionID)}/context`, {
      method: 'POST',
      body: {
        request_id: requestID(), expected_revision: input.expectedRevision,
        goal: input.goal, consensus: input.consensus, open_questions: input.openQuestions,
        references: input.references,
      },
    },
  )).context
}

export async function listTeamRuns(sessionID: string): Promise<TeamRun[]> {
  return (await teamRequest<{ runs: TeamRun[] }>(`/api/team/sessions/${encodeURIComponent(sessionID)}/runs`)).runs
}

export async function createTeamRun(sessionID: string, input: {
  mode?:import('../types/team').TeamRunMode
  participantOfferIDs?:string[]
  maxRounds?:number
  requestID?:string
  coordinatorOfferID: string
  contextVersion: number
  budget?: Partial<TeamRun['budget']>
}): Promise<TeamRun> {
  return (await teamRequest<{ run: TeamRun }>(`/api/team/sessions/${encodeURIComponent(sessionID)}/runs`, {
    method: 'POST',
    body: {
      request_id: input.requestID??requestID(), coordinator_offer_id: input.coordinatorOfferID,
      ...(input.mode ? {mode:input.mode,participant_offer_ids:input.participantOfferIDs,max_rounds:input.maxRounds??3}:{}),
      context_version: input.contextVersion, ...(input.budget ? { budget: input.budget } : {}),
    },
  })).run
}

export async function controlTeamRun(run: TeamRun, action: 'pause' | 'resume' | 'cancel'): Promise<TeamRun> {
  return (await teamRequest<{ run: TeamRun }>(`/api/team/runs/${encodeURIComponent(run.id)}`, {
    method: 'PATCH', body: { request_id: requestID(), expected_revision: run.revision, action },
  })).run
}

export async function supplementTeamRun(run: TeamRun, content: string): Promise<TeamRun> {
  return (await teamRequest<{ run: TeamRun }>(`/api/team/runs/${encodeURIComponent(run.id)}/input`, {
    method: 'POST', body: { request_id: requestID(), expected_revision: run.revision, content },
  })).run
}

export async function setTeamSessionParticipant(session: TeamSession, userID: number, active: boolean): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/sessions/${encodeURIComponent(session.id)}/participants/${userID}`, {
    method: active ? 'PUT' : 'DELETE', body: { request_id: requestID(), expected_revision: session.revision },
  })).session
}

export async function setTeamSessionAgentBinding(session: TeamSession, offerID: string, active: boolean): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/sessions/${encodeURIComponent(session.id)}/agent-bindings/${encodeURIComponent(offerID)}`, {
    method: active ? 'PUT' : 'DELETE', body: { request_id: requestID(), expected_revision: session.revision },
  })).session
}

export interface CreateTeamWorkspaceInput {
  description?: string
  name: string
  invitationEmails: string[]
  agents: TeamAgentCandidate[]
}

export interface CreateTeamWorkspaceResult {
  team: TeamSummary
  warnings: string[]
}

export async function createTeamWorkspace(input: CreateTeamWorkspaceInput): Promise<CreateTeamWorkspaceResult> {
  let team = await createTeam(input.name, input.description)
  const warnings: string[] = []
  for (const email of input.invitationEmails) {
    try {
      await inviteTeamMember(team.id, email, team.revision)
      team = { ...team, revision: team.revision + 1 }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Unable to invite ${email}`)
    }
  }
  for (const agent of input.agents) {
    try {
      await addTeamAgentOffer(team.id, agent, team.revision)
      team = { ...team, revision: team.revision + 1 }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Unable to add ${agent.provider}`)
    }
  }
  return { team, warnings }
}

export async function changeTeamMemberRole(teamID: string, member: TeamMember, role: import('../types/team').TeamRole): Promise<TeamMember> {
  return (await teamRequest<{ membership: TeamMember }>(`/api/team/teams/${encodeURIComponent(teamID)}/members/${encodeURIComponent(member.id)}/role`, {method:'PATCH',body:{request_id:requestID(),expected_revision:member.revision,role}})).membership
}

export function findTeamMessage(session:string,request:string):Promise<{event:TeamEvent;call_ids:string[]}>{return teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/messages/by-request/${encodeURIComponent(request)}`)}
export function markTeamRead(session:string,eventSeq:number):Promise<{event_seq:number}>{return teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/read-position`,{method:'PUT',body:{event_seq:eventSeq}})}
export async function getTeamAgentCapabilities(session:string,offer:string,team?:string):Promise<import('../types/team').TeamAgentConfigCapabilities>{
 const path=team?`teams/${encodeURIComponent(team)}/agents`:`sessions/${encodeURIComponent(session)}/agent-bindings`
 return (await teamRequest<{capabilities:import('../types/team').TeamAgentConfigCapabilities}>(`/api/team/${path}/${encodeURIComponent(offer)}/capabilities`)).capabilities
}
export async function saveTeamAgentConfig(session:string,offer:string,input:{request_id:string;mode:'default'|'custom';override:Partial<import('../types/team').TeamRuntimeConfig>;expected_config_revision:number;capability_revision:string}):Promise<import('../types/team').SessionAgentConfig>{
 return (await teamRequest<{config:import('../types/team').SessionAgentConfig}>(`/api/team/sessions/${encodeURIComponent(session)}/agent-bindings/${encodeURIComponent(offer)}/config`,{method:'PUT',body:input})).config
}
export function assignTeamTask(session:string,input:import('./teamTaskAssignmentJournal').TaskAssignmentInput,identity?:TeamRequestIdentity):Promise<import('./teamTaskAssignmentJournal').TaskAssignmentResult>{return teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/tasks`,{method:'POST',body:input,timeoutMs:30000,identity})}
export function findTeamTaskAssignment(session:string,request:string,identity?:TeamRequestIdentity):Promise<import('./teamTaskAssignmentJournal').TaskAssignmentReceipt>{return teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/tasks/by-request/${encodeURIComponent(request)}`,{timeoutMs:15000,identity})}
export function listTeamInteractions(session:string):Promise<{items:import('../types/attentionInbox').AttentionInboxItem[];private_cursor:string}>{return teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/interactions`)}
export function actTeamInteraction(session:string,item:string,key:string,revision:number,action:'once'|'reject'):Promise<unknown>{return teamRequest(`/api/team/sessions/${encodeURIComponent(session)}/interactions/${encodeURIComponent(item)}/actions`,{method:'POST',headers:{'Idempotency-Key':key},body:{expected_revision:revision,action_id:action}})}

// The caller persists the original request before sending. Retrying these helpers
// never allocates a new id or substitutes a freshly read task revision.
export async function saveTeamTaskRequirements(taskID:string,input:TeamTaskRequirementsInput,identity:TeamRequestIdentity):Promise<TeamTask> {
  return (await teamRequest<{task:TeamTask}>(`/api/team/tasks/${encodeURIComponent(taskID)}/requirements`,{method:'PUT',body:{...input},identity,timeoutMs:15000})).task
}
export async function overrideTeamTaskRequirements(taskID:string,input:TeamTaskRequirementOverrideInput,identity:TeamRequestIdentity):Promise<TeamTask> {
  return (await teamRequest<{task:TeamTask}>(`/api/team/tasks/${encodeURIComponent(taskID)}/requirements/override`,{method:'POST',body:{...input},identity,timeoutMs:15000})).task
}
export async function getTeamTaskRequirementHistory(taskID:string,identity:TeamRequestIdentity,beforeRevision?:number):Promise<TeamTaskRequirementHistory> {
  if(beforeRevision!==undefined&&(!Number.isSafeInteger(beforeRevision)||beforeRevision<=0))throw new RangeError('Invalid requirement history cursor')
  const query=beforeRevision===undefined?'':`?before_revision=${beforeRevision}`
  return teamRequest(`/api/team/tasks/${encodeURIComponent(taskID)}/requirements/history${query}`,{identity,timeoutMs:15000})
}
export async function findTeamTaskRequirements(taskID:string,kind:'save'|'override',requestID:string,identity:TeamRequestIdentity):Promise<import('../types/teamTaskRequirements').RequirementsReceipt> {
  return teamRequest(`/api/team/tasks/${encodeURIComponent(taskID)}/requirements/receipt?kind=${encodeURIComponent(kind)}&request_id=${encodeURIComponent(requestID)}`,{identity,timeoutMs:15000})
}
