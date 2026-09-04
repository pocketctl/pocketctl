/**
 * Deterministic Episode Packet compiler (plan §5.1). The packet is the only
 * model-facing view of an episode: bounded, evidence-addressable, replayable
 * byte-for-byte for identical input, and rebuilt only when the source digest
 * or compiler version changes.
 */

import { createHash } from 'crypto'
import {
  PACKET_POLICY_VERSION,
  basenameOnly,
  describeEvent,
  sanitizeText,
} from './content-policy.js'

export const EPISODE_PACKET_COMPILER_VERSION = 'memory-episode-packet-v3'
export const PACKET_SCHEMA_VERSION = 1 as const

export interface EvidenceStatement {
  text: string
  evidence_handle: string
}

export type TimelineKind =
  | 'user_goal' | 'tool_call' | 'file_change' | 'test' | 'ci'
  | 'approval' | 'correction' | 'retry' | 'failure' | 'final' | 'other'

export interface TimelineEntry {
  kind: TimelineKind
  status: string | null
  summary: string
  evidence_handle: string
}

export interface EpisodeDocumentV1 {
  schema_version: typeof PACKET_SCHEMA_VERSION
  objective: EvidenceStatement[]
  repository: {
    repository_id: string | null
    repo_snapshot_id: string | null
    branch: string | null
    commit_sha: string | null
    worktree_identity: string | null
  }
  timeline: TimelineEntry[]
  files: EvidenceStatement[]
  symbols: EvidenceStatement[]
  tests: Array<EvidenceStatement & { status: 'passed' | 'failed' | 'unknown' }>
  approvals: EvidenceStatement[]
  corrections: EvidenceStatement[]
  failures: EvidenceStatement[]
  final_outcome: EvidenceStatement | null
  incomplete: EvidenceStatement[]
}

export type EvidenceKind = 'event' | 'artifact' | 'episode'

export interface EvidenceManifestEntry {
  kind: EvidenceKind
  source_event_id?: string
  artifact_id?: string
  excerpt_hash: string
  excerpt_length: number
  truncated: boolean
  /** Compiler metadata only; never eligible as Claim Evidence. */
  omitted?: boolean
}

export type EvidenceManifest = Record<string, EvidenceManifestEntry>

export interface PacketSourceEvent {
  source_event_id: string
  event_type: string
  occurred_at: Date
  payload_hash: Buffer
  payload: Record<string, unknown>
  classification: Record<string, unknown>
}

export interface PacketSourceArtifact {
  artifact_id: string
  artifact_type: string
  identity_key: string
  path: string | null
  status: string | null
  details: Record<string, unknown>
  source_event_id: string
}

export interface PacketRepositoryFact {
  repository_id: string
  repo_snapshot_id: string | null
  commit_sha: string | null
  branch: string | null
  worktree_identity: string | null
}

export interface PacketBudget {
  statementChars: number
  timelineEntries: number
  sectionEntries: number
  totalDocumentChars: number
}

export const DEFAULT_PACKET_BUDGET: PacketBudget = Object.freeze({
  statementChars: 480,
  timelineEntries: 200,
  sectionEntries: 64,
  totalDocumentChars: 200_000,
})

export interface BuiltPacket {
  document: EpisodeDocumentV1
  manifest: EvidenceManifest
  sourceDigest: Buffer
  compilerVersion: string
  policyVersion: string
}

/** Deterministic canonical JSON: sorted keys, no incidental whitespace. */
export function canonicalPacketJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const sorted: Record<string, unknown> = {}
    for (const [key, item] of entries) sorted[key] = sortKeysDeep(item)
    return sorted
  }
  return value
}

