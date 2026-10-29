import type { FastifyInstance } from 'fastify'

import { TEAM_CONTRACT_VERSION } from './types.js'

export type TeamFeatureFlag = 'off' | 'on'

export interface TeamCollaborationConfig {
  externalExecutor?: TeamFeatureFlag
  externalExecutorTeams?: string[]
  taskReadiness?: TeamFeatureFlag
  deliveryMemoryCandidates?: TeamFeatureFlag
  templates?: TeamFeatureFlag
  trustedEvidence?: TeamFeatureFlag
  stepExecution?: TeamFeatureFlag
  stepDelivery?: TeamFeatureFlag
  planDraft?: TeamFeatureFlag
  delivery?: TeamFeatureFlag
  deliveryTeams?: string[]
  agentConfig?: TeamFeatureFlag
  discussionsV2?: TeamFeatureFlag
  privateInteractions?: TeamFeatureFlag
  collaboration: TeamFeatureFlag
  autorun: TeamFeatureFlag
  memoryBridge: TeamFeatureFlag
}

export interface TeamCapabilitySnapshot {
  task_readiness_v1?: boolean
  task_templates_v1?: boolean
  task_step_delivery_v1?: boolean
  task_plan_draft_v1?: boolean
  reads_enabled?:boolean
  schema_version: 1
  contract_version: typeof TEAM_CONTRACT_VERSION
  collaboration: boolean
  autorun: boolean
  memory_bridge: boolean
  writes_enabled: boolean
  task_delivery_v1?: boolean
  agent_config_v2?:boolean
  discussions_v2?:boolean
  private_interactions_v2?:boolean
}

