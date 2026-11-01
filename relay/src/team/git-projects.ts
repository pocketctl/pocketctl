import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export type GitProjectSetup = 'memory_required' | 'repository_authorization_required'
export interface GitProject {
  id: string; team_id: string; team_name: string; name: string
  provider: 'github' | 'gitee'; repository_url: string; branch: string
  request_id: string; created_at: string | Date; setup: GitProjectSetup
  memory_installation_id: string | null; memory_status: string | null; can_initialize: boolean
}
export interface GitProjectTeam { id: string; name: string; can_create: boolean }
export class GitProjectError extends Error {
  constructor(readonly code: 'invalid_request' | 'team_access_denied' | 'creator_required' | 'idempotency_conflict' | 'project_exists') { super(code) }
}
const invalid = (): never => { throw new GitProjectError('invalid_request') }

/** Parse supported public host names only. Creating a project never fetches this URL. */
export function parseGitProject(input: unknown): { name: string; provider: 'github' | 'gitee'; repository_url: string; branch: string; request_id: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const body = input as Record<string, unknown>
  if (Object.keys(body).some(key => !['name', 'repository_url', 'branch', 'request_id'].includes(key))) return invalid()
  if (typeof body.name !== 'string' || typeof body.repository_url !== 'string' || typeof body.branch !== 'string' || typeof body.request_id !== 'string') return invalid()
  const name = body.name.trim(), branch = body.branch.trim(), request_id = body.request_id.trim()
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name) || !/^[A-Za-z0-9._:-]{1,128}$/.test(request_id)) return invalid()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch === 'HEAD' || branch.includes('..') || branch.endsWith('.') || branch.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.lock'))) return invalid()
  let raw = body.repository_url.trim()
  if (raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) return invalid()
  raw = raw.replace(/^git@(github\.com|gitee\.com):/i, 'https://$1/')
  let url: URL
  try { url = new URL(raw) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['github.com', 'gitee.com'].includes(url.hostname)) return invalid()
  const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').slice(1)
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(p) || p.includes('..') || p.endsWith('.'))) return invalid()
  return { name, branch, request_id, provider: url.hostname === 'github.com' ? 'github' : 'gitee', repository_url: `https://${url.hostname}/${parts.join('/')}` }
}

export async function initGitProjectSchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS team_git_projects (
    project_id UUID PRIMARY KEY, team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL, provider TEXT NOT NULL CHECK(provider IN('github','gitee')),
    repository_url VARCHAR(2048) NOT NULL, branch VARCHAR(200) NOT NULL,
    created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
    creation_request_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id,creation_request_id), UNIQUE(team_id,repository_url,branch)
  )`)
}

const projectColumns = `p.project_id::text AS id,p.team_id,t.name AS team_name,p.name,p.provider,p.repository_url,p.branch,
  p.creation_request_id AS request_id,p.created_at,
  (SELECT b.installation_id FROM team_memory_bindings b WHERE b.team_id=p.team_id AND b.state='active') AS memory_installation_id,
  (SELECT i.status FROM team_memory_bindings b JOIN extension_installations i USING(installation_id) WHERE b.team_id=p.team_id AND b.state='active') AS memory_status,
  (t.creator_user_id=$1) AS can_initialize,
  CASE WHEN EXISTS(SELECT 1 FROM team_memory_bindings b JOIN extension_installations i USING(installation_id)
    WHERE b.team_id=p.team_id AND b.state='active' AND b.owner_scope_kind IN('team','organization') AND i.status='active'
      AND i.provider_id='pocketctl-memory' AND i.owner_scope_kind=b.owner_scope_kind AND i.owner_scope_id=b.owner_scope_id)
    THEN 'repository_authorization_required' ELSE 'memory_required' END AS setup`

export interface GitProjectService {
  list(actor: number): Promise<{ teams: GitProjectTeam[]; projects: GitProject[] }>
  create(teamId: string, actor: number, input: ReturnType<typeof parseGitProject>): Promise<{ project: GitProject; created: boolean }>
}

export function createGitProjectService(pool: pg.Pool): GitProjectService {
  return {
    async list(actor) {
      const teams = await pool.query<GitProjectTeam>(`SELECT t.team_id AS id,t.name,
        (t.creator_user_id=$1 OR m.role='admin') AS can_create
        FROM collaboration_teams t JOIN collaboration_team_memberships m USING(team_id)
        WHERE m.user_id=$1 AND m.state='active' AND t.state='active' ORDER BY t.name,t.team_id`, [actor])
      // A single authorized query prevents a previously loaded Team list from conferring read access.
      const projects = await pool.query<GitProject>(`SELECT ${projectColumns} FROM team_git_projects p
        JOIN collaboration_teams t USING(team_id) JOIN collaboration_team_memberships m USING(team_id)
        WHERE m.user_id=$1 AND m.state='active' AND t.state='active' ORDER BY p.created_at DESC,p.project_id LIMIT 200`, [actor])
      return { teams: teams.rows, projects: projects.rows }
    },
    async create(teamId, actor, input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const team = (await client.query<{ creator_user_id: number }>(`SELECT creator_user_id FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR UPDATE`, [teamId])).rows[0]
        const member = (await client.query<{ role: string }>(`SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE`, [teamId, actor])).rows[0]
        if (!team || !member) throw new GitProjectError('team_access_denied')
        if (team.creator_user_id !== actor && member.role !== 'admin') throw new GitProjectError('creator_required')
        const saved = (await client.query(`SELECT project_id,created_by_user_id,name,repository_url,branch FROM team_git_projects WHERE team_id=$1 AND creation_request_id=$2`, [teamId, input.request_id])).rows[0]
        let id: string, created = false
        if (saved) {
          if (saved.created_by_user_id !== actor || saved.name !== input.name || saved.repository_url !== input.repository_url || saved.branch !== input.branch) throw new GitProjectError('idempotency_conflict')
          id = saved.project_id
        } else {
          if ((await client.query(`SELECT 1 FROM team_git_projects WHERE team_id=$1 AND repository_url=$2 AND branch=$3`, [teamId, input.repository_url, input.branch])).rowCount) throw new GitProjectError('project_exists')
          id = randomUUID()
          await client.query(`INSERT INTO team_git_projects(project_id,team_id,name,provider,repository_url,branch,created_by_user_id,creation_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, teamId, input.name, input.provider, input.repository_url, input.branch, actor, input.request_id])
          created = true
        }
        const project = (await client.query<GitProject>(`SELECT ${projectColumns} FROM team_git_projects p JOIN collaboration_teams t USING(team_id) WHERE p.project_id=$2`, [actor, id])).rows[0]
        await client.query('COMMIT')
        return { project, created }
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
  }
}
