import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SessionLifecycleConfig } from './types.js'
import { timestampMicros } from './time.js'

export const lifecycleReleaseGates = [
  'production_provider_and_backup_policy',
  'legal_publication',
  'production_client_release',
  'capacity_and_fault_acceptance',
] as const

export interface SessionLifecycleRelease {
  schemaVersion: 1
  policyVersion: string | null
  publishedAt: string | null
  effectiveAt: string | null
  transitionDeadline: string | null
  storageNamespace: string | null
  /** Operator-recorded evidence references, not automatically certified facts. */
  evidence: Partial<Record<typeof lifecycleReleaseGates[number], string>>
}

export function loadSessionLifecycleRelease(file: string | undefined): SessionLifecycleRelease | null {
  if (!file) return null
  let fd: number | undefined
  try {
    if (!isAbsolute(file)) throw new Error()
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o022) !== 0) throw new Error()
    const data = JSON.parse(readFileSync(fd, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1) throw new Error()
    const text = (key: string): string | null => {
      const value = data[key]
      if (value === undefined || value === null || value === '') return null
      if (typeof value !== 'string' || value.length > 2048 || !value.trim()) throw new Error()
      return value.trim()
    }
    const policyVersion = text('policyVersion'), storageNamespace = text('storageNamespace')
    const publishedAt = text('publishedAt'), effectiveAt = text('effectiveAt'), transitionDeadline = text('transitionDeadline')
    for (const date of [publishedAt, effectiveAt, transitionDeadline]) if (date) timestampMicros(date)
    const evidence: SessionLifecycleRelease['evidence'] = {}
    if (data.evidence !== undefined && (!data.evidence || typeof data.evidence !== 'object' || Array.isArray(data.evidence))) throw new Error()
    for (const gate of lifecycleReleaseGates) {
      const value = data.evidence?.[gate]
      if (value === undefined || value === null || value === '') continue
      if (typeof value !== 'string' || value.length > 2048) throw new Error()
      if (value.trim()) evidence[gate] = value.trim()
    }
    return Object.freeze({ schemaVersion: 1, policyVersion, publishedAt, effectiveAt, transitionDeadline, storageNamespace, evidence: Object.freeze(evidence) })
  } catch {
    // Release files can contain private infrastructure references. Never echo them.
    throw new Error('invalid session lifecycle release file')
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function lifecycleReleaseBlockers(config: SessionLifecycleConfig, storageNamespace: string | undefined, now: string | Date): string[] {
  const release = config.release
  if (!release) return ['release_record_missing']
  const blockers: string[] = []
  if (release.policyVersion !== config.policyVersion) blockers.push('release_policy_mismatch')
  if (!release.publishedAt || timestampMicros(release.publishedAt) > timestampMicros(now)) blockers.push('release_not_published')
  if (release.publishedAt && release.effectiveAt && timestampMicros(release.effectiveAt) < timestampMicros(release.publishedAt)) blockers.push('policy_before_publication')
  if (release.effectiveAt && release.transitionDeadline && timestampMicros(release.transitionDeadline) < timestampMicros(release.effectiveAt))
    blockers.push('historical_transition_before_effective')
  if (!release.effectiveAt || !release.transitionDeadline || !config.effectiveAt || !config.transitionDeadline
    || timestampMicros(release.effectiveAt) !== timestampMicros(config.effectiveAt)
    || timestampMicros(release.transitionDeadline) !== timestampMicros(config.transitionDeadline)) blockers.push('release_dates_mismatch')
  if (!storageNamespace || release.storageNamespace !== storageNamespace) blockers.push('release_storage_mismatch')
  for (const gate of lifecycleReleaseGates) if (!release.evidence[gate]) blockers.push(gate)
  return blockers
}
