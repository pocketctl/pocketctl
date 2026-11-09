import type pg from 'pg'
import type {PagedRoot} from './paged-cleanup-authority.js'
import type {CleanupDependencies} from './forward-cleanup-state.js'
import {assertExactSourceEpisode} from './forward-exact-source.js'
/** Positive candidates use exact native UUID fields only. Every negative JSON
 * channel remains covered independently before and after each mutation. */
function selectedSource(alias:string,roots:string){return `EXISTS(SELECT 1 FROM jsonb_to_recordset(${roots}::jsonb) scoped("installationId" uuid,"sessionId" text) WHERE ${alias}.installation_id=scoped."installationId" AND ${alias}.session_id=scoped."sessionId")`}
export function pagedAffectedEpisodePredicate(alias:string,roots:string){
 const selected=selectedSource('src',roots)
 // Drive candidate discovery from actual typed references, not every selected
 // source crossed with every unrelated episode. Empty packet/evidence sets do
 // no source work. The independent all-channel negative scan is unchanged.
 return `(EXISTS(SELECT 1 FROM memory.knowledge_evidence ev LEFT JOIN memory.source_artifacts art ON art.artifact_id=ev.artifact_id AND art.installation_id=ev.installation_id
  WHERE ev.installation_id=${alias}.installation_id AND ev.episode_id=${alias}.episode_id AND EXISTS(SELECT 1 FROM memory.source_events src WHERE ${selected} AND(src.source_event_id=ev.source_event_id OR src.source_event_id=art.source_event_id)))
  OR EXISTS(SELECT 1 FROM memory.memory_skill_archives a JOIN memory.memory_skill_archive_sources ase USING(installation_id,archive_id) LEFT JOIN memory.source_artifacts art ON art.artifact_id=ase.artifact_id AND art.installation_id=ase.installation_id
   WHERE a.installation_id=${alias}.installation_id AND a.episode_id=${alias}.episode_id AND EXISTS(SELECT 1 FROM memory.source_events src WHERE ${selected} AND(ase.source_event_id=src.source_event_id OR art.source_event_id=src.source_event_id)))
  OR EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(${alias}.evidence_manifest)='object' THEN ${alias}.evidence_manifest ELSE '{}'::jsonb END) entry LEFT JOIN memory.source_artifacts art ON art.artifact_id::text=entry.value->>'artifact_id'
   WHERE EXISTS(SELECT 1 FROM memory.source_events src WHERE ${selected} AND(entry.value->>'source_event_id'=src.source_event_id::text OR art.source_event_id=src.source_event_id))))`
}
export async function assertPagedExactEpisodes(c:pg.Client,roots:readonly PagedRoot[],installationIds:string[],episodeIds:string[]){
 if(!episodeIds.length)return
 // Size every projected field, including JSON escaping of unknown compiler
 // text and both UUIDs, in this same snapshot. The small fixed reserve covers
 // the returned size marker. No unbounded field is projected on refusal, and
 // selected dependents remain visible so overflow cannot silently omit them.
 const rows=(await c.query(`WITH selected AS MATERIALIZED(
  SELECT installation_id,episode_id,evidence_manifest,document_compiler_version
  FROM memory.work_episodes WHERE episode_id=ANY($1::uuid[])
 ), sized AS MATERIALIZED(
  SELECT selected.*,octet_length(to_jsonb(selected)::text)::bigint+64 AS bytes FROM selected
 ), budget AS(SELECT COALESCE(sum(bytes),0)<=8388608 AS admitted FROM sized)
 SELECT installation_id::text,episode_id::text,
  CASE WHEN budget.admitted THEN evidence_manifest ELSE NULL END AS evidence_manifest,
  CASE WHEN budget.admitted THEN document_compiler_version ELSE NULL END AS document_compiler_version,
  bytes::text FROM sized CROSS JOIN budget`,[episodeIds])).rows
 if(rows.length!==episodeIds.length||rows.reduce((n,r)=>n+Number(r.bytes),0)>8388608)throw Error('paged_component_capacity')
 for(const episode of rows){
  if(!episode.evidence_manifest||typeof episode.evidence_manifest!=='object'||Array.isArray(episode.evidence_manifest))throw Error('cleanup_exact_source_manifest_unparsed')
  // Validation receives only exact selected UUIDs, not reconstructed content or
  // a synthesized non-Skill classification. Whole negative scans are separate.
  const events=(await c.query(`SELECT src.source_event_id::text AS id FROM memory.source_events src WHERE ${selectedSource('src','$1')} AND(
   EXISTS(SELECT 1 FROM memory.knowledge_evidence ev LEFT JOIN memory.source_artifacts art ON art.artifact_id=ev.artifact_id WHERE ev.episode_id=$2::uuid AND(ev.source_event_id=src.source_event_id OR art.source_event_id=src.source_event_id))
   OR EXISTS(SELECT 1 FROM memory.memory_skill_archives a JOIN memory.memory_skill_archive_sources ase USING(installation_id,archive_id) LEFT JOIN memory.source_artifacts art ON art.artifact_id=ase.artifact_id WHERE a.episode_id=$2::uuid AND(ase.source_event_id=src.source_event_id OR art.source_event_id=src.source_event_id))
   OR EXISTS(SELECT 1 FROM jsonb_each($3::jsonb) entry LEFT JOIN memory.source_artifacts art ON art.artifact_id::text=entry.value->>'artifact_id' WHERE entry.value->>'source_event_id'=src.source_event_id::text OR art.source_event_id=src.source_event_id)) ORDER BY src.source_event_id LIMIT 1025`,[JSON.stringify(roots),episode.episode_id,JSON.stringify(episode.evidence_manifest)])).rows.map(r=>r.id as string)
  if(events.length>1024)throw Error('paged_component_capacity')
  const artifacts=(await c.query('SELECT artifact_id::text AS id FROM memory.source_artifacts WHERE source_event_id=ANY($1::uuid[]) ORDER BY artifact_id LIMIT 1025',[events])).rows.map(r=>r.id as string)
  if(artifacts.length>1024)throw Error('paged_component_capacity')
  const d:CleanupDependencies={roots:[...roots],installationIds,broadIds:[],sourceEventIds:events,artifactIds:artifacts,episodeIds:[],candidateIds:[],packIds:[],injectionIds:[],bundleIds:[]}
  await assertExactSourceEpisode(c,d,artifacts,episode)
 }
}
