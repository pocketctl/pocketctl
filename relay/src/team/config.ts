import type { FastifyInstance } from 'fastify'

import { TEAM_CONTRACT_VERSION } from './types.js'

export type TeamFeatureFlag = 'off' | 'on'

export interface TeamCollaborationConfig {
  agentConfig?: TeamFeatureFlag
  discussionsV2?: TeamFeatureFlag
  privateInteractions?: TeamFeatureFlag
  collaboration: TeamFeatureFlag
  autorun: TeamFeatureFlag
  memoryBridge: TeamFeatureFlag
}

export interface TeamCapabilitySnapshot {
  reads_enabled?:boolean
  schema_version: 1
  contract_version: typeof TEAM_CONTRACT_VERSION
  collaboration: boolean
  autorun: boolean
  memory_bridge: boolean
  writes_enabled: boolean
  agent_config_v2?:boolean
  discussions_v2?:boolean
  private_interactions_v2?:boolean
}

function strictFlag(
  env: Record<string, string | undefined>,
  name: 'TEAM_COLLABORATION' | 'TEAM_AUTORUN' | 'TEAM_MEMORY_BRIDGE' | 'TEAM_AGENT_CONFIG_V2' | 'TEAM_DISCUSSIONS_V2' | 'TEAM_PRIVATE_INTERACTIONS_V2',
): TeamFeatureFlag {
  const value = env[name]?.trim() || 'off'
  if (value !== 'off' && value !== 'on') {
    throw new Error(`${name} must be "off" or "on"`)
  }
  return value
}

export function resolveTeamCollaborationConfig(
  env: Record<string, string | undefined> = process.env,
): TeamCollaborationConfig {
  const config: TeamCollaborationConfig = {
    ...(env.TEAM_AGENT_CONFIG_V2!==undefined ? {agentConfig:strictFlag(env,'TEAM_AGENT_CONFIG_V2')} : {}),
    ...(env.TEAM_DISCUSSIONS_V2!==undefined ? {discussionsV2:strictFlag(env,'TEAM_DISCUSSIONS_V2')} : {}),
    ...(env.TEAM_PRIVATE_INTERACTIONS_V2!==undefined ? {privateInteractions:strictFlag(env,'TEAM_PRIVATE_INTERACTIONS_V2')} : {}),
    collaboration: strictFlag(env, 'TEAM_COLLABORATION'),
    autorun: strictFlag(env, 'TEAM_AUTORUN'),
    memoryBridge: strictFlag(env, 'TEAM_MEMORY_BRIDGE'),
  }
  if (config.collaboration === 'off' && config.autorun === 'on') {
    throw new Error('TEAM_AUTORUN=on requires TEAM_COLLABORATION=on')
  }
  if (config.collaboration === 'off' && config.memoryBridge === 'on') {
    throw new Error('TEAM_MEMORY_BRIDGE=on requires TEAM_COLLABORATION=on')
  }
  return config
}

export function teamCapabilitySnapshot(
  config: TeamCollaborationConfig,
  dependencies: { memoryExtensionAvailable: boolean },
): TeamCapabilitySnapshot {
  const collaboration = config.collaboration === 'on'
  return {
    schema_version: 1,
    contract_version: TEAM_CONTRACT_VERSION,
    collaboration,
    autorun: collaboration && config.autorun === 'on',
    memory_bridge: collaboration
      && config.memoryBridge === 'on'
      && dependencies.memoryExtensionAvailable,
    writes_enabled: collaboration,
    ...(config.agentConfig ? {agent_config_v2:collaboration&&config.agentConfig==='on'} : {}),
    ...(config.discussionsV2 ? {discussions_v2:collaboration&&config.autorun==='on'&&config.discussionsV2==='on'} : {}),
    ...(config.privateInteractions ? {private_interactions_v2:collaboration&&config.privateInteractions==='on'} : {}),
  }
}

interface CapabilityRouteDependencies {
  config: TeamCollaborationConfig
  memoryExtensionAvailable: boolean
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
  isTeamEnabled(userId: number): Promise<boolean>
}

export function registerTeamCapabilityRoutes(
  app: FastifyInstance,
  dependencies: CapabilityRouteDependencies,
): void {
  app.get('/api/team/capabilities', async (request, reply) => {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) {
      reply.code(401)
      return { error: { code: 'authorization_required', message: 'Authorization required', retryable: false } }
    }
    const token = authorization.slice('Bearer '.length).trim()
    const actor = token ? await dependencies.verifyAccessToken(token) : null
    if (!actor) {
      reply.code(401)
      return { error: { code: 'invalid_token', message: 'Invalid token', retryable: false } }
    }
    reply.header('Cache-Control', 'no-store')
    const enabled = await dependencies.isTeamEnabled(actor.userId)
    return {...teamCapabilitySnapshot(enabled ? dependencies.config : { collaboration: 'off', autorun: 'off', memoryBridge: 'off' }, {memoryExtensionAvailable:dependencies.memoryExtensionAvailable}),reads_enabled:enabled}
  })
}
