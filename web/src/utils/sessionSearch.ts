export type SearchableSession = {
  title?: string | null
  model?: string | null
  agent?: string | null
  agent_type?: string | null
}

function normalizeSessionSearch(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[-_/]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function hasSessionSearchQuery(query: string): boolean {
  return normalizeSessionSearch(query).length > 0
}

export function matchesSessionSearch(session: SearchableSession, query: string): boolean {
  const needle = normalizeSessionSearch(query)
  if (!needle) return true

  const agent = session.agent || session.agent_type || ''
  const agentAliases = agent === 'codex-desktop' ? 'desktop Codex Desktop 客户端' : ''
  return [session.title || '', session.model || '', agent, agentAliases]
    .some(value => normalizeSessionSearch(value).includes(needle))
}
