import { describe, expect, test } from 'vitest'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'

describe('session lifecycle config', () => {
  test('defaults are versioned and enabled', () => {
    expect(sessionLifecycleConfig({})).toMatchObject({
      mode: 'enforce',
      archiveDays: 60,
      purgeDays: 90,
      policyVersion: 'session-lifecycle-v1',
      notificationRetentionDays: 90,
      scanIntervalMs: 3_600_000,
      continuationDelayMs: 5_000,
      batchSessions: 20,
      transferConcurrency: 1,
    })
  })
  test.each([
    { SESSION_LIFECYCLE_MODE: 'on' },
    { SESSION_LIFECYCLE_ARCHIVE_DAYS: '90' },
    { SESSION_LIFECYCLE_PURGE_DAYS: '60' },
    { SESSION_LIFECYCLE_BATCH_SESSIONS: '20junk' },
    { SESSION_LIFECYCLE_CONTINUATION_DELAY_MS: '0' },
    { SESSION_LIFECYCLE_TRANSFER_CONCURRENCY: '0' },
    { SESSION_LIFECYCLE_MAX_CHUNK_BYTES: '-1' },
    { SESSION_LIFECYCLE_EFFECTIVE_AT: 'tomorrow' },
    { SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-02-30T00:00:00Z' },
    { SESSION_LIFECYCLE_POLICY_VERSION: 'new-policy' },
  ])('rejects malformed or unversioned configuration %j', (env) => {
    expect(() => sessionLifecycleConfig(env)).toThrow()
  })
  test('explicit off/observe/enforce modes remain available', () => {
    for (const mode of ['off', 'observe', 'enforce']) {
      expect(
        sessionLifecycleConfig({ SESSION_LIFECYCLE_MODE: mode }).mode,
      ).toBe(mode)
    }
  })
  test('configuration errors do not expose storage credentials', () => {
    expect(() =>
      sessionLifecycleConfig({ SESSION_LIFECYCLE_MODE: 'secret-value' }),
    ).toThrow('SESSION_LIFECYCLE_MODE must be off, observe or enforce')
  })
})
