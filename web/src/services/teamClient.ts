import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'
import type {
  TeamAgentCandidate,
  TeamAgentOffer,
  TeamApiErrorBody,
  TeamCapabilities,
  TeamContextSnapshot,
  TeamEvent,
  TeamInvitation,
  TeamMember,
  TeamMessageTargetMode,
  TeamProvider,
  TeamSession,
  TeamSessionState,
  TeamSessionSummary,
  TeamSummary,
  TeamTask,
  TeamTaskState,
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

interface TeamRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: Record<string, unknown>
}

function requestID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function teamRequest<T>(path: string, options: TeamRequestOptions = {}, allowRefresh = true): Promise<T> {
  const { accessToken, doRefreshToken } = useAuth()
  let response: Response
  try {
    response = await fetch(`${getRelayOrigin()}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken.value ? { Authorization: `Bearer ${accessToken.value}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
  } catch {
    throw new TeamApiError(0, {
      error: { code: 'network_error', message: 'Network request failed', retryable: true },
    })
  }
  if (response.status === 401 && allowRefresh && await doRefreshToken()) {
    return teamRequest<T>(path, options, false)
  }
  const body = await response.json().catch(() => ({})) as T | TeamApiErrorBody
  if (!response.ok) throw new TeamApiError(response.status, body as TeamApiErrorBody)
  return body as T
}

export function getTeamCapabilities(): Promise<TeamCapabilities> {
  return teamRequest<TeamCapabilities>('/api/team/capabilities')
}

export async function listTeams(): Promise<TeamSummary[]> {
  return (await teamRequest<{ teams: TeamSummary[] }>('/api/team/teams')).teams
}

export async function getTeam(teamID: string): Promise<TeamSummary> {
  return (await teamRequest<{ team: TeamSummary }>(`/api/team/teams/${encodeURIComponent(teamID)}`)).team
}

export async function createTeam(name: string): Promise<TeamSummary> {
  return (await teamRequest<{ team: TeamSummary }>('/api/team/teams', {
    method: 'POST', body: { request_id: requestID(), name },
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

export async function inviteTeamMember(teamID: string, email: string, expectedRevision: number): Promise<TeamInvitation> {
  return (await teamRequest<{ invitation: TeamInvitation }>(`/api/team/teams/${encodeURIComponent(teamID)}/invitations`, {
    method: 'POST', body: { request_id: requestID(), expected_revision: expectedRevision, email },
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

export async function listTeamTasks(teamID: string, includeDeleted = true): Promise<TeamTask[]> {
  const query = includeDeleted ? '?include_deleted=true' : ''
  return (await teamRequest<{ tasks: TeamTask[] }>(`/api/team/teams/${encodeURIComponent(teamID)}/tasks${query}`)).tasks
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

export async function setTeamTaskSelfHolder(task: TeamTask, active: boolean): Promise<TeamTask> {
  return (await teamRequest<{ task: TeamTask }>(`/api/team/tasks/${encodeURIComponent(task.id)}/holders/self`, {
    method: active ? 'POST' : 'DELETE', body: { request_id: requestID(), expected_revision: task.revision },
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

export async function createTeamSession(teamID: string, input: { title: string; taskID?: string | null; offerIDs: string[] }): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/teams/${encodeURIComponent(teamID)}/sessions`, {
    method: 'POST', body: { request_id: requestID(), title: input.title, task_id: input.taskID ?? null, offer_ids: input.offerIDs },
  })).session
}

export async function updateTeamSession(session: TeamSession, input: { title?: string; state?: TeamSessionState }): Promise<TeamSession> {
  return (await teamRequest<{ session: TeamSession }>(`/api/team/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PATCH', body: { request_id: requestID(), expected_revision: session.revision, ...input },
  })).session
}

export async function listTeamEvents(sessionID: string, afterSequence = 0, limit = 100): Promise<{ events: TeamEvent[]; next_cursor: number | null }> {
  return teamRequest(`/api/team/sessions/${encodeURIComponent(sessionID)}/events?after_seq=${afterSequence}&limit=${limit}`)
}

export async function appendTeamMessage(sessionID: string, input: { content: string; targetMode: TeamMessageTargetMode; targetOfferIDs?: string[]; referenceEventID?: string | null }): Promise<{ event: TeamEvent; call_ids: string[] }> {
  return teamRequest(`/api/team/sessions/${encodeURIComponent(sessionID)}/events`, {
    method: 'POST',
    body: {
      request_id: requestID(), content: input.content, target_mode: input.targetMode,
      target_offer_ids: input.targetOfferIDs ?? [], reference_event_id: input.referenceEventID ?? null,
    },
  })
}

export async function getTeamContext(sessionID: string): Promise<TeamContextSnapshot | null> {
  return (await teamRequest<{ context: TeamContextSnapshot | null }>(`/api/team/sessions/${encodeURIComponent(sessionID)}/context`)).context
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
  name: string
  invitationEmails: string[]
  agents: TeamAgentCandidate[]
}

export interface CreateTeamWorkspaceResult {
  team: TeamSummary
  warnings: string[]
}

export async function createTeamWorkspace(input: CreateTeamWorkspaceInput): Promise<CreateTeamWorkspaceResult> {
  let team = await createTeam(input.name)
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
