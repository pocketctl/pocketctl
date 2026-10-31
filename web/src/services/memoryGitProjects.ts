import { teamRequest, type TeamRequestIdentity } from './teamClient'

export interface GitOpsProject {
  id: string; team_id: string; team_name: string; name: string
  provider: 'github' | 'gitee'; repository_url: string; branch: string; request_id: string
  created_at: string; setup: 'memory_required' | 'repository_authorization_required'
  memory_installation_id?: string | null; memory_status?: string | null; can_initialize?: boolean
}
export interface GitOpsProjectTeam { id: string; name: string; can_create: boolean }
export interface GitOpsProjectInput { name: string; repository_url: string; branch: string; request_id: string }
export const memoryGitProjects = {
  initialize: (teamId:string,identity:TeamRequestIdentity) => teamRequest<{installation_id:string}>(`/api/team/teams/${encodeURIComponent(teamId)}/git-memory`,{method:'POST',body:{confirm_shared_memory:true},identity,timeoutMs:15_000}),
  list: (identity: TeamRequestIdentity) => teamRequest<{ teams: GitOpsProjectTeam[]; projects: GitOpsProject[] }>('/api/team/git-projects', { identity }),
  create: (teamId: string, input: GitOpsProjectInput, identity: TeamRequestIdentity) => teamRequest<{ project: GitOpsProject }>(`/api/team/teams/${encodeURIComponent(teamId)}/git-projects`, { method: 'POST', body: { ...input }, identity, timeoutMs: 15_000 }),
}
