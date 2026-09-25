export const MEMORY_MODULE_GROUPS = [
  { id: 'knowledge', modules: ['search', 'review', 'claims', 'wiki', 'codegraph'] },
  { id: 'collaboration', modules: ['skills', 'git'] },
  { id: 'context', modules: ['context', 'persona', 'policies', 'loadouts'] },
  { id: 'service', modules: ['settings'] },
] as const

export type MemoryModule = typeof MEMORY_MODULE_GROUPS[number]['modules'][number]
export type MemoryModuleGroup = typeof MEMORY_MODULE_GROUPS[number]['id']
