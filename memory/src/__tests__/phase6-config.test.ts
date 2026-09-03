import { describe, expect, it } from 'vitest'
import { loadMemoryConfig } from '../config.js'
import { loadGitSyncConfig, gitSyncModeForScope, gitWriteModeForScope } from '../git-sync/config.js'

describe('Phase 6 closed configuration', () => {
  it('always initializes production configuration with sync and write off', () => {
    const config = loadMemoryConfig({})
    expect(config.gitSync).toMatchObject({ mode: 'off', writeMode: 'off', maxConcurrency: 1, requestTimeoutMs: 15000,
      pollIntervalMs: 60000, maxHttpAttempts: 128, maxFailures: 5, maxTaskAgeMs: 86400000 })
  })
  it('refuses write enabled even if global sync is off', () => {
    expect(() => loadMemoryConfig({ MEMORY_GIT_WRITE_MODE: 'enabled' })).toThrow('MEMORY_GIT_WRITE_MODE')
  })
  it.each(['', 'invalid', 'ENABLED'])('rejects explicit invalid modes %s', value => {
    expect(() => loadGitSyncConfig({ MEMORY_GIT_SYNC_MODE: value })).toThrow('MEMORY_GIT_SYNC_MODE')
  })
  it.each([
    ['MEMORY_GIT_MAX_CONCURRENCY', '2'], ['MEMORY_GIT_REQUEST_TIMEOUT_MS', '15001'],
    ['MEMORY_GIT_POLL_INTERVAL_MS', '59999'], ['MEMORY_GIT_MAX_HTTP_ATTEMPTS', '129'],
    ['MEMORY_GIT_MAX_FAILURES', '6'], ['MEMORY_GIT_MAX_TASK_AGE_MS', '86400001'],
    ['MEMORY_GIT_MAX_FILES', '257'], ['MEMORY_GIT_MAX_FILE_BYTES', '262145'], ['MEMORY_GIT_MAX_TOTAL_BYTES', '8388609'],
    ['MEMORY_GIT_MAX_HTTP_ATTEMPTS', '1.5'], ['MEMORY_GIT_MAX_HTTP_ATTEMPTS', ''], ['MEMORY_GIT_MAX_FILES', '0'],
  ])('refuses invalid or excessive %s', (name, value) => expect(() => loadGitSyncConfig({ [name]: value })).toThrow(name))
  it('uses the intersection of global, feature, connection, scope and shared modes', () => {
    const context = { globalMode: 'enabled', syncMode: 'enabled', connectionMode: 'enabled',
      scopeMode: 'enabled', sharedMode: 'enabled', ownerScopeKind: 'team', installationActive: true } as const
    expect(gitSyncModeForScope(context)).toBe('enabled')
    for (const field of ['globalMode', 'syncMode', 'connectionMode', 'scopeMode', 'sharedMode'] as const) {
      expect(gitSyncModeForScope({ ...context, [field]: 'off' })).toBe('off')
      expect(gitSyncModeForScope({ ...context, [field]: 'shadow' })).toBe('shadow')
    }
    expect(gitSyncModeForScope({ ...context, installationActive: false })).toBe('off')
    expect(gitSyncModeForScope({ ...context, ownerScopeKind: 'personal', sharedMode: 'off' })).toBe('enabled')
    expect(gitWriteModeForScope('shadow', 'shadow', 'enabled')).toBe('shadow')
    expect(gitWriteModeForScope('shadow', 'shadow', 'off')).toBe('off')
    expect(() => gitWriteModeForScope('enabled' as any, 'shadow', 'enabled')).toThrow()
  })
})
