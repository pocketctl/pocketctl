import type { FastifyInstance } from 'fastify'

import { TEAM_CONTRACT_VERSION } from './types.js'

export type TeamFeatureFlag = 'off' | 'on'

export interface TeamCollaborationConfig {
  collaboration: TeamFeatureFlag
  autorun: TeamFeatureFlag
  memoryBridge: TeamFeatureFlag
}

export interface TeamCapabilitySnapshot {
  schema_version: 1
  contract_version: typeof TEAM_CONTRACT_VERSION
  collaboration: boolean
  autorun: boolean
  memory_bridge: boolean
  writes_enabled: boolean
}

function strictFlag(
  env: Record<string, string | undefined>,
  name: 'TEAM_COLLABORATION' | 'TEAM_AUTORUN' | 'TEAM_MEMORY_BRIDGE',
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
  }
}

interface CapabilityRouteDependencies {
  config: TeamCollaborationConfig
  memoryExtensionAvailable: boolean
  verifyAccessToken(token: string): Promise<{ userId: number } | null>
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
    if (!token || !await dependencies.verifyAccessToken(token)) {
      reply.code(401)
      return { error: { code: 'invalid_token', message: 'Invalid token', retryable: false } }
    }
    return teamCapabilitySnapshot(dependencies.config, {
      memoryExtensionAvailable: dependencies.memoryExtensionAvailable,
    })
  })
}
