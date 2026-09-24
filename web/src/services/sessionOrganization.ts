import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'

export interface SessionProject {
  id: string
  name: string
  count: number
  sort_position: string | number
  order_mode: 'activity' | 'manual'
  revision: string | number
}
export interface ProjectSnapshot {
  projects: SessionProject[]
  ungrouped_count: number
  archived_count: number
  project_order_revision: number
  ungrouped_revision: number
  ungrouped_order_mode: 'activity' | 'manual'
}
export interface OrganizedPage {
  sessions: any[]
  has_more: boolean
  next_cursor: string | null
  revision: number
  order_mode: 'activity' | 'manual'
}

export async function organizationRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { accessToken, doRefreshToken } = useAuth()
  const headers = new Headers(init.headers)
  if (init.body != null) headers.set('Content-Type', 'application/json')
  const request = () => {
    headers.set('Authorization', `Bearer ${accessToken.value}`)
    return fetch(`${getRelayOrigin()}${path}`, { ...init, headers, credentials: 'include', cache: 'no-store' })
  }
  let response = await request()
  if (response.status === 401 && await doRefreshToken()) response = await request()
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}
export const listProjects = (daemonId?: string) => organizationRequest<ProjectSnapshot>(`/api/session-projects${daemonId ? `?daemon_id=${encodeURIComponent(daemonId)}` : ''}`)
export const createProject = (name: string) => organizationRequest<SessionProject>('/api/session-projects', { method: 'POST', body: JSON.stringify({ name }) })
export const renameProject = (id: string, name: string, expectedRevision: number) => organizationRequest<SessionProject>(`/api/session-projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, expected_revision: expectedRevision }) })
export const reorderProjects = (projectIds: string[], expectedRevision: number) => organizationRequest<{ revision: number }>('/api/session-projects/order', { method: 'PUT', body: JSON.stringify({ project_ids: projectIds, expected_revision: expectedRevision }) })
export const listOrganizedSessions = (options: { bucket?: string; view?: 'active' | 'archived'; daemonId?: string; q?: string; limit?: number; cursor?: string }) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries({ bucket: options.bucket, view: options.view, daemon_id: options.daemonId, q: options.q, limit: options.limit, cursor: options.cursor })) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  return organizationRequest<OrganizedPage>(`/api/organized-sessions?${query}`)
}
export const moveSession = (id: string, projectId: string | null) => organizationRequest<{ project_id: string | null }>(`/api/sessions/${encodeURIComponent(id)}/project`, { method: 'PUT', body: JSON.stringify({ project_id: projectId }) })
export const archiveSession = (id: string, archived: boolean) => organizationRequest<{ archived: boolean }>(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'PUT', body: JSON.stringify({ archived }) })
export const markSessionSeen = (id: string) => organizationRequest<{ seen: boolean }>(`/api/sessions/${encodeURIComponent(id)}/seen`, { method: 'PUT' })
export const getSessionSummary = (id: string) => organizationRequest<any>(`/api/sessions/${encodeURIComponent(id)}/summary`)
export const reorderSession = (bucket: string, sessionId: string, beforeId: string | null, expectedRevision: number) => organizationRequest<{ revision: number }>('/api/session-order', { method: 'PUT', body: JSON.stringify({ bucket, session_id: sessionId, before_id: beforeId, expected_revision: expectedRevision }) })
