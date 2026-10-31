import { timestampMicros } from './time.js'
import type { SessionLifecycleConfig } from './types.js'
import { loadSessionLifecycleRelease } from './release.js'

const POLICY = {
  version: 'session-lifecycle-v2',
  archiveDays: 30,
  purgeDays: 60,
  notificationRetentionDays: 90,
}

export function sessionLifecycleConfig(
  env: Record<string, string | undefined> = process.env,
): SessionLifecycleConfig {
  const mode = env.SESSION_LIFECYCLE_MODE?.trim() || 'enforce'
  if (mode !== 'off' && mode !== 'observe' && mode !== 'enforce') {
    throw new Error('SESSION_LIFECYCLE_MODE must be off, observe or enforce')
  }
  const storageDriver = env.SESSION_LIFECYCLE_STORAGE_DRIVER?.trim() || 's3'
  if (storageDriver !== 's3' && storageDriver !== 'filesystem') throw new Error('invalid lifecycle storage driver')
  // Configuration defaults on per the user's 2026-10-12 instruction. Actual
  // execution readiness is assessed separately and must not be inferred here.
  const version = env.SESSION_LIFECYCLE_POLICY_VERSION ?? POLICY.version
  if (version !== POLICY.version)
    throw new Error('unsupported SESSION_LIFECYCLE_POLICY_VERSION')
  const integer = (key: string, fallback: number, maximum: number): number => {
    const raw = env[key]
    if (raw === undefined) return fallback
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`invalid ${key}`)
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value > maximum)
      throw new Error(`invalid ${key}`)
    return value
  }
  const archiveDays = integer(
    'SESSION_LIFECYCLE_ARCHIVE_DAYS',
    POLICY.archiveDays,
    36500,
  )
  const purgeDays = integer(
    'SESSION_LIFECYCLE_PURGE_DAYS',
    POLICY.purgeDays,
    36500,
  )
  if (archiveDays !== POLICY.archiveDays || purgeDays !== POLICY.purgeDays) {
    throw new Error(
      'lifecycle retention changes require a new implemented policy version',
    )
  }
  const time = (key: string): string | null => {
    const raw = env[key]
    if (!raw) return null
    try {
      timestampMicros(raw)
    } catch {
      throw new Error(`invalid ${key}`)
    }
    return raw
  }
  const release = loadSessionLifecycleRelease(env.SESSION_LIFECYCLE_RELEASE_FILE)
  const effectiveAt = time('SESSION_LIFECYCLE_EFFECTIVE_AT') ?? release?.effectiveAt ?? null
  const transitionDeadline = time('SESSION_LIFECYCLE_TRANSITION_DEADLINE') ?? release?.transitionDeadline ?? null
  if (
    effectiveAt &&
    transitionDeadline &&
    timestampMicros(transitionDeadline) < timestampMicros(effectiveAt)
  ) {
    throw new Error(
      'lifecycle transition deadline precedes policy effective time',
    )
  }
  return {
    mode,
    policyVersion: version,
    archiveDays,
    purgeDays,
    effectiveAt,
    transitionDeadline,
    notificationRetentionDays: POLICY.notificationRetentionDays,
    scanIntervalMs: integer(
      'SESSION_LIFECYCLE_SCAN_INTERVAL_MS',
      3_600_000,
      86_400_000,
    ),
    continuationDelayMs: integer('SESSION_LIFECYCLE_CONTINUATION_DELAY_MS', 5_000, 86_400_000),
    batchSessions: integer('SESSION_LIFECYCLE_BATCH_SESSIONS', 20, 1000),
    batchBytes: integer(
      'SESSION_LIFECYCLE_BATCH_BYTES',
      64 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
    runBudgetMs: integer('SESSION_LIFECYCLE_RUN_BUDGET_MS', 60_000, 600_000),
    transferConcurrency: integer(
      'SESSION_LIFECYCLE_TRANSFER_CONCURRENCY',
      1,
      16,
    ),
    maxChunkBytes: integer(
      'SESSION_LIFECYCLE_MAX_CHUNK_BYTES',
      4 * 1024 * 1024,
      64 * 1024 * 1024,
    ),
    maxCompressedBytes: integer(
      'SESSION_LIFECYCLE_MAX_COMPRESSED_BYTES',
      8 * 1024 * 1024,
      128 * 1024 * 1024,
    ),
    objectBucket: env.SESSION_LIFECYCLE_OBJECT_BUCKET || null,
    objectRegion: env.SESSION_LIFECYCLE_OBJECT_REGION || null,
    storageDriver,
    archiveDirectory: env.SESSION_LIFECYCLE_OBJECT_DIRECTORY || null,
    filesystemMinFreeBytes: integer('SESSION_LIFECYCLE_FILESYSTEM_MIN_FREE_BYTES', 256 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
    release,
  }
}
