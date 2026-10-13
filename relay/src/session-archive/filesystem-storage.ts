import { constants, mkdirSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { open, mkdir, lstat, link, unlink, readdir, statfs, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, resolve, dirname, basename } from 'node:path'
import { assertArchiveObjectKey, readArchiveObject, type ArchiveStorage } from './storage.js'

/** A private service-owned directory, never a Web/static upload directory.
 * Database manifests and the existing deletion journal remain authoritative. */
export class FilesystemArchiveStorage implements ArchiveStorage {
  readonly namespace: string
  private readonly root: string
  constructor(root: string, private readonly maximum: number, private readonly minimumFreeBytes = 256 * 1024 * 1024) {
    if (!isAbsolute(root) || resolve(root) === parse(root).root || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 * 1024 * 1024)
      throw new Error('invalid archive directory configuration')
    if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error('invalid archive free space limit')
    this.root = resolve(root)
    let parent = parse(this.root).root
    for (const part of this.root.slice(parent.length).split('/')) {
      parent = join(parent, part)
      try { lstatSync(parent) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try { mkdirSync(parent, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const fd = openSync(dirname(parent), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { fsyncSync(fd) } finally { closeSync(fd) }
      }
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid archive directory')
    }
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.root) !== this.root || (stat.mode & 0o077) !== 0)
      throw new Error('archive directory must be private and non-symlinked')
    this.namespace = createHash('sha256').update(JSON.stringify(['filesystem-v1', this.root])).digest('hex')
  }

  private async file(key: string, create: boolean): Promise<string> {
    assertArchiveObjectKey(key)
    const root = await lstat(this.root)
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || await realpath(this.root) !== this.root)
      throw new Error('invalid archive directory')
    let parent = this.root
    // Check every generated component before use, including delete/read paths.
    for (const part of key.split('/').slice(0, -1)) {
      parent = join(parent, part)
      let created = false
      if (create) {
        try { await mkdir(parent, { mode: 0o700 }); created = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      const stat = await lstat(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('invalid archive directory')
      if (created) await this.syncDirectory(dirname(parent))
    }
    return join(this.root, key)
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    assertArchiveObjectKey(key)
    if (!bytes.length || bytes.length > this.maximum) throw new Error('archive object byte limit exceeded')
    const file = await this.file(key, true), temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
    const space = await statfs(this.root, { bigint: true })
    if (space.bavail * space.bsize < BigInt(bytes.length) + BigInt(this.minimumFreeBytes)) throw new Error('insufficient archive disk space')
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try {
        // link publishes the complete fsynced inode atomically without replacing
        // an existing identity, even when different worker processes race.
        await link(temporary, file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readArchiveObject(this, key, this.maximum)
        if (!createHash('sha256').update(existing).digest().equals(createHash('sha256').update(bytes).digest()))
          throw new Error('archive object immutable identity conflict')
      }
      await this.syncDirectory(dirname(file))
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  }

  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    const file = await this.file(key, false)
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > this.maximum || (stat.mode & 0o077) !== 0) throw new Error('invalid archive object or byte limit exceeded')
    } catch (error) { await handle.close(); throw error }
    const maximum = this.maximum
    return (async function* () {
      const stream = handle.createReadStream({ autoClose: false })
      let size = 0
      try {
        for await (const chunk of stream) {
          size += chunk.length
          if (size > maximum) throw new Error('archive object byte limit exceeded')
          yield chunk
        }
      } finally { stream.destroy(); await handle.close() }
    })()
  }

  async delete(key: string): Promise<void> {
    assertArchiveObjectKey(key)
    try {
      const file = await this.file(key, false)
      const stat = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined })
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid archive object')
        await unlink(file)
      }
      // PUT keys are journalled before filesystem writes. An interrupted PUT
      // may leave only a temporary inode; its durable GC job must collect it.
      for (const name of await readdir(dirname(file))) {
        if (!name.startsWith(`.${basename(file)}.`) || !/^\.\d+\.gz\.[a-f0-9-]{36}\.tmp$/.test(name)) continue
        const temporary = join(dirname(file), name), staged = await lstat(temporary)
        if (!staged.isFile() || staged.isSymbolicLink()) throw new Error('invalid archive temporary object')
        await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      }
      await this.syncDirectory(dirname(file))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
