import { GIT_INPUT_LIMITS } from './paths.js'

export type GitSyncMode = 'off' | 'shadow' | 'enabled'
export type GitWriteMode = 'off' | 'shadow'
export interface GitSyncConfig {
  mode: GitSyncMode; writeMode: GitWriteMode; maxConcurrency: number; requestTimeoutMs: number; pollIntervalMs: number
  maxHttpAttempts: number; maxFailures: number; maxTaskAgeMs: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number
}
function mode<T extends string>(name: string, value: string | undefined, choices: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (!(choices as readonly string[]).includes(value)) throw new Error(`${name} has an invalid mode`)
  return value as T
}
export function loadGitSyncConfig(env: Record<string, string | undefined> = process.env): GitSyncConfig {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name]
    if (value === undefined) return fallback
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`)
    }
    return Number(value)
  }
  return {
    mode: mode('MEMORY_GIT_SYNC_MODE', env.MEMORY_GIT_SYNC_MODE, ['off', 'shadow', 'enabled'], 'off'),
    writeMode: mode('MEMORY_GIT_WRITE_MODE', env.MEMORY_GIT_WRITE_MODE, ['off', 'shadow'], 'off'),
    maxConcurrency: integer('MEMORY_GIT_MAX_CONCURRENCY', 1, 1, 1),
    requestTimeoutMs: integer('MEMORY_GIT_REQUEST_TIMEOUT_MS', 15_000, 1, 15_000),
    pollIntervalMs: integer('MEMORY_GIT_POLL_INTERVAL_MS', 60_000, 60_000, 86_400_000),
    maxHttpAttempts: integer('MEMORY_GIT_MAX_HTTP_ATTEMPTS', 128, 1, 128),
    maxFailures: integer('MEMORY_GIT_MAX_FAILURES', 5, 1, 5),
    maxTaskAgeMs: integer('MEMORY_GIT_MAX_TASK_AGE_MS', 86_400_000, 1, 86_400_000),
    maxFiles: integer('MEMORY_GIT_MAX_FILES', GIT_INPUT_LIMITS.maxFiles, 1, GIT_INPUT_LIMITS.maxFiles),
    maxFileBytes: integer('MEMORY_GIT_MAX_FILE_BYTES', GIT_INPUT_LIMITS.maxFileBytes, 1, GIT_INPUT_LIMITS.maxFileBytes),
    maxTotalBytes: integer('MEMORY_GIT_MAX_TOTAL_BYTES', GIT_INPUT_LIMITS.maxTotalBytes, 1, GIT_INPUT_LIMITS.maxTotalBytes),
  }
}
export interface GitModeContext {
  globalMode: GitSyncMode; syncMode: GitSyncMode; connectionMode: GitSyncMode; scopeMode: GitSyncMode
  sharedMode: GitSyncMode; ownerScopeKind: 'personal' | 'team' | 'organization'; installationActive: boolean
}
export function gitSyncModeForScope(context: GitModeContext): GitSyncMode {
  const modes = [context.globalMode, context.syncMode, context.connectionMode, context.scopeMode,
    ...(context.ownerScopeKind === 'personal' ? [] : [context.sharedMode])]
  modes.forEach(value => mode('git_sync_context', value, ['off', 'shadow', 'enabled'], 'off'))
  if (!context.installationActive || modes.includes('off')) return 'off'
  return modes.includes('shadow') ? 'shadow' : 'enabled'
}
export function gitWriteModeForScope(global: GitWriteMode, connection: GitWriteMode, sync: GitSyncMode): GitWriteMode {
  mode('git_write_context', global, ['off', 'shadow'], 'off')
  mode('git_write_context', connection, ['off', 'shadow'], 'off')
  mode('git_sync_context', sync, ['off', 'shadow', 'enabled'], 'off')
  return global === 'off' || connection === 'off' || sync === 'off' ? 'off' : 'shadow'
}
