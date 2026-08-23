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

  return [session.title || '', session.model || '', session.agent || session.agent_type || '']
    .some(value => normalizeSessionSearch(value).includes(needle))
}