function strictFlag(
  env: Record<string, string | undefined>,
  name: 'TEAM_EXTERNAL_EXECUTOR_V1' | 'TEAM_TASK_READINESS_V1' | 'TEAM_COLLABORATION' | 'TEAM_AUTORUN' | 'TEAM_MEMORY_BRIDGE' | 'TEAM_AGENT_CONFIG_V2' | 'TEAM_DISCUSSIONS_V2' | 'TEAM_PRIVATE_INTERACTIONS_V2' | 'TEAM_TASK_DELIVERY_V1' | 'TEAM_TASK_PLAN_DRAFT_V1' | 'TEAM_TASK_STEP_DELIVERY_V1' | 'TEAM_TASK_STEP_EXECUTION_V1' | 'TEAM_TASK_TRUSTED_EVIDENCE_V1' | 'TEAM_TASK_TEMPLATES_V1' | 'TEAM_TASK_MEMORY_CANDIDATES_V1',
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
    ...(env.TEAM_EXTERNAL_EXECUTOR_V1 !== undefined ? {externalExecutor: strictFlag(env, 'TEAM_EXTERNAL_EXECUTOR_V1'), externalExecutorTeams: [...new Set((env.TEAM_EXTERNAL_EXECUTOR_TEAMS ?? '').split(',').map(s => s.trim()).filter(Boolean))]} : {}),
    ...(env.TEAM_TASK_READINESS_V1 !== undefined ? {taskReadiness:strictFlag(env,'TEAM_TASK_READINESS_V1')} : {}),
    ...(env.TEAM_TASK_MEMORY_CANDIDATES_V1 !== undefined ? { deliveryMemoryCandidates: strictFlag(env, 'TEAM_TASK_MEMORY_CANDIDATES_V1') } : {}),
    ...(env.TEAM_TASK_TEMPLATES_V1 !== undefined ? { templates: strictFlag(env, 'TEAM_TASK_TEMPLATES_V1') } : {}),
    ...(env.TEAM_TASK_TRUSTED_EVIDENCE_V1 !== undefined ? { trustedEvidence: strictFlag(env, 'TEAM_TASK_TRUSTED_EVIDENCE_V1') } : {}),
    ...(env.TEAM_TASK_STEP_EXECUTION_V1 !== undefined ? { stepExecution: strictFlag(env, 'TEAM_TASK_STEP_EXECUTION_V1') } : {}),
    ...(env.TEAM_TASK_STEP_DELIVERY_V1 !== undefined ? { stepDelivery: strictFlag(env, 'TEAM_TASK_STEP_DELIVERY_V1') } : {}),
    ...(env.TEAM_TASK_PLAN_DRAFT_V1 !== undefined ? { planDraft: strictFlag(env, 'TEAM_TASK_PLAN_DRAFT_V1') } : {}),
    ...(env.TEAM_TASK_DELIVERY_V1 !== undefined ? {delivery: strictFlag(env, 'TEAM_TASK_DELIVERY_V1'), deliveryTeams: (env.TEAM_TASK_DELIVERY_TEAMS ?? '').split(',').map(s => s.trim()).filter(Boolean)} : {}),
    ...(env.TEAM_AGENT_CONFIG_V2!==undefined ? {agentConfig:strictFlag(env,'TEAM_AGENT_CONFIG_V2')} : {}),
    ...(env.TEAM_DISCUSSIONS_V2!==undefined ? {discussionsV2:strictFlag(env,'TEAM_DISCUSSIONS_V2')} : {}),
    ...(env.TEAM_PRIVATE_INTERACTIONS_V2!==undefined ? {privateInteractions:strictFlag(env,'TEAM_PRIVATE_INTERACTIONS_V2')} : {}),
    collaboration: strictFlag(env, 'TEAM_COLLABORATION'),
    autorun: strictFlag(env, 'TEAM_AUTORUN'),
    memoryBridge: strictFlag(env, 'TEAM_MEMORY_BRIDGE'),
  }
  if (config.externalExecutor === 'on' && (config.collaboration !== 'on' || config.delivery !== 'on' || !config.externalExecutorTeams?.length || config.externalExecutorTeams.length > 100 || config.externalExecutorTeams.some(id => !config.deliveryTeams?.includes(id)))) throw new Error('TEAM_EXTERNAL_EXECUTOR_V1=on requires task delivery and an explicit subset TEAM_EXTERNAL_EXECUTOR_TEAMS (at most 100)')
  if (config.delivery === 'on' && (config.collaboration !== 'on' || !config.deliveryTeams?.length)) throw new Error('TEAM_TASK_DELIVERY_V1=on requires TEAM_COLLABORATION=on and explicit TEAM_TASK_DELIVERY_TEAMS')
  if (config.deliveryTeams?.some(id => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new Error('invalid TEAM_TASK_DELIVERY_TEAMS')
  if (config.deliveryTeams) config.deliveryTeams = [...new Set(config.deliveryTeams)]
  if (config.stepExecution === 'on' && (config.deliveryTeams?.length ?? 0) > 100) throw new Error('TEAM_TASK_STEP_EXECUTION_V1 supports at most 100 distinct Teams')
  if (config.trustedEvidence === 'on' && config.delivery !== 'on') throw new Error('TEAM_TASK_TRUSTED_EVIDENCE_V1=on requires TEAM_TASK_DELIVERY_V1=on')
  if (config.templates === 'on' && config.planDraft !== 'on') throw new Error('TEAM_TASK_TEMPLATES_V1=on requires plan draft')
  if (config.deliveryMemoryCandidates === 'on' && (config.delivery !== 'on' || config.memoryBridge !== 'on')) throw new Error('TEAM_TASK_MEMORY_CANDIDATES_V1=on requires task delivery and Memory bridge')
  if (config.planDraft === 'on' && config.delivery !== 'on') throw new Error('TEAM_TASK_PLAN_DRAFT_V1=on requires TEAM_TASK_DELIVERY_V1=on')
  if (config.stepExecution === 'on' && (config.stepDelivery !== 'on' || config.planDraft !== 'on')) throw new Error('TEAM_TASK_STEP_EXECUTION_V1=on requires plan draft and step delivery')
  if (config.stepDelivery === 'on' && config.delivery !== 'on') throw new Error('TEAM_TASK_STEP_DELIVERY_V1=on requires TEAM_TASK_DELIVERY_V1=on')
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
    ...(config.taskReadiness ? {task_readiness_v1:collaboration && config.taskReadiness==='on'} : {}),
    ...(config.templates ? {task_templates_v1:collaboration && config.delivery === 'on' && config.planDraft === 'on' && config.templates === 'on'} : {}),
    ...(config.stepDelivery ? { task_step_delivery_v1: collaboration && config.delivery === 'on' && config.stepDelivery === 'on' } : {}),
    ...(config.planDraft ? { task_plan_draft_v1: collaboration && config.delivery === 'on' && config.planDraft === 'on' } : {}),
    ...(config.delivery ? {task_delivery_v1: collaboration && config.delivery === 'on'} : {}),
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

export function teamDeliveryEnabled(config: TeamCollaborationConfig, teamId: string): boolean {
  return config.collaboration === 'on' && config.delivery === 'on' && !!config.deliveryTeams?.includes(teamId)
}

export function teamDeliveryMemoryEnabled(config: TeamCollaborationConfig, teamId: string): boolean {
  return config.deliveryMemoryCandidates === 'on' && config.memoryBridge === 'on' && teamDeliveryEnabled(config, teamId)
}

export function teamPlanDraftEnabled(config: TeamCollaborationConfig, teamId: string): boolean {
  return config.planDraft === 'on' && teamDeliveryEnabled(config, teamId)
}

export function teamStepDeliveryEnabled(config: TeamCollaborationConfig, teamId: string): boolean {
  return config.stepDelivery === 'on' && teamDeliveryEnabled(config, teamId)
}

export function teamStepExecutionEnabled(config: TeamCollaborationConfig, teamId: string): boolean {
  return config.stepExecution === 'on' && teamPlanDraftEnabled(config, teamId) && teamStepDeliveryEnabled(config, teamId)
}

export function teamTemplatesEnabled(config:TeamCollaborationConfig,teamId:string):boolean { return config.templates === 'on' && teamPlanDraftEnabled(config,teamId) }

export function teamExternalExecutorEnabled(config: TeamCollaborationConfig, teamId: string): boolean {
  return teamDeliveryEnabled(config, teamId) && config.externalExecutor === 'on' && Boolean(config.externalExecutorTeams?.includes(teamId))
}
