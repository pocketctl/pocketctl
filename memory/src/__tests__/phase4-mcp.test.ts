import { describe, expect, test } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'

import { registerMemoryTools } from '../mcp/tools.js'

describe('Phase 4 read-only MCP surface', () => {
  test('adds exactly three bounded Phase 4 reads and no mutation tools', () => {
    const registrations = new Map<string, { definition: unknown; handler: unknown }>()
    const server = {
      registerTool(name: string, definition: unknown, handler: unknown) {
        registrations.set(name, { definition, handler })
      },
    } as unknown as McpServer
    registerMemoryTools(server, {
      pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      grant: () => ({
        installationId: crypto.randomUUID(), services: ['memory.mcp'],
        configVersion: '1', callerType: 'web',
      }),
      sharedScopesEnabled: false,
      recallEmbeddingTimeoutMs: 50,
      cursorSigningKey: 'phase4-mcp-cursor',
    })
    expect([...registrations.keys()].filter(name => name.startsWith('memory_'))).toEqual([
      'memory_search', 'memory_recall', 'memory_get_claim', 'memory_get_evidence',
      'memory_find_related_episodes', 'memory_get_repository_context',
      'memory_get_code_graph', 'memory_analyze_change_impact', 'memory_get_wiki_page',
      'memory_list_skills', 'memory_get_skill', 'memory_resolve_skill',
    ])
    for (const forbidden of ['upload', 'build', 'publish', 'edit', 'lock', 'unlock', 'delete']) {
      expect([...registrations.keys()].some(name => name.includes(forbidden))).toBe(false)
    }
  })
})
