#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// Administrative configuration only: no session scan, job, publication or deletion.
try {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean', default: false },
    'relay-root': { type: 'string' }, 'env-file': { type: 'string' },
    'release-file': { type: 'string' }, 'archive-dir': { type: 'string' },
    'backup-dir': { type: 'string', default: '/var/backups/pocketctl-relay' },
    'service-user': { type: 'string', default: 'pocketctl' },
  } })
  const relay = values['relay-root'] ?? path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'relay')
  const envFile = values['env-file'] ?? path.join(relay, '.env')
  for (const file of [relay, envFile, values['backup-dir']]) if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) throw new Error('invalid_configuration_path')
  const envStat = fs.lstatSync(envFile)
  if (!envStat.isFile() || envStat.isSymbolicLink()) throw new Error('invalid_environment_file')
  const original = fs.readFileSync(envFile, 'utf8'), env = {}
  for (const line of original.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  if (['SESSION_LIFECYCLE_OBJECT_BUCKET', 'SESSION_LIFECYCLE_OBJECT_REGION', 'SESSION_LIFECYCLE_OBJECT_ENDPOINT',
    'SESSION_LIFECYCLE_OBJECT_ACCESS_KEY', 'SESSION_LIFECYCLE_OBJECT_SECRET_KEY'].some(key => env[key])
    || (env.SESSION_LIFECYCLE_OBJECT_LOCAL_TEST && env.SESSION_LIFECYCLE_OBJECT_LOCAL_TEST !== 'off')) throw new Error('existing_object_storage_requires_migration')
  const archive = values['archive-dir'] ?? env.SESSION_LIFECYCLE_OBJECT_DIRECTORY ?? '/var/lib/pocketctl/session-archive'
  const releaseFile = values['release-file'] ?? env.SESSION_LIFECYCLE_RELEASE_FILE ?? '/etc/pocketctl/session-lifecycle-release.json'
  for (const file of [archive, releaseFile]) if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) throw new Error('invalid_configuration_path')
  // Provisioning is done by systemd/install, not by this root process. This
  // prevents accidentally creating a root-owned archive the service cannot use.
  if (!fs.existsSync(archive)) throw new Error('archive_directory_not_provisioned')
  const { FilesystemArchiveStorage } = await import(pathToFileURL(path.join(relay, 'dist/session-archive/filesystem-storage.js')).href)
  const { loadSessionLifecycleRelease } = await import(pathToFileURL(path.join(relay, 'dist/session-lifecycle/release.js')).href)
  const storage = new FilesystemArchiveStorage(archive, 8 * 1024 * 1024)
  const existing = fs.existsSync(releaseFile) ? loadSessionLifecycleRelease(releaseFile) : null
  if (existing?.storageNamespace && existing.storageNamespace !== storage.namespace) throw new Error('release_storage_mismatch')
  const mode = env.SESSION_LIFECYCLE_MODE || 'enforce'
  if (!['off', 'observe', 'enforce'].includes(mode)) throw new Error('invalid_lifecycle_mode')
  const selected = {
    SESSION_LIFECYCLE_STORAGE_DRIVER: 'filesystem', SESSION_LIFECYCLE_OBJECT_DIRECTORY: archive,
    SESSION_LIFECYCLE_RELEASE_FILE: releaseFile,
  }
  if (!env.SESSION_LIFECYCLE_MODE) selected.SESSION_LIFECYCLE_MODE = mode
  const encode = value => /\s|["#]/.test(value) ? JSON.stringify(value) : value
  let updated = original
  for (const [key, value] of Object.entries(selected)) {
    const assignment = `${key}=${encode(value)}`
    const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'gm')
    if (pattern.test(updated)) {
      let retained = false
      updated = updated.replace(pattern, () => { if (retained) return ''; retained = true; return assignment })
    } else updated += `${updated.endsWith('\n') ? '' : '\n'}${assignment}\n`
  }
  const changed = updated !== original
  const summary = { applied: values.apply, environment_changed: changed, mode, storage_driver: 'filesystem',
    archive_directory: archive, release_file: releaseFile, release_created: !existing,
    storage_namespace: storage.namespace, publication_recorded: Boolean(existing?.publishedAt) }
  if (values.apply) {
    const group = Number(execFileSync('id', ['-g', values['service-user']], { encoding: 'utf8' }).trim())
    if (!Number.isSafeInteger(group) || group < 0) throw new Error('invalid_service_group')
    const atomicWrite = (file, bytes, mode, uid, gid) => {
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
      const fd = fs.openSync(temporary, 'wx', mode)
      try {
        try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fchownSync(fd, uid, gid); fs.fsyncSync(fd) }
        finally { fs.closeSync(fd) }
        fs.renameSync(temporary, file)
        const parent = fs.openSync(path.dirname(file), 'r')
        try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    }
    if (!existing) {
      const directory = path.dirname(releaseFile), present = fs.existsSync(directory)
      fs.mkdirSync(directory, { recursive: true, mode: 0o750 })
      if (!present) { fs.chownSync(directory, process.getuid(), group); fs.chmodSync(directory, 0o750) }
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('invalid_release_directory')
      const draft = { schemaVersion: 1, policyVersion: 'session-lifecycle-v2', publishedAt: null,
        effectiveAt: null, transitionDeadline: null, storageNamespace: storage.namespace, evidence: {} }
      atomicWrite(releaseFile, JSON.stringify(draft, null, 2) + '\n', 0o640, process.getuid(), group)
    }
    if (changed) {
      const backupDirectory = values['backup-dir']
      fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
      const stat = fs.lstatSync(backupDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('invalid_backup_directory')
      const backup = path.join(backupDirectory, `relay.env-pre-lifecycle-${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID()}`)
      fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
      atomicWrite(envFile, updated, 0o600, envStat.uid, envStat.gid)
      summary.environment_backup = backup
    }
  }
  console.log(JSON.stringify(summary))
} catch (error) {
  const allowed = ['invalid_configuration_path', 'invalid_environment_file', 'existing_object_storage_requires_migration',
    'archive_directory_not_provisioned', 'release_storage_mismatch', 'invalid_lifecycle_mode', 'invalid_service_group',
    'invalid_release_directory', 'invalid_backup_directory', 'invalid session lifecycle release file']
  console.log(JSON.stringify({ error: allowed.includes(error?.message) ? error.message : 'lifecycle_configuration_failed' }))
  process.exitCode = 1
}
