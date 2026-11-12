import {sourcePoolContext} from '../sources/pool-context.js'
import {preparedEvidenceSources} from '../sources/evidence-sources.js'
import type pg from 'pg'
import {createHash} from 'node:crypto'
import {sanitizeText} from '../episodes/content-policy.js'
export interface ResolvedPacketEvidence {
  handle: string
  excerpt: string
  manifest: {
    kind: 'event' | 'artifact' | 'episode'
    source_event_id?: string
    artifact_id?: string
    excerpt_hash?: string
    truncated?: boolean
    source_provenance?: Record<string, unknown>
  }
}

export function resolvePacketEvidence(
  document: unknown,
  manifest: unknown,
  handles: readonly string[],
): ResolvedPacketEvidence[] {
  const excerpts = new Map<string, string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    const handle = typeof object.evidence_handle === 'string' ? object.evidence_handle : null
    const excerpt = typeof object.text === 'string'
      ? object.text
      : (typeof object.summary === 'string' ? object.summary : null)
    if (handle && excerpt && !excerpts.has(handle)) excerpts.set(handle, excerpt)
    for (const child of Object.values(object)) visit(child)
  }
  visit(document)

  const entries = manifest !== null && typeof manifest === 'object'
    ? manifest as Record<string, unknown>
    : {}
  const resolved: ResolvedPacketEvidence[] = []
  for (const handle of handles) {
    const raw = entries[handle]
    const excerpt = excerpts.get(handle)
    if (!excerpt || raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (entry.kind !== 'event' && entry.kind !== 'artifact' && entry.kind !== 'episode') continue
    resolved.push({
      handle,
      excerpt,
      manifest: {
        kind: entry.kind,
        ...(typeof entry.source_event_id === 'string' ? { source_event_id: entry.source_event_id } : {}),
        ...(typeof entry.artifact_id === 'string' ? { artifact_id: entry.artifact_id } : {}),
        ...(typeof entry.excerpt_hash === 'string' ? { excerpt_hash: entry.excerpt_hash } : {}),
        ...(typeof entry.truncated === 'boolean' ? { truncated: entry.truncated } : {}),
        ...(entry.source_provenance !== null && typeof entry.source_provenance === 'object'
          && !Array.isArray(entry.source_provenance)
          ? { source_provenance: entry.source_provenance as Record<string, unknown> }
          : {}),
      },
    })
  }
  return resolved
}

/** Known proof is captured when a new pack is written. Bad legacy hashes stay
 * unproven; no current bytes are retroactively asserted as historical proof. */
export async function captureEvidenceReference(client:Pick<pg.PoolClient,'query'>,installationId:string,evidenceId:string,versionId:string){
 const [reference]=await captureEvidenceReferences(client,installationId,[{evidenceId,versionId}])
 return reference
}

export async function captureEvidenceReferences(
 client:Pick<pg.PoolClient,'query'>,
 installationId:string,
 evidence:readonly {evidenceId:string;versionId:string}[],
){
 if(!evidence.length)return []
 const prepared=preparedEvidenceSources(client)
 if(sourcePoolContext(client).namespace==='memory'&&!prepared)throw Error('source_preparation_required')
 const rows=(await client.query<{evidence_id:string;source_event_id:string|null;artifact_id:string|null;version_id:string;source_version:string;excerpt:string;excerpt_hash:Buffer;source_text:string|null}>(`SELECT e.evidence_id::text,e.source_event_id::text,e.artifact_id::text,e.version_id::text,COALESCE(e.artifact_id,e.source_event_id,e.capsule_id,e.version_id)::text AS source_version,e.excerpt,e.excerpt_hash,
   ${prepared?'NULL::text AS source_text':`CASE WHEN event.origin='team' OR event.source_kind IN('team_collaboration','team_delivery','team_semantic') THEN NULL
     WHEN e.artifact_id IS NOT NULL THEN CASE WHEN jsonb_typeof(artifact.details->'text')='string' THEN left(artifact.details->>'text',64000) ELSE NULL END
     WHEN jsonb_typeof(event.payload->'text')='string' THEN left(event.payload->>'text',64000) ELSE NULL END AS source_text`}
   FROM knowledge_evidence e
   LEFT JOIN source_artifacts artifact ON artifact.installation_id=e.installation_id AND artifact.artifact_id=e.artifact_id
   LEFT JOIN source_events event ON event.installation_id=e.installation_id
     AND event.source_event_id=CASE WHEN e.artifact_id IS NOT NULL THEN artifact.source_event_id ELSE e.source_event_id END
   WHERE e.installation_id=$1 AND e.evidence_id=ANY($2::uuid[])
   ORDER BY e.evidence_id FOR SHARE OF e`,[installationId,evidence.map(ref=>ref.evidenceId)])).rows
 const byId=new Map(rows.map(row=>[row.evidence_id,row]))
 return evidence.map(({evidenceId,versionId})=>{
  const row=byId.get(evidenceId.toLowerCase())
  if(!row||row.version_id!==versionId.toLowerCase()||row.excerpt_hash.length!==32
   ||!createHash('sha256').update(row.excerpt).digest().equals(row.excerpt_hash))return null
  const sourceText=prepared?prepared.material(row.evidence_id,row.version_id,row.source_event_id,row.artifact_id).sourceText:row.source_text
  return {versionId:row.version_id,sourceVersion:row.source_version,excerptHash:row.excerpt_hash,
   sourceHash:sourceText?createHash('sha256').update(sanitizeText(sourceText,64000).text).digest('hex'):null}
 })
}
