import {independentlyAcceptedEvidenceOwnershipSql} from '../../claims/accepted-evidence-policy.js'
import {SOURCE_REFERENCE_FIELDS,UNREVIEWED_SESSION_ARRAY_KEYS,declaredReferenceRoster,retainedReferenceRoster,referenceChannelSql,matchesSourceReferenceSql} from './source-reference-contract.js'
import type pg from 'pg'
import {hash,qi} from './source-maintenance-common.js'
import {EPISODE_PACKET_COMPILER_VERSION} from '../../episodes/packet.js'
import type {CleanupDependencies} from './forward-cleanup-state.js'

/** Only exact source UUIDs and the current versioned packet manifest are
 * authority. Strings in prose, hashes and another Session's raw rows are not. */
export interface ExactSourceClosure {version:2;referenceContractHash:string;episodeIds:string[];artifactIds:string[]}
const bound=1024
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const keys=new Set(['kind','evidence_role','source_event_id','artifact_id','occurred_at','excerpt_hash','excerpt_length','truncated','source_provenance','omitted'])
const extraChannels=['work_episodes.document','work_episodes.summary','memory_candidates.structured_content','memory_skill_archives.document']
export function exactReferenceChannels(){return [...new Set([...declaredReferenceRoster(),...retainedReferenceRoster(),...extraChannels])].sort()}
function referenceContractHash(){return hash({fields:SOURCE_REFERENCE_FIELDS,unreviewedSessionArrays:UNREVIEWED_SESSION_ARRAY_KEYS,channels:exactReferenceChannels(),classification:'exact-source-negative-v2'})}
/** Narrow v1 plans need the same metadata writer boundary as linked plans. */
export async function lockExactReferenceTables(c:pg.Client){
 const tables=[...new Set([...exactReferenceChannels().map(path=>path.split('.')[0]),'memory_promotion_candidates','memory_promotion_candidate_versions'])].sort()
 await c.query('LOCK TABLE '+tables.map(table=>'memory.'+qi(table)).join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')
}
async function assertNoUnreviewedReferences(c:pg.Client,d:CleanupDependencies,artifacts:string[],episodes:string[]){
 const variables=JSON.stringify({events:d.sourceEventIds,artifacts,episodes:[...new Set([...d.episodeIds,...episodes])],roots:d.roots})
 for(const path of exactReferenceChannels()){
  const [table,column]=path.split('.'),{from,owner}=referenceChannelSql(table)
  // These exact rows are removed by the original native source/Session policy,
  // or their packet manifests were validated by the typed adapter below.
  let exclude='true',ids:string[]|undefined
  if(table==='knowledge_evidence')exclude=`NOT EXISTS(SELECT 1 FROM memory.knowledge_evidence_capsules retained WHERE ${independentlyAcceptedEvidenceOwnershipSql('t','retained')})`
  if(table==='source_events'){exclude='NOT(t.source_event_id=ANY($2::uuid[]))';ids=d.sourceEventIds}
  if(table==='source_artifacts'){exclude='NOT(t.artifact_id=ANY($2::uuid[]))';ids=artifacts}
  if(table==='work_episodes'){exclude='NOT(t.episode_id=ANY($2::uuid[]))';ids=column==='evidence_manifest'?[...d.episodeIds,...episodes]:d.episodeIds}
  if(table==='memory_task_bundles'){exclude='NOT(t.bundle_id=ANY($2::uuid[]))';ids=d.bundleIds}
  const match=matchesSourceReferenceSql('t.'+qi(column),'$1::jsonb',owner)
  if((await c.query(`SELECT 1 FROM ${from} WHERE ${exclude} AND ${match} LIMIT 1`,[variables,...(ids?[ids]:[])])).rowCount)throw Error(table==='memory_task_bundles'?'cleanup_exact_source_cross_session_bundle_requires_policy':'cleanup_exact_source_unknown_reference_metadata:'+path)
 }
}
export async function discoverExactSources(c:pg.Client,d:CleanupDependencies,frozen?:ExactSourceClosure):Promise<ExactSourceClosure>{
 if(frozen&&frozen.version!==2)throw Error('cleanup_exact_source_policy_version_unsupported')
 const contractHash=referenceContractHash();if(frozen&&frozen.referenceContractHash!==contractHash)throw Error('cleanup_exact_source_reference_contract_drift')
 const artifactIds=[...new Set([...d.artifactIds,...(frozen?.artifactIds??[])])]
 const artifacts=(await c.query('SELECT a.artifact_id::text AS id,a.installation_id::text AS owner,e.installation_id::text AS source_owner FROM memory.source_artifacts a JOIN memory.source_events e USING(source_event_id) WHERE a.source_event_id=ANY($1::uuid[]) ORDER BY a.artifact_id LIMIT 1025',[d.sourceEventIds])).rows
 if(artifacts.some(r=>r.owner!==r.source_owner))throw Error('cleanup_exact_source_cross_owner_unproven')
 artifactIds.push(...artifacts.map(r=>r.id));const allArtifacts=[...new Set(artifactIds)].sort()
 if(allArtifacts.length>bound)throw Error('cleanup_exact_source_row_bound_exceeded:source_artifacts')
 if((await c.query('SELECT 1 FROM memory.knowledge_evidence WHERE episode_id IS NULL AND(source_event_id=ANY($1::uuid[]) OR artifact_id=ANY($2::uuid[])) LIMIT 1',[d.sourceEventIds,allArtifacts])).rowCount)throw Error('cleanup_exact_source_episodeless_evidence_requires_policy')
 if((await c.query(`SELECT 1 FROM memory.memory_task_bundle_sources s JOIN memory.memory_task_bundles b USING(installation_id,bundle_id) WHERE s.source_event_id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("installationId" uuid,"sessionId" text) WHERE b.installation_id=r."installationId" AND b.session_id=r."sessionId") LIMIT 1`,[d.sourceEventIds,JSON.stringify(d.roots)])).rowCount)throw Error('cleanup_exact_source_cross_session_bundle_requires_policy')
 const variables=JSON.stringify({events:d.sourceEventIds,artifacts:allArtifacts,episodes:[...new Set([...d.episodeIds,...(frozen?.episodeIds??[])])],roots:d.roots})
 // Only bounded positive typed candidates leave SQL. All other declared
 // reference channels are inspected server-side by the shared negative contract.
 const manifestMatch=matchesSourceReferenceSql('t.evidence_manifest','$4::jsonb','t.installation_id')
 const episodes=(await c.query(`SELECT t.installation_id::text,t.episode_id::text,t.evidence_manifest,t.document_compiler_version
 FROM memory.work_episodes t CROSS JOIN(SELECT $3::text AS policy_version) binding WHERE t.episode_id=ANY($1::uuid[]) OR EXISTS(SELECT 1 FROM memory.knowledge_evidence e WHERE e.installation_id=t.installation_id AND e.episode_id=t.episode_id AND(e.source_event_id=ANY($2::uuid[]) OR e.artifact_id=ANY($5::uuid[]))) OR EXISTS(SELECT 1 FROM memory.memory_skill_archives a JOIN memory.memory_skill_archive_sources s USING(installation_id,archive_id) WHERE a.installation_id=t.installation_id AND a.episode_id=t.episode_id AND(s.source_event_id=ANY($2::uuid[]) OR s.artifact_id=ANY($5::uuid[]))) OR ${manifestMatch}
 ORDER BY t.episode_id LIMIT 1025`,[frozen?.episodeIds??[],d.sourceEventIds,'exact-source-negative-v2',variables,allArtifacts])).rows
 if(episodes.length>bound)throw Error('cleanup_exact_source_row_bound_exceeded:work_episodes')
 const episodeIds=new Set(frozen?.episodeIds??[])
 for(const episode of episodes){
  if(d.episodeIds.includes(episode.episode_id))continue
  await assertExactSourceEpisode(c,d,allArtifacts,episode,Boolean(frozen))
  episodeIds.add(episode.episode_id)
 }
 if((await c.query('SELECT 1 FROM memory.work_episodes WHERE episode_id=ANY($1::uuid[]) GROUP BY episode_id HAVING count(*)>1 LIMIT 1',[[...d.episodeIds,...episodeIds]])).rowCount)throw Error('cleanup_exact_source_ambiguous_episode_owner')
 await assertNoUnreviewedReferences(c,d,allArtifacts,[...episodeIds])
 const result:ExactSourceClosure={version:2,referenceContractHash:contractHash,episodeIds:[...episodeIds].sort(),artifactIds:allArtifacts}
 if(frozen&&hash(result)!==hash(frozen))throw Error('cleanup_exact_source_dependency_drift')
 return result
}

/** Shared original typed packet/owner/provenance policy for bounded v4 pages. */
export async function assertExactSourceEpisode(c:pg.Client,d:CleanupDependencies,allArtifacts:string[],episode:{installation_id:string;episode_id:string;evidence_manifest:unknown;document_compiler_version:string|null},frozen=false){
  if(!d.installationIds.includes(episode.installation_id))throw Error('cleanup_exact_source_cross_owner_unproven')
  // Verify actual original source owner for JSON refs, not merely membership
  // of both installations in the same maintenance request.
  const manifest=episode.evidence_manifest
  if(!manifest||Array.isArray(manifest)||typeof manifest!=='object')throw Error('cleanup_exact_source_manifest_unparsed')
  const entries=Object.values(manifest) as Record<string,unknown>[]
  if(entries.some(e=>!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!keys.has(k))))throw Error('cleanup_exact_source_manifest_unparsed')
  if(entries.length&&episode.document_compiler_version!==EPISODE_PACKET_COMPILER_VERSION)throw Error('cleanup_exact_source_packet_version_unsupported')
  for(const entry of entries){
   if(entry.source_event_id!==undefined&&!uuid.test(String(entry.source_event_id))||entry.artifact_id!==undefined&&!uuid.test(String(entry.artifact_id))||entry.kind==='event'&&entry.artifact_id!==undefined||entry.kind==='episode'&&(entry.source_event_id!==undefined||entry.artifact_id!==undefined))throw Error('cleanup_exact_source_manifest_unparsed')
   if((entry.kind==='event'&&!entry.source_event_id)||(entry.kind==='artifact'&&!entry.artifact_id)||!['event','artifact','episode'].includes(String(entry.kind))||!['substantive','verification','auxiliary','outcome','omission'].includes(String(entry.evidence_role))||typeof entry.excerpt_hash!=='string'||!/^[a-f0-9]{64}$/.test(entry.excerpt_hash)||!Number.isSafeInteger(entry.excerpt_length)||typeof entry.truncated!=='boolean')throw Error('cleanup_exact_source_manifest_unparsed')
   if(entry.source_provenance&&hash(entry.source_provenance)!==hash({}))throw Error('cleanup_exact_source_provenance_requires_authority_adapter')
   if(entry.source_event_id&&d.sourceEventIds.includes(String(entry.source_event_id))||entry.artifact_id&&allArtifacts.includes(String(entry.artifact_id))){
    const owner=(await c.query(`SELECT installation_id::text FROM memory.source_events WHERE source_event_id=$1::uuid UNION ALL SELECT installation_id::text FROM memory.source_artifacts WHERE artifact_id=$2::uuid`,[entry.source_event_id??null,entry.artifact_id??null])).rows
    if(!owner.length&&!frozen)throw Error('cleanup_exact_source_reference_unproven')
    if(owner.some(r=>r.installation_id!==episode.installation_id))throw Error('cleanup_exact_source_cross_owner_unproven')
   }
  }
}
