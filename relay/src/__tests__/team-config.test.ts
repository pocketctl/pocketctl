import Fastify from 'fastify'
import { describe, expect, test } from 'vitest'

import {
  registerTeamCapabilityRoutes,
  resolveTeamCollaborationConfig,
  teamCapabilitySnapshot,
} from '../team/config.js'

describe('Team collaboration configuration', () => {
  test('is fully disabled by default', () => {
    const config = resolveTeamCollaborationConfig({})
    expect(config).toEqual({ collaboration: 'off', autorun: 'off', memoryBridge: 'off' })
    expect(teamCapabilitySnapshot(config, { memoryExtensionAvailable: true })).toEqual({
      schema_version: 1,
      contract_version: 'team-collaboration.v1',
      collaboration: false,
      autorun: false,
      memory_bridge: false,
      writes_enabled: false,
    })
  })

  test('rejects unknown values and impossible child feature combinations', () => {
    expect(() => resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'true' }))
      .toThrow('TEAM_COLLABORATION')
    expect(() => resolveTeamCollaborationConfig({ TEAM_AUTORUN: 'on' }))
      .toThrow('requires TEAM_COLLABORATION')
    expect(() => resolveTeamCollaborationConfig({ TEAM_MEMORY_BRIDGE: 'on' }))
      .toThrow('requires TEAM_COLLABORATION')
  })

  test('does not advertise the Memory bridge when Extension service is unavailable', () => {
    const config = resolveTeamCollaborationConfig({
      TEAM_COLLABORATION: 'on',
      TEAM_AUTORUN: 'on',
      TEAM_MEMORY_BRIDGE: 'on',
    })
    expect(teamCapabilitySnapshot(config, { memoryExtensionAvailable: false }))
      .toMatchObject({ collaboration: true, autorun: true, memory_bridge: false })
  })
})

describe('GET /api/team/capabilities', () => {
  test('requires authentication and reports server-owned flags', async () => {
    const app = Fastify()
    registerTeamCapabilityRoutes(app, {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
      memoryExtensionAvailable: false,
      verifyAccessToken: async token => token === 'valid' ? { userId: 7 } : null,
    })

    const unauthorized = await app.inject({ method: 'GET', url: '/api/team/capabilities' })
    expect(unauthorized.statusCode).toBe(401)

    const response = await app.inject({
      method: 'GET',
      url: '/api/team/capabilities',
      headers: { authorization: 'Bearer valid' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      schema_version: 1,
      contract_version: 'team-collaboration.v1',
      collaboration: true,
      autorun: false,
      memory_bridge: false,
      writes_enabled: true,
    })
    await app.close()
  })
})
