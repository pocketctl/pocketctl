import { DAY_US, microsTimestamp, timestampMicros } from './time.js'
import type {
  LifecycleBlocker,
  LifecycleEvaluation,
  LifecycleInput,
  SessionLifecycleConfig,
} from './types.js'

const activeStatuses = new Set([
  'running',
  'busy',
  'retry',
  'waiting',
  'waiting_approval',
  'waiting_question',
])
const inactiveStatuses = new Set([
  'idle',
  'exited',
  'completed',
  'failed',
  'stopped',
  'terminated',
  'abandoned',
  'error',
  'killed',
])

/** Pure prediction. Observe callers must never turn this into mutations. */
export function evaluateLifecycle(
  input: LifecycleInput,
  now: string | Date,
  config: SessionLifecycleConfig,
): LifecycleEvaluation {
  const result: LifecycleEvaluation = {
    action: null,
    activityAt: null,
    archiveAt: null,
    purgeAt: null,
    dueAt: null,
    blockedReasons: [],
    policyVersion: config.policyVersion,
  }
  if (config.mode === 'off')
    return { ...result, blockedReasons: ['policy_disabled'] }
  const current = timestampMicros(now)
  const reasons = new Set<LifecycleBlocker>(input.blockers)
  if (config.effectiveAt && current < timestampMicros(config.effectiveAt))
    reasons.add('policy_not_effective')
  if (!Number.isSafeInteger(input.ownerUserId) || (input.ownerUserId ?? 0) <= 0)
    reasons.add('owner_unknown')
  if (input.scope !== 'personal') reasons.add('scope_excluded')
  if (!input.activityVerified) reasons.add('activity_unverified')
  if (input.turnActive || activeStatuses.has(input.status ?? '')) reasons.add('session_active')
  else if (!inactiveStatuses.has(input.status ?? ''))
    reasons.add('status_unknown')
  if (input.contentState === 'deleting') reasons.add('session_deleting')
  if (input.contentState === 'deleted') reasons.add('session_deleted')
  if (input.contentState === 'cooling') reasons.add('cooling_pending')
  let activity: bigint | null = null
  for (const source of [
    input.activityAt,
    ...(input.dependencyActivityAt ?? []),
  ]) {
    if (source === null) {
      reasons.add('activity_unknown')
      continue
    }
    try {
      const value = timestampMicros(source)
      if (value > current) reasons.add('activity_future')
      if (activity === null || value > activity) activity = value
    } catch {
      reasons.add('activity_invalid')
    }
  }
  if (activity !== null) {
    const archive = activity + BigInt(config.archiveDays) * DAY_US
    let purge = activity + BigInt(config.purgeDays) * DAY_US
    if (input.historical && config.transitionDeadline) {
      const transition = timestampMicros(config.transitionDeadline)
      if (transition > purge) purge = transition
    }
    result.activityAt = microsTimestamp(activity)
    result.archiveAt = microsTimestamp(archive)
    result.purgeAt = microsTimestamp(purge)
    if (reasons.size === 0) {
      if (current > purge) {
        result.action = 'purge'
        result.dueAt = result.purgeAt
      } else if (current > archive) {
        if (!input.archiveReason) result.action = 'archive'
        else if (input.contentState === 'hot' || input.contentState === 'mixed') result.action = 'cool'
        if (result.action) result.dueAt = result.archiveAt
      }
    }
  }
  result.blockedReasons = [...reasons]
  return result
}
