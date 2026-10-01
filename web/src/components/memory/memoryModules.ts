export const MEMORY_MODULE_GROUPS = [
  { id: 'knowledge', modules: ['search', 'claims', 'wiki', 'codegraph', 'skills'] },
  { id: 'collaboration', modules: ['review', 'git'] },
  { id: 'context', modules: ['context', 'persona', 'policies', 'loadouts'] },
  { id: 'service', modules: ['settings'] },
] as const

export type MemoryModule = typeof MEMORY_MODULE_GROUPS[number]['modules'][number]
export type MemoryModuleGroup = typeof MEMORY_MODULE_GROUPS[number]['id']

export const MEMORY_MODULE_ORDER: readonly MemoryModule[] = ['search', 'review', 'claims', 'wiki', 'codegraph', 'skills', 'git', 'context', 'persona', 'policies', 'loadouts', 'settings']
