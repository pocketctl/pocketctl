import { mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { releaseFixture } from './session-lifecycle-release-fixture.js'

describe('deployment lifecycle preflight CLI', () => {
  let directory: string, env: NodeJS.ProcessEnv
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'session-lifecycle-preflight-main.ts')
  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'pocketctl-lifecycle-preflight-')))
    env = { PATH: process.env.PATH, NODE_ENV: 'production', SESSION_LIFECYCLE_STORAGE_DRIVER: 'filesystem', SESSION_LIFECYCLE_OBJECT_DIRECTORY: join(directory, 'archive') }
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  function run(...args: string[]) { return spawnSync(process.execPath, ['--import', 'tsx', main, ...args], { env, encoding: 'utf8' }) }
  test('activation preflight fails with all blockers instead of a successful enabled-only result', () => {
    const result = run('--require-execution')
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ execution_ready: false, blockers: ['policy_not_effective', 'historical_transition_not_configured', 'production_release_not_ready'] })
  })
  test('storage preparation can pass while unpublished policy remains blocked', () => {
    const result = run('--require-storage', '--probe-storage')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ storage_probe: 'passed', execution_ready: false, deployment_ready: false })
    delete env.SESSION_LIFECYCLE_OBJECT_DIRECTORY
    const missing = run('--require-storage')
    expect(missing.status).toBe(2)
    expect(JSON.parse(missing.stdout).blockers).toContain('object_reader_not_configured')
  })
  test('a complete release passes actual disk put/read/delete without leaving a probe object', () => {
    const namespace = createHash('sha256').update(JSON.stringify(['filesystem-v1', env.SESSION_LIFECYCLE_OBJECT_DIRECTORY])).digest('hex')
    const file = join(directory, 'release.json')
    writeFileSync(file, JSON.stringify(releaseFixture(namespace)), { mode: 0o600 })
    env.SESSION_LIFECYCLE_RELEASE_FILE = file
    const result = run('--require-execution', '--probe-storage')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({ execution_ready: true, production_release_ready: true, storage_probe: 'passed', storage_driver: 'filesystem' })
    const files = readdirSync(join(directory, 'archive'), { recursive: true })
    expect(files.some(file => String(file).endsWith('.gz') || String(file).endsWith('.tmp'))).toBe(false)
  })
  test('invalid private configuration yields a safe nonzero diagnostic', () => {
    env.SESSION_LIFECYCLE_RELEASE_FILE = join(directory, 'nonexistent-secret-location.json')
    const result = run('--require-execution')
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'invalid session lifecycle release file' })
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('nonexistent-secret-location')
  })
  test('a published future-effective release may be deployed while execution remains blocked', () => {
    const namespace = createHash('sha256').update(JSON.stringify(['filesystem-v1', env.SESSION_LIFECYCLE_OBJECT_DIRECTORY])).digest('hex')
    const file = join(directory, 'release.json')
    writeFileSync(file, JSON.stringify(releaseFixture(namespace, { effectiveAt: '2099-01-01T00:00:00Z', transitionDeadline: '2099-02-01T00:00:00Z' })), { mode: 0o600 })
    env.SESSION_LIFECYCLE_RELEASE_FILE = file
    const scheduled = run('--require-release')
    expect(scheduled.status).toBe(0)
    expect(JSON.parse(scheduled.stdout)).toMatchObject({ execution_ready: false, blockers: ['policy_not_effective'], release_blockers: [] })
    expect(run('--require-execution').status).toBe(2)
  })
})
