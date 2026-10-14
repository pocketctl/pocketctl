import { chmodSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import ts from 'typescript'
import { releaseFixture } from './session-lifecycle-release-fixture.js'

describe('atomic filesystem lifecycle configuration script', () => {
  const relay = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const script = join(relay, '..', 'scripts', 'configure-session-lifecycle-filesystem.mjs')
  let compiledRelay: string
  let directory: string, envFile: string, releaseFile: string, archive: string, backups: string
  const original = '# preserve existing configuration\nJWT_SECRET=fixture-secret-never-echo\nCUSTOM_VALUE=literal-$()-`text`\nSESSION_LIFECYCLE_MODE=off\n'
  beforeAll(() => {
    // CI tests before building. Compile the actual imported modules into an
    // isolated fixture so this test cannot depend on stale repository dist.
    compiledRelay = realpathSync(mkdtempSync(join(tmpdir(), 'pocketctl-configure-lifecycle-modules-')))
    writeFileSync(join(compiledRelay, 'package.json'), '{"type":"module"}')
    for (const module of ['session-archive/filesystem-storage', 'session-archive/storage', 'session-lifecycle/release', 'session-lifecycle/time']) {
      const output = join(compiledRelay, 'dist', module + '.js')
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, ts.transpileModule(readFileSync(join(relay, 'src', module + '.ts'), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText)
    }
  })
  afterAll(() => { if (compiledRelay) rmSync(compiledRelay, { recursive: true, force: true }) })
  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'pocketctl-configure-lifecycle-test-')))
    envFile = join(directory, 'relay.env'); releaseFile = join(directory, 'config', 'release.json')
    archive = join(directory, 'archive'); backups = join(directory, 'backups')
    mkdirSync(archive, { mode: 0o700 }); writeFileSync(envFile, original, { mode: 0o600 })
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  function run(apply = true) {
    return spawnSync(process.execPath, [script, '--relay-root', compiledRelay, '--env-file', envFile, '--release-file', releaseFile,
      '--archive-dir', archive, '--backup-dir', backups, '--service-user', userInfo().username, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' })
  }
  test('preserves secrets and kill switch while preparing real storage and an unpublished release record', () => {
    const result = run()
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    const content = readFileSync(envFile, 'utf8')
    expect(content).toContain(original)
    expect(content).toContain('SESSION_LIFECYCLE_STORAGE_DRIVER=filesystem\n')
    expect(content).toContain(`SESSION_LIFECYCLE_OBJECT_DIRECTORY=${archive}\n`)
    expect(content).toContain(`SESSION_LIFECYCLE_RELEASE_FILE=${releaseFile}\n`)
    const release = JSON.parse(readFileSync(releaseFile, 'utf8'))
    expect(release).toMatchObject({ policyVersion: 'session-lifecycle-v1', publishedAt: null, effectiveAt: null, transitionDeadline: null, evidence: {} })
    expect(release.storageNamespace).toBe(createHash('sha256').update(JSON.stringify(['filesystem-v1', archive])).digest('hex'))
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
    expect(statSync(releaseFile).mode & 0o777).toBe(0o640)
    expect(readFileSync(join(backups, readdirSync(backups)[0]), 'utf8')).toBe(original)
    expect(result.stdout).not.toContain('fixture-secret-never-echo')
  })
  test('repeat configuration preserves a published record byte-for-byte and does not create redundant backups', () => {
    expect(run().status).toBe(0)
    const namespace = JSON.parse(readFileSync(releaseFile, 'utf8')).storageNamespace
    const published = JSON.stringify(releaseFixture(namespace), null, 2) + '\n'
    writeFileSync(releaseFile, published)
    const before = readFileSync(envFile, 'utf8'), count = readdirSync(backups).length
    expect(run().status).toBe(0)
    expect(readFileSync(envFile, 'utf8')).toBe(before)
    expect(readFileSync(releaseFile, 'utf8')).toBe(published)
    expect(readdirSync(backups).length).toBe(count)
  })
  test('preview makes no file changes or fake publication', () => {
    const result = run(false)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: false, mode: 'off' })
    expect(readFileSync(envFile, 'utf8')).toBe(original)
    expect(existsSync(releaseFile)).toBe(false)
    expect(existsSync(backups)).toBe(false)
  })
  test('existing S3 settings require a deliberate migration instead of silent replacement', () => {
    const before = original + 'SESSION_LIFECYCLE_OBJECT_BUCKET=existing-private-bucket\n'
    writeFileSync(envFile, before)
    const result = run()
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'existing_object_storage_requires_migration' })
    expect(readFileSync(envFile, 'utf8')).toBe(before)
    expect(existsSync(releaseFile)).toBe(false)
  })
  test('invalid release files fail before changing the environment and do not expose contents', () => {
    mkdirSync(dirname(releaseFile), { mode: 0o750 })
    writeFileSync(releaseFile, '{private-secret-record', { mode: 0o640 })
    const result = run()
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'invalid session lifecycle release file' })
    expect(readFileSync(envFile, 'utf8')).toBe(original)
    expect(result.stdout + result.stderr).not.toContain('private-secret-record')
  })
})
