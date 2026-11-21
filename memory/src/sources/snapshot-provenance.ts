import {isDeepStrictEqual} from 'node:util'
import type {SourceHead} from '@pocketctl/session-source'

/** The authenticated reader independently parsed the provenance and checked
 * its identity. Compare with the original classification before serializing
 * a page, so PostgreSQL receives just one copy of a matching JSON object. */
export function compactSnapshotFields(head:SourceHead) {
  const {memory,...residual}=head.provenance
  if (head.provenance.state!=='known' || !memory || typeof memory!=='object' || Array.isArray(memory)
    || Object.hasOwn(residual,'team') || Object.hasOwn(residual,'accepted_delivery') || head.sessionKey.startsWith('team_')) return null
  const proof=memory as Record<string,unknown>
  if (proof.version!==1 || proof.session_id!==head.sessionKey || typeof proof.turn_id!=='string' || proof.turn_id!==head.turnKey
    || typeof proof.sequence!=='string' || proof.sequence!==head.sourceSequence
    || !isDeepStrictEqual(memory,head.classification.memory_source)) return null
  return {provenance:residual,snapshot_format:1}
}

// Use the stored subobject directly for admission checks. Only full-document
// consumers (including historical fingerprints) need to rebuild the outer key.
export function snapshotMemorySql(row: string): string {
  return `(CASE WHEN ${row}.snapshot_format=1 THEN ${row}.classification->'memory_source'
    ELSE ${row}.source_provenance->'memory' END)`
}

export function snapshotProvenanceSql(row: string): string {
  return `(CASE WHEN ${row}.snapshot_format=1 THEN
    jsonb_set(${row}.source_provenance, '{memory}', ${row}.classification->'memory_source')
    ELSE ${row}.source_provenance END)`
}
