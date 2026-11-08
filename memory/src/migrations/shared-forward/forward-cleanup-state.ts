import {discoverExactSources,lockExactReferenceTables} from './forward-exact-source.js'
import {discoverLinkedClosure,assertLinkedClosure,linkedPredicate,linkedOperationalPredicate,type LinkedCleanupClosure} from './forward-cleanup-linked.js'
import type pg from 'pg'
import {TABLE_POLICY} from '../shared-source/table-policy.js'
import {hash,qi} from './source-maintenance-common.js'
export interface CleanupRoot {installationId:string;sessionId:string}
export interface CleanupDependencies {roots:CleanupRoot[];installationIds:string[];broadIds:string[];sourceEventIds:string[];artifactIds:string[];episodeIds:string[];candidateIds:string[];packIds:string[];injectionIds:string[];bundleIds:string[];linked?:LinkedCleanupClosure}
export interface CleanupTableState {table:string;rows:number;bytes:number;fingerprint:string}
const maximumRows=1024,maximumBytes=8*1024*1024
/** Discover exact Session roots, then admit the bounded positive Claim/Skill
 * closure when needed. Legacy narrow manifests keep the live exclusion proof.
 * Unrelated source bodies are never selected or globally hashed. */
export async function discoverCleanupDependencies(c:pg.Client,roots:CleanupRoot[],installationIds:string[],broadIds:string[]):Promise<CleanupDependencies>{
 const selected=JSON.stringify(roots),scope=`EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.session_id=r."sessionId")`
 if((await c.query('SELECT 1 FROM memory.source_events t JOIN jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) ON t.installation_id=r."installationId" AND t.canonical_session_key=r."sessionId" WHERE t.session_id IS DISTINCT FROM r."sessionId" LIMIT 1',[selected])).rowCount)throw Error('cleanup_canonical_alias_requires_exact_uuid_adapter')
 async function ids(table:string,key:string){const rows=(await c.query(`SELECT t.${qi(key)}::text AS id FROM memory.${qi(table)} t WHERE ${scope} ORDER BY t.${qi(key)} LIMIT 1025`,[selected])).rows;if(rows.length>maximumRows)throw Error('cleanup_single_page_dependency_bound_exceeded');return rows.map(r=>r.id as string)}
 const sourceEventIds=await ids('source_events','source_event_id'),artifactIds=await ids('source_artifacts','artifact_id'),episodeIds=await ids('work_episodes','episode_id'),packIds=await ids('memory_context_packs','pack_id'),bundleIds=await ids('memory_task_bundles','bundle_id')
 const injectionIds=(await c.query('SELECT injection_id::text AS id FROM memory.memory_context_injections WHERE pack_id=ANY($1::uuid[]) ORDER BY injection_id LIMIT 1025',[packIds])).rows.map(r=>r.id as string)
 if(injectionIds.length>maximumRows)throw Error('cleanup_single_page_dependency_bound_exceeded')
 const candidateIds=(await c.query('SELECT candidate_id::text AS id FROM memory.memory_candidates WHERE episode_id=ANY($1::uuid[]) ORDER BY candidate_id LIMIT 1025',[episodeIds])).rows.map(r=>r.id as string)
 if(candidateIds.length>maximumRows)throw Error('cleanup_single_page_dependency_bound_exceeded')
 const dependencies={roots,installationIds,broadIds,sourceEventIds,artifactIds,episodeIds,candidateIds,packIds,injectionIds,bundleIds}
 const linked=await discoverLinkedClosure(c,dependencies)
 const narrow=new Set('source_sessions source_events source_turns source_artifacts work_episodes memory_candidates memory_extraction_runs memory_task_bundles memory_task_bundle_sources memory_source_processing_receipts memory_source_retention_receipts memory_session_scene_frames memory_feed_inbox memory_snapshot_events memory_context_packs memory_context_pack_items memory_context_pack_evidence memory_context_injections memory_context_feedback memory_context_evidence_reads memory_feedback'.split(' '))
 if(linked.version===3||Object.keys(linked.rows).some(table=>!narrow.has(table)))return {...dependencies,linked}
 await assertCleanupDependencyExclusions(c,dependencies)
 return dependencies
}
/** Negative dependency facts are an authorization input, not a one-time
 * planning optimization. Lock the actual referenced child tables before the
 * last live check so FK cascades cannot widen a reviewed raw-only mutation. */
