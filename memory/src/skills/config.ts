import type { MemoryMode, WikiProviderBudgetSettings } from '../config.js'
import { SKILL_MAX_CANDIDATE_CHARS, SKILL_MAX_INPUT_CHARS } from './types.js'

export interface SkillConfig {
  mode: MemoryMode
  autoPublishMode: 'off' | 'shadow'
  canaryMode: 'off' | 'shadow'
  maxConcurrency: number
  maxInputChars: number
  maxCandidateChars: number
  providerBudget: WikiProviderBudgetSettings | undefined
}

type Env = Record<string, string | undefined>
function integer(env: Env, name: string, fallback: number, max: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) {
    throw new Error(`${name} must be an integer within 1..${max}`)
  }
  return Number(raw)
}
function mode(env: Env, name: string, enabledAllowed: boolean): MemoryMode {
  const value = env[name]?.trim() || 'off'
  if (value !== 'off' && value !== 'shadow' && !(enabledAllowed && value === 'enabled')) {
    throw new Error(`${name} must be ${enabledAllowed ? 'off|shadow|enabled' : 'off|shadow (product gate deferred)'}`)
  }
  return value as MemoryMode
}

export function loadSkillConfig(env: Env): SkillConfig {
  const skillMode = mode(env, 'MEMORY_SKILL_MODE', true)
  const bounds = ['MEMORY_SKILL_MAX_CONCURRENCY', 'MEMORY_SKILL_MAX_INPUT_CHARS', 'MEMORY_SKILL_MAX_CANDIDATE_CHARS']
  if (env.NODE_ENV === 'production' && skillMode !== 'off') {
    for (const name of bounds) if (!env[name]) throw new Error(`${name} is required when Skill is active in production`)
  }
  const names = [
    'MEMORY_SKILL_PROVIDER_BUDGET_KEY', 'MEMORY_SKILL_TEXT_REQUEST_LIMIT',
    'MEMORY_SKILL_TEXT_INPUT_TOKEN_LIMIT', 'MEMORY_SKILL_TEXT_OUTPUT_TOKEN_LIMIT',
    'MEMORY_SKILL_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST',
  ]
  let providerBudget: WikiProviderBudgetSettings | undefined
  if (names.some(name => env[name] !== undefined && env[name] !== '')) {
    for (const name of names) if (!env[name]) throw new Error(`${name} is required when Skill provider budget is configured`)
    const key = env.MEMORY_SKILL_PROVIDER_BUDGET_KEY!
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) {
      throw new Error('MEMORY_SKILL_PROVIDER_BUDGET_KEY must be a bounded identifier')
    }
    if (key === env.MEMORY_PROVIDER_BUDGET_KEY || key === env.MEMORY_WIKI_PROVIDER_BUDGET_KEY) {
      throw new Error('MEMORY_SKILL_PROVIDER_BUDGET_KEY must be independent of other workloads')
    }
    providerBudget = {
      key,
      textRequestLimit: integer(env, 'MEMORY_SKILL_TEXT_REQUEST_LIMIT', 0, 1_000_000),
      textInputTokenLimit: integer(env, 'MEMORY_SKILL_TEXT_INPUT_TOKEN_LIMIT', 0, 1_000_000_000),
      textOutputTokenLimit: integer(env, 'MEMORY_SKILL_TEXT_OUTPUT_TOKEN_LIMIT', 0, 1_000_000_000),
      textMaxOutputTokensPerRequest: integer(env, 'MEMORY_SKILL_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST', 0, 1_000_000),
    }
    if (providerBudget.textMaxOutputTokensPerRequest > providerBudget.textOutputTokenLimit) {
      throw new Error('MEMORY_SKILL_TEXT_MAX_OUTPUT_TOKENS_PER_REQUEST must not exceed MEMORY_SKILL_TEXT_OUTPUT_TOKEN_LIMIT')
    }
  }
  return {
    mode: skillMode,
    autoPublishMode: mode(env, 'MEMORY_SKILL_AUTO_PUBLISH_MODE', false) as 'off' | 'shadow',
    canaryMode: mode(env, 'MEMORY_SKILL_CANARY_MODE', false) as 'off' | 'shadow',
    maxConcurrency: integer(env, 'MEMORY_SKILL_MAX_CONCURRENCY', 1, 1),
    maxInputChars: integer(env, 'MEMORY_SKILL_MAX_INPUT_CHARS', SKILL_MAX_INPUT_CHARS, SKILL_MAX_INPUT_CHARS),
    maxCandidateChars: integer(env, 'MEMORY_SKILL_MAX_CANDIDATE_CHARS', SKILL_MAX_CANDIDATE_CHARS, SKILL_MAX_CANDIDATE_CHARS),
    providerBudget,
  }
}

export function skillModeForScope(
  globalMode: MemoryMode, skillMode: MemoryMode, sharedMode: MemoryMode,
  ownerKind: 'personal' | 'team' | 'organization',
): MemoryMode {
  const ranks: Record<MemoryMode, number> = { off: 0, shadow: 1, enabled: 2 }
  const modes = ownerKind === 'personal' ? [globalMode, skillMode] : [globalMode, skillMode, sharedMode]
  return modes.reduce((strictest, current) => ranks[current] < ranks[strictest] ? current : strictest)
}
