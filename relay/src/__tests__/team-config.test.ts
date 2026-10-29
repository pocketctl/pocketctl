import { evidenceConnectors } from '../team/evidence-service.js'
import Fastify from 'fastify'
import { describe, expect, test } from 'vitest'

import {
  registerTeamCapabilityRoutes,
  resolveTeamCollaborationConfig,
  teamCapabilitySnapshot,
  teamStepDeliveryEnabled,
  teamStepExecutionEnabled,
  teamDeliveryMemoryEnabled,
} from '../team/config.js'

describe('Team collaboration configuration', () => {
  test('accepted delivery candidates require separate opt-in, Memory bridge and the delivery Team allowlist', () => {
    const base = { TEAM_COLLABORATION: 'on', TEAM_TASK_DELIVERY_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: 'team', TEAM_MEMORY_BRIDGE: 'on' }
    expect(teamDeliveryMemoryEnabled(resolveTeamCollaborationConfig(base), 'team')).toBe(false)
    const config = resolveTeamCollaborationConfig({ ...base, TEAM_TASK_MEMORY_CANDIDATES_V1: 'on' })
    expect(teamDeliveryMemoryEnabled(config, 'team')).toBe(true)
    expect(teamDeliveryMemoryEnabled(config, 'other')).toBe(false)
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_MEMORY_CANDIDATES_V1: 'true' })).toThrow('TEAM_TASK_MEMORY_CANDIDATES_V1')
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_MEMORY_CANDIDATES_V1: 'on', TEAM_MEMORY_BRIDGE: 'off' })).toThrow('requires task delivery and Memory bridge')
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_MEMORY_CANDIDATES_V1: 'on', TEAM_TASK_DELIVERY_V1: 'off' })).toThrow('requires task delivery and Memory bridge')
  })
  test('step execution requires separate opt-in, draft, delivery, and Team allowlist', () => {
    const base = { TEAM_COLLABORATION: 'on', TEAM_TASK_DELIVERY_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: 'team', TEAM_TASK_STEP_DELIVERY_V1: 'on', TEAM_TASK_PLAN_DRAFT_V1: 'on' }
    expect(teamStepExecutionEnabled(resolveTeamCollaborationConfig(base), 'team')).toBe(false)
    const enabled = resolveTeamCollaborationConfig({ ...base, TEAM_TASK_STEP_EXECUTION_V1: 'on' })
    expect(teamStepExecutionEnabled(enabled, 'team')).toBe(true)
    expect(teamStepExecutionEnabled(enabled, 'other')).toBe(false)
    expect(resolveTeamCollaborationConfig({ ...base, TEAM_TASK_STEP_EXECUTION_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: Array(101).fill('team').join(',') }).deliveryTeams).toEqual(['team'])
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_STEP_EXECUTION_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: Array.from({ length: 101 }, (_, i) => `team-${i}`).join(',') })).toThrow('at most 100')
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_STEP_EXECUTION_V1: 'yes' })).toThrow('TEAM_TASK_STEP_EXECUTION_V1')
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_STEP_EXECUTION_V1: 'on', TEAM_TASK_PLAN_DRAFT_V1: 'off' })).toThrow('requires plan draft')
    expect(() => resolveTeamCollaborationConfig({ ...base, TEAM_TASK_STEP_EXECUTION_V1: 'on', TEAM_TASK_STEP_DELIVERY_V1: 'off' })).toThrow('requires plan draft')
  })
  test('trusted evidence is a separate strict opt-in and connector configuration fails closed', () => {
    expect(evidenceConnectors({})).toEqual([])
    expect(() => resolveTeamCollaborationConfig({TEAM_TASK_TRUSTED_EVIDENCE_V1:'yes'})).toThrow('TEAM_TASK_TRUSTED_EVIDENCE_V1')
    expect(() => resolveTeamCollaborationConfig({TEAM_TASK_TRUSTED_EVIDENCE_V1:'on'})).toThrow('requires TEAM_TASK_DELIVERY_V1')
    const connector={id:'ci',team_id:'team',principal_user_id:1,kind:'ci',repository:'owner/repo',checks:['unit'],token_sha256:'a'.repeat(64)}
    expect(evidenceConnectors({TEAM_EVIDENCE_CONNECTORS_JSON:JSON.stringify([connector])})).toEqual([connector])
    for(const value of ['{',{},[connector,connector],[{...connector,id:null}],[{...connector,kind:'agent'}],[{...connector,token_sha256:'raw-secret'}],[{...connector,checks:['unit','unit']}],[{...connector,principal_user_id:0}]]) {
      expect(() => evidenceConnectors({TEAM_EVIDENCE_CONNECTORS_JSON:typeof value==='string'?value:JSON.stringify(value)})).toThrow('invalid TEAM_EVIDENCE_CONNECTORS_JSON')
    }
  })
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
  test('step delivery is a separate default-off allowlisted capability, not execution', () => {
    expect(teamStepDeliveryEnabled(resolveTeamCollaborationConfig({}), 'team-a')).toBe(false)
    expect(() => resolveTeamCollaborationConfig({ TEAM_TASK_STEP_DELIVERY_V1: 'true' })).toThrow('TEAM_TASK_STEP_DELIVERY_V1')
    expect(() => resolveTeamCollaborationConfig({ TEAM_TASK_STEP_DELIVERY_V1: 'on' })).toThrow('requires TEAM_TASK_DELIVERY_V1')
    const config = resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on', TEAM_TASK_DELIVERY_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: 'team-a', TEAM_TASK_STEP_DELIVERY_V1: 'on' })
    expect(teamStepDeliveryEnabled(config, 'team-a')).toBe(true)
    expect(teamStepDeliveryEnabled(config, 'team-b')).toBe(false)
    expect(teamCapabilitySnapshot(config, { memoryExtensionAvailable: false })).toMatchObject({ task_step_delivery_v1: true, autorun: false })
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
  test('defaults accounts to closed and reflects grant and revocation without restarting', async () => {
    const app = Fastify()
    let enabled = false
    const dependencies = {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on', TEAM_AUTORUN: 'on', TEAM_MEMORY_BRIDGE: 'on' }),
      memoryExtensionAvailable: true,
      verifyAccessToken: async () => ({ userId: 7 }),
      isTeamEnabled: async (userId: number) => userId === 7 && enabled,
    }
    registerTeamCapabilityRoutes(app, dependencies)
    const query = () => app.inject({ method: 'GET', url: '/api/team/capabilities', headers: { authorization: 'Bearer valid' } })
    try {
      expect((await query()).json()).toMatchObject({ collaboration: false, autorun: false, memory_bridge: false, writes_enabled: false })
      enabled = true
      expect((await query()).json()).toMatchObject({ collaboration: true, autorun: true, memory_bridge: true, writes_enabled: true })
      enabled = false
      expect((await query()).json()).toMatchObject({ collaboration: false, writes_enabled: false })
    } finally { await app.close() }
  })

  test('requires authentication and reports server-owned flags', async () => {
    const app = Fastify()
    registerTeamCapabilityRoutes(app, {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
      memoryExtensionAvailable: false,
      verifyAccessToken: async token => token === 'valid' ? { userId: 7 } : null,
      isTeamEnabled: async userId => userId === 7,
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
      reads_enabled: true,
      autorun: false,
      memory_bridge: false,
      writes_enabled: true,
    })
    await app.close()
  })
})
