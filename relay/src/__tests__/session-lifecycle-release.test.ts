import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { releaseFixture } from './session-lifecycle-release-fixture.js'

describe('versioned release-file configuration', () => {
  let directory: string, file: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pocketctl-release-config-')); file = join(directory, 'release.json') })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  const load = () => sessionLifecycleConfig({ SESSION_LIFECYCLE_RELEASE_FILE: file })
  test('policy dates come from the published release when not separately configured', () => {
    writeFileSync(file, JSON.stringify(releaseFixture('namespace')), { mode: 0o600 })
    expect(load()).toMatchObject({ effectiveAt: '2026-01-01T00:00:00Z', transitionDeadline: '2026-02-01T00:00:00Z' })
  })
  test.each(['{', JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ schemaVersion: 1, effectiveAt: 'tomorrow' }), 'x'.repeat(65_537)])
    ('malformed, unsupported and oversized release records fail without leaking contents', content => {
      writeFileSync(file, content, { mode: 0o600 })
      expect(load).toThrow('invalid session lifecycle release file')
    })
  test('missing, relative and writable release files cannot attest production readiness', () => {
    expect(load).toThrow('invalid session lifecycle release file')
    expect(() => sessionLifecycleConfig({ SESSION_LIFECYCLE_RELEASE_FILE: 'relative.json' })).toThrow('invalid session lifecycle release file')
    writeFileSync(file, JSON.stringify(releaseFixture('namespace')), { mode: 0o600 })
    chmodSync(file, 0o666)
    expect(load).toThrow('invalid session lifecycle release file')
  })
})
