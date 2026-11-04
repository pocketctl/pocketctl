import type { PacketSourceEvent } from './packet.js'
import { parseMemorySourceProvenance } from './skill-provenance.js'

export const LIFECYCLE_SOURCE_POLICY = 'memory-source-admission-v1'
export type SourceAdmission =
  | { allowed: true; proof: 'trusted_non_skill' }
  | { allowed: false; reason: 'skill_derived' | 'provenance_unknown' | 'source_unavailable' }
export interface SourceAdmissionReceipt { source_event_id: string; admission: SourceAdmission }
const unknown = (): SourceAdmission => ({ allowed: false, reason: 'provenance_unknown' })

/** Resolve the complete supplied lineage before reading ANY event body.
 * Missing ancestors, cycles, ambiguous identities and unsupported producers
 * cannot confer non-skill authority. A later skill marker taints the entire
 * invocation, including earlier streaming fragments and final summaries. */
export function admitLifecycleSources(input: {
  sessionId: string; turnId: string; events: readonly PacketSourceEvent[]
}): { events: PacketSourceEvent[]; receipts: SourceAdmissionReceipt[] } {
  const events = input.events
  if (events.length > 4096) return { events: [], receipts: events.map(e => ({ source_event_id: e.source_event_id, admission: unknown() })) }
  const metadata = events.map(e => parseMemorySourceProvenance(e.source_provenance?.memory))
  const status: SourceAdmission[] = metadata.map(p => {
    if (!p || p.session_id !== input.sessionId || p.turn_id !== input.turnId) return unknown()
    if (p.skill_state === 'skill' || p.skill_invocation_id) return { allowed: false, reason: 'skill_derived' }
    if (!p.lineage_complete || p.skill_state !== 'non_skill'
      || (p.source_role === 'summary' && p.derived_from_event_ids.length === 0)) return unknown()
    return { allowed: true, proof: 'trusted_non_skill' }
  })
  const identities = new Map<string, number[]>()
  const sourceIds = new Map<string, number[]>()
  const invocations = new Map<string, number[]>()
  const sequences = new Map<string, number[]>()
  const add = (map: Map<string, number[]>, key: string, index: number) => map.set(key, [...(map.get(key) ?? []), index])
  metadata.forEach((p, i) => {
    add(sourceIds, events[i].source_event_id, i)
    if (!p) {
      // Invalid metadata can only exclude, never grant authority. Preserve a
      // bounded invocation reference so malformed siblings cannot reset taint.
      const raw = events[i].source_provenance?.memory as Record<string, unknown> | undefined
      if (raw && typeof raw.invocation_id === 'string' && raw.invocation_id.length <= 256) add(invocations, raw.invocation_id, i)
      return
    }
    add(identities, p.event_id, i)
    add(invocations, p.invocation_id, i)
    add(sequences, `${p.producer}:${p.sequence}`, i)
  })
  for (const map of [identities, sourceIds, sequences]) for (const group of map.values()) {
    if (group.length > 1) for (const i of group) if (status[i].allowed) status[i] = unknown()
  }
  // An invocation has one producer and parent binding. Conflicting metadata
  // cannot splice a child back into its ancestor under a reused identity.
  for (const group of invocations.values()) {
    const bindings = new Set(group.flatMap(i => metadata[i]
      ? [JSON.stringify([metadata[i]!.producer, metadata[i]!.parent_invocation_id ?? null])] : []))
    if (bindings.size > 1) for (const i of group) if (status[i].allowed) status[i] = unknown()
  }
  const dependencies = events.map(() => new Set<number>())
  const invocationPropagation: Array<[number, number]> = []
  metadata.forEach((p, i) => {
    if (!p) return
    for (const id of p.derived_from_event_ids) {
      const refs = identities.get(id)
      if (!refs || refs.length !== 1) { if (status[i].allowed) status[i] = unknown(); continue }
      const ref = refs[0]
      dependencies[i].add(ref)
      // A derived event must follow its evidence in the same producer stream.
      if (metadata[ref]!.producer !== p.producer || BigInt(metadata[ref]!.sequence) >= BigInt(p.sequence)) {
        if (status[i].allowed) status[i] = unknown()
      }
    }
    if (p.parent_invocation_id) {
      const parents = invocations.get(p.parent_invocation_id)
      if (!parents || p.parent_invocation_id === p.invocation_id) { if (status[i].allowed) status[i] = unknown() }
      else {
        let precedingParent = false
        for (const parent of parents) {
          invocationPropagation.push([parent, i])
          const proof = metadata[parent]
          if (proof && proof.producer === p.producer && BigInt(proof.sequence) < BigInt(p.sequence)) {
            dependencies[i].add(parent)
            precedingParent = true
          }
        }
        if (!precedingParent && status[i].allowed) status[i] = unknown()
      }
    }
  })
  // Causal dependencies include only preceding parent events. A later root
  // summary can depend on a child result without creating a causal cycle.
  const dependents = events.map(() => new Set<number>())
  dependencies.forEach((deps, i) => deps.forEach(parent => dependents[parent].add(i)))
  const remaining = dependencies.map(deps => deps.size)
  const ready = remaining.flatMap((count, i) => count === 0 ? [i] : [])
  for (let cursor = 0; cursor < ready.length; cursor++) {
    for (const child of dependents[ready[cursor]]) if (--remaining[child] === 0) ready.push(child)
  }
  remaining.forEach((count, i) => { if (count > 0 && status[i].allowed) status[i] = unknown() })
  // All parent events (including later skill markers) still propagate denial.
  // Propagation may contain cycles; monotone denial reaches a fixed point.
  for (const [parent, child] of invocationPropagation) dependents[parent].add(child)
  // Sibling segments share the invocation's exclusion, but they are not
  // causal dependencies (otherwise every multi-event invocation is a cycle).
  const propagatedInvocations = new Map<string, string>()
  const invocationFor = new Map<number, string>()
  for (const [id, group] of invocations) for (const i of group) invocationFor.set(i, id)
  const denied = status.flatMap((s, i) => s.allowed ? [] : [i])
  for (let cursor = 0; cursor < denied.length; cursor++) {
    const parent = denied[cursor]
    const inherited = status[parent]
    if (inherited.allowed) continue
    const groupId = invocationFor.get(parent)
    const siblings = groupId && propagatedInvocations.get(groupId) !== inherited.reason
      && propagatedInvocations.get(groupId) !== 'skill_derived' ? (invocations.get(groupId) ?? []) : []
    if (groupId && siblings.length) propagatedInvocations.set(groupId, inherited.reason)
    for (const child of [...dependents[parent], ...siblings]) {
      const current = status[child]
      // Skill exclusion wins over unknown and propagates through mixed lineage.
      if (current.allowed || (current.reason !== 'skill_derived' && inherited.reason === 'skill_derived')) {
        status[child] = inherited
        denied.push(child)
      }
    }
  }
  return {
    events: events.flatMap((event, i) => status[i].allowed ? [{ ...event,
      source_provenance: { memory: metadata[i] as unknown as Record<string, unknown> } }] : []),
    receipts: events.map((event, i) => ({ source_event_id: event.source_event_id, admission: status[i] }))
      .sort((a, b) => a.source_event_id.localeCompare(b.source_event_id)),
  }
}
