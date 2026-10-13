import { randomUUID } from 'node:crypto'
import { sessionLifecycleConfig } from './session-lifecycle/config.js'
import { sessionLifecycleReadiness } from './session-lifecycle/readiness.js'
import { createConfiguredArchiveStorage } from './session-history/runtime.js'
import { archiveObjectKey, readArchiveObject } from './session-archive/storage.js'

const args = new Set(process.argv.slice(2))
try {
  if ([...args].some(arg => !['--require-execution', '--require-release', '--probe-storage'].includes(arg))) throw new Error('invalid preflight argument')
  const config = sessionLifecycleConfig(process.env), storage = createConfiguredArchiveStorage(config)
  let probe = args.has('--probe-storage') ? 'unavailable' : 'not_requested'
  try {
    if (storage && args.has('--probe-storage')) {
      // Explicit probe only. This CLI never scans sessions or creates lifecycle jobs.
      const key = archiveObjectKey(randomUUID(), 0), bytes = Buffer.from('PocketCtl private archive deployment probe')
      try {
        await storage.put(key, bytes)
        if (!(await readArchiveObject(storage, key, bytes.length)).equals(bytes)) throw new Error('archive probe mismatch')
      } finally { await storage.delete(key) }
      probe = 'passed'
    }
    const status = sessionLifecycleReadiness(config, storage ?? false)
    const deploymentReady = Boolean(storage && config.effectiveAt && config.transitionDeadline) && status.release_blockers.length === 0
    console.log(JSON.stringify({ ...status, deployment_ready: deploymentReady, storage_driver: config.storageDriver, storage_namespace: storage?.namespace ?? null, storage_probe: probe }))
    if (args.has('--require-execution') && !status.execution_ready) process.exitCode = 2
    if (args.has('--require-release') && !deploymentReady) process.exitCode = 2
  } finally { storage?.close?.() }
} catch (error) {
  const message = error instanceof Error && ['invalid session lifecycle release file', 'invalid preflight argument'].includes(error.message)
    ? error.message : 'lifecycle_preflight_failed'
  console.log(JSON.stringify({ error: message }))
  process.exitCode = 1
}
