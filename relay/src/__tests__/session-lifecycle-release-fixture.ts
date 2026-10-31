import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'

/** Synthetic release evidence only; never publish this as production acceptance. */
export function releaseFixture(storageNamespace: string, patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    policyVersion: 'session-lifecycle-v2',
    publishedAt: '2025-12-01T00:00:00Z',
    effectiveAt: '2026-01-01T00:00:00Z',
    transitionDeadline: '2026-02-01T00:00:00Z',
    storageNamespace,
    evidence: {
      production_provider_and_backup_policy: 'fixture/backup-restore',
      legal_publication: 'https://fixture.invalid/policy',
      production_client_release: 'fixture/client-release',
      capacity_and_fault_acceptance: 'fixture/capacity-and-faults',
    },
    ...patch,
  }
}

export function releasedConfig(storageNamespace: string, patch: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pocketctl-lifecycle-release-test-'))
  const file = join(directory, 'release.json')
  try {
    writeFileSync(file, JSON.stringify(releaseFixture(storageNamespace, patch)), { mode: 0o600 })
    return sessionLifecycleConfig({
      SESSION_LIFECYCLE_EFFECTIVE_AT: '2026-01-01T00:00:00Z',
      SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-02-01T00:00:00Z',
      SESSION_LIFECYCLE_RELEASE_FILE: file,
      ...env,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
