import { TeamRepositoryError } from './repository.js'
export interface CodeStep {
  repository: string
  base_sha: string
  grant_revision: string
  kind: 'develop' | 'merge' | 'verify'
  paths: string[]
  tools: string[]
}
export interface CodeGrant {
  team_id: string
  offer_id: string
  repository: string
  base_sha: string
  grant_revision: string
  paths: string[]
  tools: string[]
}
const sha = /^[a-f0-9]{40}$/
const token = /^[A-Za-z0-9._/-]{1,160}$/
function pathAllowed(path: string) {
  return (
    token.test(path) &&
    path
      .split('/')
      .every(
        (p) =>
          p !== '' &&
          p !== '.' &&
          p !== '..' &&
          p.toLowerCase() !== '.git' &&
          !p.toLowerCase().startsWith('.pocketctl'),
      )
  )
}
export function validCodeStep(raw: unknown): raw is CodeStep {
  const c = raw as CodeStep
  return (
    !!c &&
    typeof c === 'object' &&
    Object.keys(c).every((k) => ['repository', 'base_sha', 'grant_revision', 'kind', 'paths', 'tools'].includes(k)) &&
    typeof c.repository === 'string' &&
    token.test(c.repository) &&
    sha.test(c.base_sha) &&
    /^[a-f0-9]{64}$/.test(c.grant_revision) &&
    ['develop', 'merge', 'verify'].includes(c.kind) &&
    Array.isArray(c.paths) &&
    c.paths.length > 0 &&
    c.paths.length <= 32 &&
    c.paths.every((p) => typeof p === 'string' && pathAllowed(p)) &&
    Array.isArray(c.tools) &&
    c.tools.length <= 16 &&
    c.tools.every((t) => typeof t === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(t))
  )
}
export function codeGrants(agents: unknown, provider: string, team: string, offer: string): CodeGrant[] {
  const raw = Array.isArray(agents) ? agents.find((a) => a?.type === provider)?.team_config?.code_workspaces : undefined
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (g) =>
        g &&
        g.team_id === team &&
        g.offer_id === offer &&
        validCodeStep({
          repository: g.repository,
          base_sha: g.base_sha,
          grant_revision: g.grant_revision,
          kind: 'develop',
          paths: g.paths,
          tools: g.tools,
        }),
    )
    .map((g) => ({
      team_id: team,
      offer_id: offer,
      repository: g.repository,
      base_sha: g.base_sha,
      grant_revision: g.grant_revision,
      paths: g.paths,
      tools: g.tools,
    }))
}
export function requireCodeGrant(code: CodeStep, agents: unknown, provider: string, team: string, offer: string) {
  if (
    !codeGrants(agents, provider, team, offer).some(
      (g) =>
        g.repository === code.repository &&
        g.base_sha === code.base_sha &&
        g.grant_revision === code.grant_revision &&
        code.paths.every((p) => g.paths.some((root) => p === root || p.startsWith(root + '/'))) &&
        code.tools.every((t) => g.tools.includes(t)),
    )
  ) {
    throw new TeamRepositoryError('capability_not_supported', '执行机器的仓库授权、起点或必需工具已变化')
  }
}