function timelineKindFor(eventType: string, data: Record<string, unknown>): TimelineKind {
  if (eventType === 'user_goal' || eventType === 'user_message') return 'user_goal'
  if (eventType === 'tool_call' || eventType === 'command') return 'tool_call'
  if (eventType === 'file_change' || eventType === 'diff') return 'file_change'
  if (eventType === 'test_result' || eventType.includes('test')) return 'test'
  if (eventType === 'ci_result' || eventType.includes('ci')) return 'ci'
  if (eventType.includes('approval')) return 'approval'
  if (eventType.includes('correction')) return 'correction'
  if (eventType.includes('retry')) return 'retry'
  if (eventType === 'tool_result' && (data.status === 'error' || data.status === 'failed')) return 'failure'
  if (eventType === 'turn_status' || eventType === 'session_status') return 'final'
  return 'other'
}

function testStatus(value: unknown): 'passed' | 'failed' | 'unknown' {
  if (value === 'passed' || value === 'failed') return value
  return 'unknown'
}

/**
 * Compile the bounded Episode Packet. Handles are Episode-local and derive
 * from statement order plus a stable hash — identical input yields identical
 * bytes, and no handle can exist without a manifest entry.
 */
export function buildEpisodePacket(input: {
  installationId: string
  sessionId: string
  turnId: string
  outcome: string
  reason: string | null
  events: readonly PacketSourceEvent[]
  artifacts: readonly PacketSourceArtifact[]
  repository: PacketRepositoryFact | null
  budget?: PacketBudget
}): BuiltPacket {
  const budget = input.budget ?? DEFAULT_PACKET_BUDGET
  const manifest: EvidenceManifest = {}
  const statements: EvidenceStatement[] = []

  const register = (
    sanitized: { text: string; truncated: boolean; originalLength: number; originalHash: string },
    kind: EvidenceKind,
    refs: { source_event_id?: string; artifact_id?: string },
  ): EvidenceStatement => {
    const index = statements.length
    const handle = `h${index}-${createHash('sha256')
      .update(`${kind}:${refs.source_event_id ?? ''}:${refs.artifact_id ?? ''}:${sanitized.originalHash}`)
      .digest('hex').slice(0, 8)}`
    manifest[handle] = {
      kind,
      ...(refs.source_event_id ? { source_event_id: refs.source_event_id } : {}),
      ...(refs.artifact_id ? { artifact_id: refs.artifact_id } : {}),
      excerpt_hash: sanitized.originalHash,
      excerpt_length: sanitized.originalLength,
      truncated: sanitized.truncated,
    }
    const statement = { text: sanitized.text, evidence_handle: handle }
    statements.push(statement)
    return statement
  }

  const orderedEvents = [...input.events].sort((a, b) =>
    a.occurred_at.getTime() - b.occurred_at.getTime()
    || (a.source_event_id < b.source_event_id ? -1 : 1),
  )

  // Objective: the first user-authored statement, redacted and bounded.
  const objective: EvidenceStatement[] = []
  for (const event of orderedEvents) {
    if (objective.length >= budget.sectionEntries) break
    const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
    if (!text) continue
    if (timelineKindFor(event.event_type, event.payload) !== 'user_goal') continue
    objective.push(register(sanitizeText(text, budget.statementChars), 'event', {
      source_event_id: event.source_event_id,
    }))
    break
  }

  const timeline: TimelineEntry[] = []
  const files: EvidenceStatement[] = []
  const symbols: EvidenceStatement[] = []
  const tests: Array<EvidenceStatement & { status: 'passed' | 'failed' | 'unknown' }> = []
  const approvals: EvidenceStatement[] = []
  const corrections: EvidenceStatement[] = []
  const failures: EvidenceStatement[] = []
  const incomplete: EvidenceStatement[] = []

  for (const event of orderedEvents) {
    const kind = timelineKindFor(event.event_type, event.payload)
    const sanitized = describeEvent(event.event_type, event.payload, budget.statementChars)
    if (sanitized.text.length === 0) continue
    const status = typeof event.payload?.status === 'string'
      ? event.payload.status
      : (typeof event.payload?.turn_status === 'string' ? event.payload.turn_status : null)
    if (timeline.length < budget.timelineEntries) {
      const statement = register(sanitized, 'event', { source_event_id: event.source_event_id })
      timeline.push({
        kind,
        status: status && status.length <= 64 ? status : null,
        summary: statement.text,
        evidence_handle: statement.evidence_handle,
      })
    }
    if (kind === 'correction' && corrections.length < budget.sectionEntries) {
      corrections.push(register(sanitized, 'event', { source_event_id: event.source_event_id }))
    }
    if (kind === 'failure' && failures.length < budget.sectionEntries) {
      failures.push(register(sanitized, 'event', { source_event_id: event.source_event_id }))
    }
    if (kind === 'test' && tests.length < budget.sectionEntries) {
      tests.push({
        ...register(sanitized, 'event', { source_event_id: event.source_event_id }),
        status: testStatus(status),
      })
    }
    if (kind === 'approval' && approvals.length < budget.sectionEntries) {
      approvals.push(register(sanitized, 'event', { source_event_id: event.source_event_id }))
    }
    if (event.event_type === 'code_symbol' && symbols.length < budget.sectionEntries) {
      symbols.push(register(sanitized, 'event', { source_event_id: event.source_event_id }))
    }
  }

  for (const artifact of input.artifacts) {
    if (files.length >= budget.sectionEntries) break
    if (artifact.artifact_type !== 'file_change' || !artifact.path) continue
    const lines = (details: Record<string, unknown>): string => {
      const added = typeof details.lines_added === 'number' ? details.lines_added : null
      const removed = typeof details.lines_removed === 'number' ? details.lines_removed : null
      if (added === null && removed === null) return ''
      return ` (+${added ?? 0}/-${removed ?? 0})`
    }
    files.push(register(
      sanitizeText(
        `${artifact.status ?? 'changed'} ${basenameOnly(artifact.path)}${lines(artifact.details)}`,
        budget.statementChars,
      ),
      'artifact',
      { artifact_id: artifact.artifact_id, source_event_id: artifact.source_event_id },
    ))
  }

  const finalSanitized = sanitizeText(
    `turn ${input.outcome}${input.reason ? `: ${input.reason}` : ''}`,
    budget.statementChars,
  )
  const final_outcome = register(finalSanitized, 'episode', {})
  if (input.outcome !== 'completed' && incomplete.length < budget.sectionEntries) {
    incomplete.push(register(
      sanitizeText(`turn ended ${input.outcome}; work may be unfinished`, budget.statementChars),
      'episode',
      {},
    ))
  }

  const document: EpisodeDocumentV1 = {
    schema_version: PACKET_SCHEMA_VERSION,
    objective,
    repository: {
      repository_id: input.repository?.repository_id ?? null,
      repo_snapshot_id: input.repository?.repo_snapshot_id ?? null,
      branch: input.repository?.branch
        ? sanitizeText(input.repository.branch, 255).text
        : null,
      commit_sha: input.repository?.commit_sha ?? null,
      worktree_identity: input.repository?.worktree_identity
        ? sanitizeText(basenameOnly(input.repository.worktree_identity), 255).text
        : null,
    },
    timeline,
    files,
    symbols,
    tests,
    approvals,
    corrections,
    failures,
    final_outcome,
    incomplete,
  }

  enforceTotalDocumentBudget(document, manifest, budget)

  const sourceDigest = computeSourceDigest({
    installationId: input.installationId,
    events: orderedEvents,
    artifacts: input.artifacts,
  })

  return {
    document,
    manifest,
    sourceDigest,
    compilerVersion: EPISODE_PACKET_COMPILER_VERSION,
    policyVersion: PACKET_POLICY_VERSION,
  }
}