export async function assertCleanupDependencyExclusions(c:pg.Client,d:CleanupDependencies,locked=false){
 if(d.linked){await assertLinkedClosure(c,d,locked);return}
 if(locked)await lockExactReferenceTables(c)
 if(locked)await c.query('LOCK TABLE memory.knowledge_evidence,memory.memory_skill_archive_sources,memory.memory_skill_archives,memory.memory_skill_task_runs,memory.memory_skill_replay_cases,memory.memory_skill_replay_runs,memory.memory_git_snapshot_sources IN SHARE ROW EXCLUSIVE MODE NOWAIT')
 const {episodeIds,sourceEventIds,artifactIds}=d
 if((await c.query('SELECT 1 FROM memory.knowledge_evidence WHERE episode_id=ANY($1::uuid[]) OR source_event_id=ANY($2::uuid[]) OR artifact_id=ANY($3::uuid[]) LIMIT 1',[episodeIds,sourceEventIds,artifactIds])).rowCount)throw Error('cleanup_session_knowledge_dependency_requires_paged_adapter')
 if((await c.query('SELECT 1 FROM memory.memory_skill_archive_sources WHERE source_event_id=ANY($1::uuid[]) OR artifact_id=ANY($2::uuid[]) UNION ALL SELECT 1 FROM memory.memory_skill_archives WHERE episode_id=ANY($3::uuid[]) UNION ALL SELECT 1 FROM memory.memory_skill_task_runs WHERE episode_id=ANY($3::uuid[]) LIMIT 1',[sourceEventIds,artifactIds,episodeIds])).rowCount)throw Error('cleanup_session_skill_dependency_requires_paged_adapter')
 if((await c.query('SELECT 1 FROM memory.memory_skill_replay_cases t WHERE EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.session_id=r."sessionId") LIMIT 1',[JSON.stringify(d.roots)])).rowCount)throw Error('cleanup_session_skill_replay_dependency_requires_bounded_adapter')
 if((await c.query('SELECT 1 FROM memory.memory_git_snapshot_sources WHERE episode_id=ANY($1::uuid[]) LIMIT 1',[episodeIds])).rowCount)throw Error('cleanup_session_git_dependency_requires_bounded_adapter')
 const exact=await discoverExactSources(c,d);if(exact.episodeIds.length||exact.artifactIds.some(id=>!d.artifactIds.includes(id)))throw Error('cleanup_exact_source_new_policy_requires_new_plan')
}
/** Fixed roster + exact relational predicates. Known tables outside the proven
 * mutation surface are classified preserve-untouched, never body-scanned.
 * Existing policy/native triggers own mutations; unknown future tables refuse. */
