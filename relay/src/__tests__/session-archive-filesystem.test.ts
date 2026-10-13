import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, realpathSync, mkdirSync, symlinkSync, readFileSync, statSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { installConfiguredHistoryReader, configuredArchiveStorage } from '../session-history/runtime.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { archiveObjectKey, readArchiveObject, type ArchiveStorage } from '../session-archive/storage.js'

describe('confined persistent filesystem archive storage', () => {
  let directory: string
  beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'pocketctl-archive-files-test-'))) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  function install(root = join(directory, 'archive'), overrides: Record<string, string> = {}): ArchiveStorage {
    const db = { query: async () => { throw new Error('installation must not access the database') } }
    const env = { NODE_ENV: 'production', SESSION_LIFECYCLE_STORAGE_DRIVER: 'filesystem', SESSION_LIFECYCLE_OBJECT_DIRECTORY: root, ...overrides }
    expect(installConfiguredHistoryReader(db, sessionLifecycleConfig(env), env)).toBe(true)
    return configuredArchiveStorage(db)!
  }
  test('compressed bodies survive adapter restart and immutable retries; files remain private', async () => {
    const storage = install(), key = archiveObjectKey(randomUUID(), 0), bytes = Buffer.from('exact compressed body\0中文')
    await storage.put(key, bytes)
    await storage.put(key, bytes)
    const restored = install()
    expect(restored.namespace).toBe(storage.namespace)
    expect(await readArchiveObject(restored, key, 1_000_000)).toEqual(bytes)
    expect(statSync(join(directory, 'archive', key)).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, 'archive')).mode & 0o077).toBe(0)
    await expect(storage.put(key, Buffer.from('different'))).rejects.toThrow('identity conflict')
    expect(await readArchiveObject(restored, key, 1_000_000)).toEqual(bytes)
    await storage.delete(key)
    await storage.delete(key)
    await expect(storage.read(key)).rejects.toThrow()
  })
  test('concurrent writes publish one complete immutable body', async () => {
    const storage = install(), key = archiveObjectKey(randomUUID(), 1), bytes = Buffer.alloc(500_000, 0x47)
    await Promise.all(Array.from({ length: 8 }, () => storage.put(key, bytes)))
    expect(await readArchiveObject(storage, key, 600_000)).toEqual(bytes)
  })
  test('object paths and symlinked manifest directories cannot escape the root', async () => {
    const storage = install(), id = randomUUID(), key = archiveObjectKey(id, 0), outside = join(directory, 'outside')
    mkdirSync(outside)
    mkdirSync(join(directory, 'archive', 'session-archive', 'v1'), { recursive: true })
    symlinkSync(outside, join(directory, 'archive', 'session-archive', 'v1', id))
    await expect(storage.put(key, Buffer.from('escape'))).rejects.toThrow()
    await expect(storage.read(key)).rejects.toThrow()
    await expect(storage.delete(key)).rejects.toThrow()
    await expect(storage.put('../outside/escape', Buffer.from('escape'))).rejects.toThrow('key')
    await expect(storage.read('https://external.invalid/file')).rejects.toThrow('key')
    expect(() => readFileSync(join(outside, '0.gz'))).toThrow()
  })
  test('reads and deletes refuse symlinked object files without touching their targets', async () => {
    const storage = install(), key = archiveObjectKey(randomUUID(), 0), outside = join(directory, 'private-other-file')
    await storage.put(key, Buffer.from('original'))
    writeFileSync(outside, 'untouched')
    rmSync(join(directory, 'archive', key))
    symlinkSync(outside, join(directory, 'archive', key))
    await expect(storage.read(key)).rejects.toThrow()
    await expect(storage.delete(key)).rejects.toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
  })
  test('absolute, dedicated non-symlink roots and bounded objects are required', async () => {
    expect(() => install('relative/archive')).toThrow()
    expect(() => install('/')).toThrow()
    const target = join(directory, 'target'), alias = join(directory, 'alias')
    mkdirSync(target)
    symlinkSync(target, alias)
    expect(() => install(alias)).toThrow()
    const storage = install(), key = archiveObjectKey(randomUUID(), 0)
    await expect(storage.put(key, Buffer.alloc(0))).rejects.toThrow('limit')
    await expect(storage.put(key, Buffer.alloc(8 * 1024 * 1024 + 1))).rejects.toThrow('limit')
  })
  test('a replaced root cannot redirect later operations into another directory', async () => {
    const root = join(directory, 'archive'), storage = install(root), outside = join(directory, 'outside')
    mkdirSync(outside)
    renameSync(root, join(directory, 'original-root'))
    symlinkSync(outside, root)
    await expect(storage.put(archiveObjectKey(randomUUID(), 0), Buffer.from('escape'))).rejects.toThrow('directory')
    expect(existsSync(join(outside, 'session-archive'))).toBe(false)
  })
  test('symlinked root ancestors are rejected before creating any external directory', () => {
    const outside = join(directory, 'outside'), alias = join(directory, 'alias')
    mkdirSync(outside)
    symlinkSync(outside, alias)
    expect(() => install(join(alias, 'archive'))).toThrow('directory')
    expect(existsSync(join(outside, 'archive'))).toBe(false)
  })
  test('durable deletion also removes unpublished temporary files for that object identity', async () => {
    const storage = install(), key = archiveObjectKey(randomUUID(), 0)
    await storage.put(key, Buffer.from('original'))
    const file = join(directory, 'archive', key), temporary = file.replace('/0.gz', `/.0.gz.${randomUUID()}.tmp`)
    writeFileSync(temporary, 'interrupted publication', { mode: 0o600 })
    rmSync(file)
    await storage.delete(key)
    expect(existsSync(temporary)).toBe(false)
  })
  test('insufficient free disk space fails before creating a cold object', async () => {
    const storage = install(join(directory, 'archive'), { SESSION_LIFECYCLE_FILESYSTEM_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) })
    const key = archiveObjectKey(randomUUID(), 0)
    await expect(storage.put(key, Buffer.from('bounded body'))).rejects.toThrow('space')
    expect(existsSync(join(directory, 'archive', key))).toBe(false)
  })
})