/**
 * Deterministically remove lower-priority statements until the complete
 * model-facing document fits. Removed handles disappear from the allowlist;
 * one synthetic incomplete statement records aggregate omitted length/hash.
 */
function enforceTotalDocumentBudget(
  document: EpisodeDocumentV1,
  manifest: EvidenceManifest,
  budget: PacketBudget,
): void {
  if (canonicalPacketJson(document).length <= budget.totalDocumentChars) return

  const removed: EvidenceManifestEntry[] = []
  let omissionHandle: string | null = null

  const removeOmission = () => {
    if (!omissionHandle) return
    const index = document.incomplete.findIndex(item => item.evidence_handle === omissionHandle)
    if (index >= 0) document.incomplete.splice(index, 1)
    delete manifest[omissionHandle]
    omissionHandle = null
  }

  const removeHandle = (handle: string) => {
    const entry = manifest[handle]
    if (entry) removed.push(entry)
    delete manifest[handle]
  }

  const popStatement = <T extends EvidenceStatement>(items: T[]): boolean => {
    const item = items.pop()
    if (!item) return false
    removeHandle(item.evidence_handle)
    return true
  }

  const popTimeline = (preferredKind?: TimelineKind): boolean => {
    let index = document.timeline.length - 1
    if (preferredKind) {
      index = -1
      for (let candidate = document.timeline.length - 1; candidate >= 0; candidate--) {
        if (document.timeline[candidate].kind === preferredKind) {
          index = candidate
          break
        }
      }
    }
    if (index < 0) return false
    const [item] = document.timeline.splice(index, 1)
    removeHandle(item.evidence_handle)
    return true
  }

  const removeNext = (): boolean => (
    popTimeline('other')
    || popTimeline('tool_call')
    || popTimeline()
    || popStatement(document.symbols)
    || popStatement(document.approvals)
    || popStatement(document.files)
    || popStatement(document.tests)
    || popStatement(document.failures)
    || popStatement(document.corrections)
    || popStatement(document.objective)
    || popStatement(document.incomplete)
  )

  while (true) {
    removeOmission()
    if (!removeNext()) {
      throw new Error(`episode packet fixed fields exceed total budget: ${budget.totalDocumentChars}`)
    }

    const omittedLength = removed.reduce((sum, entry) => sum + entry.excerpt_length, 0)
    const omittedHash = createHash('sha256')
      .update(removed.map(entry => `${entry.excerpt_hash}:${entry.excerpt_length}`).join('\n'))
      .digest('hex').slice(0, 16)
    const summary = sanitizeText(
      `episode packet omitted ${removed.length} lower-priority statements (${omittedLength} source characters); digest ${omittedHash}`,
      budget.statementChars,
    )
    omissionHandle = `h-omitted-${omittedHash.slice(0, 8)}`
    document.incomplete.push({ text: summary.text, evidence_handle: omissionHandle })
    manifest[omissionHandle] = {
      kind: 'episode',
      excerpt_hash: omittedHash,
      excerpt_length: omittedLength,
      truncated: true,
      omitted: true,
    }
    if (canonicalPacketJson(document).length <= budget.totalDocumentChars) return
  }
}

/**
 * source_digest covers ordered source event hashes, artifact identities, the
 * packet compiler version, and the policy version — any content or policy
 * change forces a rebuild and re-extraction.
 */
export function computeSourceDigest(input: {
  installationId: string
  events: readonly PacketSourceEvent[]
  artifacts: readonly PacketSourceArtifact[]
}): Buffer {
  const hash = createHash('sha256')
  hash.update(`${EPISODE_PACKET_COMPILER_VERSION}\n${PACKET_POLICY_VERSION}\n${input.installationId}\n`)
  for (const event of input.events) {
    hash.update(`event:${event.source_event_id}:`)
    hash.update(event.payload_hash)
    hash.update('\n')
  }
  for (const artifact of input.artifacts) {
    hash.update(`artifact:${artifact.artifact_type}:${artifact.identity_key}:${artifact.artifact_id}\n`)
  }
  return hash.digest()
}