export async function cleanupState(c:pg.Client,d:CleanupDependencies,locked=false):Promise<CleanupTableState[]>{
 const catalog=(await c.query(`SELECT c.relname AS table,array_agg(a.attname ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='memory' AND c.relkind IN('r','p') GROUP BY c.relname ORDER BY c.relname`)).rows as {table:string;columns:string[]}[]
 if(!catalog.length||catalog.length>256||catalog.some(t=>!Object.hasOwn(TABLE_POLICY,t.table)))throw Error('cleanup_dependency_schema_unreviewed')
 const roots=`EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.session_id=r."sessionId")`
 const sourceTables=new Set(['source_sessions','source_events','source_turns','source_artifacts','work_episodes','memory_feed_inbox','memory_snapshot_events','memory_source_retention_receipts','memory_source_processing_receipts','memory_session_scene_frames','memory_task_bundles','memory_context_packs','memory_session_tombstones'])
 const result:CleanupTableState[]=[];let rows=0,bytes=0
 for(const {table,columns} of catalog){
  let predicate='false'
  if(sourceTables.has(table))predicate=roots
  if(table==='source_events')predicate=`(${roots} OR t.source_event_id=ANY($4::uuid[]) OR EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.canonical_session_key=r."sessionId"))`
  if(['memory_candidates','memory_extraction_runs'].includes(table))predicate='t.episode_id=ANY($5::uuid[])'
  if(table==='memory_task_bundle_sources')predicate='t.bundle_id=ANY($8::uuid[])'
  if(['memory_context_pack_items','memory_context_pack_evidence','memory_context_injections','memory_context_feedback','memory_context_evidence_reads'].includes(table))predicate='t.pack_id=ANY($7::uuid[])'
  if(table==='memory_context_feedback')predicate='t.pack_id=ANY($7::uuid[]) OR t.injection_id=ANY($9::uuid[])'
  if(table==='memory_feedback')predicate=`t.installation_id=ANY($2::uuid[]) AND(t.details->>'session_id'=ANY(ARRAY(SELECT r."sessionId" FROM jsonb_to_recordset($1::jsonb) r("sessionId" text))) OR t.candidate_id=ANY($6::uuid[]))`
  if(table==='memory_generation_runs')predicate=`t.installation_id=ANY($2::uuid[]) AND((operation='compile_context' AND subject_kind='session' AND subject_key_hash=ANY(ARRAY(SELECT decode(md5(r."sessionId"),'hex') FROM jsonb_to_recordset($1::jsonb) r("sessionId" text)))) OR t.installation_id=ANY($3::uuid[]))`
  if(['memory_installations','memory_owner_scopes','memory_scope_memberships','memory_scope_consumption_generations'].includes(table))predicate='t.installation_id=ANY($2::uuid[])'
  // Config/member/lifecycle effects are wider, but only their actual native
  // Skill/Git/Context operational surface is admitted, with a hard row bound.
  if(columns.includes('installation_id')&&(table.startsWith('memory_skill_')||table.startsWith('memory_git_')||table.startsWith('memory_context_')||/policy|settings|consent|budget|attempt|usage_outbox/.test(table)))predicate=`(${predicate}) OR t.installation_id=ANY($3::uuid[])`
  if(table==='memory_generation_run_policies')predicate='t.run_id IN(SELECT run_id FROM memory.memory_generation_runs WHERE installation_id=ANY($3::uuid[]))'
  if(table==='memory_scope_tombstones')predicate='EXISTS(SELECT 1 FROM memory.memory_owner_scopes o WHERE o.installation_id=ANY($2::uuid[]) AND(o.owner_scope_kind,o.owner_scope_id)=(t.owner_scope_kind,t.owner_scope_id))'
  // All known outside-surface tables are represented in the schema roster,
  // but no unrelated body or global signer/budget material is serialized.
  if(d.linked){
   predicate=`(${predicate}) OR (${linkedPredicate(table,d.linked)}) OR (${linkedOperationalPredicate(table,d.linked)})`
   if(table==='work_episodes')predicate+=` OR t.episode_id=ANY(ARRAY(SELECT jsonb_array_elements_text($10::jsonb->'supportEpisodeIds'))::uuid[])`
   if(table==='knowledge_tombstones')predicate=`EXISTS(SELECT 1 FROM jsonb_to_recordset($10::jsonb->'tombstones') r(installation_id uuid,key_id text,identity_hmac bytea) WHERE (t.installation_id,t.key_id,t.identity_hmac)=(r.installation_id,r.key_id,r.identity_hmac))`
   if(table==='memory_jobs')predicate+=` OR(t.installation_id=ANY($2::uuid[]) AND t.idempotency_key=ANY(ARRAY(SELECT jsonb_array_elements_text($10::jsonb->'jobKeys'))))`
  }
  const params=[JSON.stringify(d.roots),d.installationIds,d.broadIds,d.sourceEventIds,d.episodeIds,d.candidateIds,d.packIds,d.bundleIds,d.injectionIds,...(d.linked?[JSON.stringify(d.linked)]:[])]
  // Typed CTE parameters keep all commands structurally identical and avoid
  // accidental unknown-type inference in predicates using only some bindings.
  const bindings='WITH bindings AS(SELECT $1::jsonb,$2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[],$6::uuid[],$7::uuid[],$8::uuid[],$9::uuid[]'+(d.linked?',$10::jsonb':'')+') '
  if(locked&&predicate!=='false')await c.query('LOCK TABLE memory.'+qi(table)+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')
  const r=(await c.query(bindings+`SELECT count(*)::int AS rows,COALESCE(sum(octet_length(row)),0)::text AS bytes,encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(row,'UTF8')),'hex'),'' ORDER BY encode(sha256(convert_to(row,'UTF8')),'hex')),''),'UTF8')),'hex') AS fingerprint FROM(SELECT to_jsonb(t)::text AS row FROM memory.${qi(table)} t WHERE ${predicate} LIMIT 1025) bounded`,params)).rows[0]
  rows+=r.rows;bytes+=Number(r.bytes);if(rows>maximumRows||bytes>maximumBytes)throw Error('cleanup_single_page_dependency_bound_exceeded')
  result.push({table,rows:r.rows,bytes:Number(r.bytes),fingerprint:hash([columns,r.fingerprint])})
 }
 return result
}
