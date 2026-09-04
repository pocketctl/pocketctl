import Fastify from 'fastify'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { registerMcpRoute } from '../mcp/server.js'
import type { RouteV2Grant } from '../governance/authorization.js'

const TEAM = '22222222-2222-4222-8222-222222222222'

function parseRpc(text: string): Record<string, unknown> {
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const data = text.split('\n').find(line => line.startsWith('data:'))
    return JSON.parse(data!.slice(5).trim())
  }
  return JSON.parse(text)
}

describe('Phase 3 MCP scope contract', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  test('federated reads and shared details expose explicit installation selectors', async () => {
    const app = Fastify()
    apps.push(app)
    const grant: RouteV2Grant = {
      version: 'v2',
      installationId: TEAM,
      primaryInstallationId: TEAM,
      services: ['memory.mcp'],
      configVersion: '1',
      callerType: 'agent',
      scopeBindings: [{
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: '33333333-3333-4333-8333-333333333333',
        membership_id: '44444444-4444-4444-8444-444444444444',
        membership_revision: '2',
        authorization_epoch: '7',
        permissions: ['read'],
      }],
    }
    const guardMcp = vi.fn(async () => grant)
    registerMcpRoute(app, {
      pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
      guard: { guard: vi.fn(), guardV2: vi.fn(), guardMcp } as never,
      policy: { hostAllowed: () => true, originAllowed: () => true } as never,
      providerVersion: 'test',
      recallEmbeddingTimeoutMs: 10,
      cursorSigningKey: 'test-cursor-key',
      sharedScopesEnabled: true,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'memory.test', authorization: 'Bearer v2', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(response.statusCode).toBe(200)
    expect(guardMcp).toHaveBeenCalledWith({
      authorization: 'Bearer v2', requiredService: 'memory.mcp',
    })
    const rpc = parseRpc(response.body) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }
    }
    const tool = (name: string) => rpc.result.tools.find(entry => entry.name === name)!
    expect(tool('memory_search').inputSchema.properties).toHaveProperty('scope_installation_ids')
    expect(tool('memory_recall').inputSchema.properties).toHaveProperty('scope_installation_ids')
    expect(tool('memory_get_claim').inputSchema.properties).toHaveProperty('installation_id')
    expect(tool('memory_get_evidence').inputSchema.properties).toHaveProperty('installation_id')

    const implicit = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'memory.test', authorization: 'Bearer v2', 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'implicit shared read' } },
      },
    })
    expect(implicit.statusCode).toBe(200)
    const implicitRpc = parseRpc(implicit.body) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    }
    expect(implicitRpc.result?.isError).toBe(true)
    expect(implicitRpc.result?.content?.[0]?.text).toContain('explicit scope selection')
  })
})
