import type { CommandItem } from '../composables/useWebSocket'
export function searchInvocations(items: CommandItem[], draft: string): CommandItem[] {
  if (!draft.startsWith('/')) return []
  const query = draft.slice(1).split(/\s/, 1)[0].toLowerCase()
  const rank = (item: CommandItem) => item.name.toLowerCase() === query ? 0 : item.name.toLowerCase().startsWith(query) ? 1 : item.name.toLowerCase().includes(query) ? 2 : 3
  return items.filter(item => !query || item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query)).sort((a,b) => rank(a)-rank(b) || a.name.localeCompare(b.name))
}
export function completeInvocation(item: CommandItem, draft: string): string {
  const args = draft.match(/^\/\S+\s+([\s\S]*)$/)?.[1] || ''
  return `/${item.name} ${args}`
}
