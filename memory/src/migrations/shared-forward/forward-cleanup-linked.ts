import {discoverExactSources,type ExactSourceClosure} from './forward-exact-source.js'
import {assertIndependentAcceptedEvidence,independentlyAcceptedVersionSupportSql} from '../../claims/accepted-evidence-policy.js'
import type pg from 'pg'
import {hash,qi} from './source-maintenance-common.js'
import {sessionPurgeVersionIdentities} from '../../purge/repository.js'
import {tombstoneIdentityHmac} from '../../claims/tombstones.js'
import {identityTombstoneDomainV2} from '../../claims/identity.js'
import {TABLE_POLICY} from '../shared-source/table-policy.js'
import type {CleanupDependencies} from './forward-cleanup-state.js'

/** Identifiers only. Values are PostgreSQL text, preserving bigint precision.
 * The graph follows existing FK policy; it never treats an FK as permission to
 * issue a delete. Only the mature purge repository issues content mutations. */
type Ref=Record<string,string|null>
interface Shape {table:string;pk:string[];refs:string[]}
interface Edge {child:string;parent:string;childColumns:string[];parentColumns:string[];definition:string}
export interface LinkedCleanupClosure {version:2|3;exactSources?:ExactSourceClosure;schemaHash:string;rows:Record<string,Ref[]>;primaryKeys:Record<string,string[]>;ledgerFloor:string;claimIds:string[];versionIds:string[];supportEpisodeIds:string[];jobKeys:string[];removableCapsuleIds:string[];tombstones:{installation_id:string;key_id:string;identity_hmac:string}[]}
const limit=1024
// Explicit reviewed FK/DML surface. A new child family with matching rows is
// unresolved, even if a future migration adds it to TABLE_POLICY.
const surface=new Set(`source_sessions source_events source_turns source_artifacts work_episodes memory_candidates memory_extraction_runs memory_task_bundles memory_task_bundle_sources memory_source_processing_receipts memory_source_retention_receipts memory_session_scene_frames memory_feed_inbox memory_source_delivery_receipts memory_snapshot_events memory_context_packs memory_context_pack_items memory_context_pack_evidence memory_context_injections memory_context_feedback memory_context_evidence_reads memory_feedback memory_authority_records knowledge_claims knowledge_versions knowledge_evidence knowledge_evidence_capsules claim_search_documents memory_claim_lifecycle memory_claim_usage memory_context_loadout_items memory_curation_decisions memory_lifecycle_assessment_runs memory_lifecycle_maintenance_receipts memory_logical_claims memory_automation_authority_records memory_retrieval_candidates memory_version_retention_protections memory_skill_archives memory_skill_archive_sources memory_skill_tasks memory_skill_task_runs memory_skill_candidates memory_skills memory_skill_versions memory_skill_heads memory_skill_publication_heads memory_skill_review_decisions memory_skill_replay_runs memory_skill_replay_cases memory_skill_rollouts memory_skill_executions memory_generation_runs memory_generation_run_policies memory_provider_budget_reservations memory_usage_outbox memory_jobs memory_git_connections memory_git_actor_mappings memory_git_asset_bindings memory_git_snapshots memory_git_snapshot_assets memory_git_snapshot_sources memory_git_snapshot_keys memory_git_confirmed_bases memory_git_import_proposals memory_git_outbox memory_git_outbox_steps memory_git_revision_links memory_git_revision_evidence memory_git_runs memory_git_sync_principals memory_git_inbox memory_git_project_targets memory_git_governed_revisions memory_git_claim_authority memory_git_claim_authority_decisions memory_git_conflicts memory_git_review_decisions memory_git_import_outcomes memory_git_revision_reviews memory_git_proposal_runs memory_git_merge_receipts memory_git_retained_outcomes memory_git_retained_steps memory_git_original_authors memory_git_resolution_authors memory_git_project_setup_requests`.split(' '))
async function catalog(c:pg.Client,exact=false){
 const shapes=(await c.query(`SELECT r.relname AS table,
  ARRAY(SELECT a.attname::text FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.attnum WHERE p.conrelid=r.oid AND p.contype='p' ORDER BY k.n) AS pk,
  ARRAY(SELECT DISTINCT a.attname::text FROM pg_constraint f CROSS JOIN LATERAL unnest(f.confkey) k(attnum) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.attnum WHERE f.confrelid=r.oid AND f.contype='f' ORDER BY a.attname::text) AS refs
 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='memory' AND r.relkind IN('r','p') ORDER BY r.relname`)).rows as Shape[]
 if(shapes.some(s=>!Object.hasOwn(TABLE_POLICY,s.table)))throw Error('cleanup_dependency_schema_unreviewed')
 const identifiers=(await c.query("SELECT c.relname AS table,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND a.attnum>0 AND NOT a.attisdropped AND a.attname=ANY($1::text[]) ORDER BY c.relname,a.attname",[['version_id','task_id','generation','generation_run_id','job_id','connection_id','pack_id',...(exact?['budget_reservation_id']:[])]])).rows
 for(const shape of shapes)shape.refs=[...new Set([...shape.refs,...identifiers.filter(r=>r.table===shape.table).map(r=>r.attname)])].sort()
 const edges=(await c.query(`SELECT ch.relname AS child,p.relname AS parent,
 ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=ch.oid AND a.attnum=k.num ORDER BY k.n) AS "childColumns",
 ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.num ORDER BY k.n) AS "parentColumns",pg_get_constraintdef(f.oid) AS definition
 FROM pg_constraint f JOIN pg_class ch ON ch.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace n ON n.oid=ch.relnamespace WHERE f.contype='f' AND n.nspname='memory' ORDER BY ch.relname,f.conname`)).rows as Edge[]
 const triggers=(await c.query(`SELECT r.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='memory' AND NOT t.tgisinternal ORDER BY r.relname,t.tgname`)).rows
 const functions=(await c.query("SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memory' AND p.prokind IN('f','p') ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)")).rows
 const definitions=(await c.query("SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attgenerated,a.attidentity,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='memory' AND c.relkind IN('r','p') ORDER BY c.relname,a.attnum")).rows
 return {shapes,edges,schemaHash:hash({shapes,edges,triggers,functions,definitions})}
}
function projection(s:Shape){const cols=[...new Set([...s.pk,...s.refs])];if(!s.pk.length)throw Error('cleanup_linked_missing_primary_key');return `jsonb_build_object(${cols.flatMap(k=>[`'${k}'`,`t.${qi(k)}::text`]).join(',')})`}
function match(columns:string[],refColumns=columns){return columns.map((k,i)=>`t.${qi(k)}::text=r->>'${refColumns[i]}'`).join(' AND ')}
export function linkedPredicate(table:string,l:LinkedCleanupClosure){
 const rows=l.rows[table]??[]
 return rows.length?`EXISTS(SELECT 1 FROM jsonb_array_elements($10::jsonb->'rows'->'${table}') r WHERE ${l.primaryKeys[table].map(k=>`t.${qi(k)}::text IS NOT DISTINCT FROM r->>'${k}'`).join(' AND ')})`:'false'
}
/** Builds the exact affected closure under the caller's maintenance window.
 * Frozen references remain roots after deletion, so resume cannot lose a late
 * edge by rediscovering only currently existing parent rows. */
export async function discoverLinkedClosure(c:pg.Client,d:CleanupDependencies,frozen?:LinkedCleanupClosure,componentOnly=false):Promise<LinkedCleanupClosure>{
 const exactSources=componentOnly?{version:2 as const,referenceContractHash:hash([]),episodeIds:[],artifactIds:[]}:await discoverExactSources(c,d,frozen?.exactSources)
 const crossSource=componentOnly||exactSources.episodeIds.length>0||exactSources.artifactIds.some(id=>!d.artifactIds.includes(id))
 if(frozen&&crossSource&&frozen.version!==3)throw Error('cleanup_exact_source_new_policy_requires_new_plan')
 const episodeIds=[...new Set([...d.episodeIds,...exactSources.episodeIds])]
 const {shapes,edges,schemaHash}=await catalog(c,crossSource)
 if(frozen&&![2,3].includes(frozen.version))throw Error('cleanup_linked_manifest_version_unsupported')
 if(frozen&&schemaHash!==frozen.schemaHash)throw Error('cleanup_linked_schema_drift')
 const byTable=new Map(shapes.map(s=>[s.table,s])),rows:Record<string,Ref[]>=structuredClone(frozen?.rows??{}),seen=new Map<string,Set<string>>()
 const primaryKeys=Object.fromEntries(shapes.map(s=>[s.table,s.pk])),keyOf=(table:string,ref:Ref)=>hash(primaryKeys[table].map(k=>ref[k]))
 for(const [table,refs] of Object.entries(rows))seen.set(table,new Set(refs.map(r=>keyOf(table,r))))
 let total=Object.values(rows).reduce((n,v)=>n+v.length,0),changed=false
 async function add(table:string,predicate:string,params:unknown[]){
  const shape=byTable.get(table);if(!shape)throw Error('cleanup_linked_schema_unreviewed')
  const result=(await c.query(`SELECT ${projection(shape)} AS ref FROM memory.${qi(table)} t WHERE ${predicate} LIMIT 1025`,params)).rows
  if(result.length>limit)throw Error('cleanup_linked_dependency_row_bound_exceeded:'+table)
  for(const {ref} of result){const key=keyOf(table,ref);if(seen.get(table)?.has(key))continue
   if(!surface.has(table))throw Error('cleanup_linked_unreviewed_child:'+table)
   if(frozen)throw Error('cleanup_linked_dependency_drift:'+table)
   if(++total>limit)throw Error('cleanup_linked_dependency_row_bound_exceeded:'+table)
   const set=seen.get(table)??new Set<string>();set.add(key);seen.set(table,set);(rows[table]??=[]).push(ref);changed=true
  }
 }
 const claimIds=frozen?.claimIds??(await c.query('SELECT DISTINCT v.claim_id::text AS id FROM memory.knowledge_versions v JOIN memory.knowledge_evidence e USING(installation_id,version_id) WHERE e.episode_id=ANY($1::uuid[]) ORDER BY id LIMIT 1025',[episodeIds])).rows.map(r=>r.id as string)
 if(claimIds.length>limit)throw Error('cleanup_linked_dependency_row_bound_exceeded:knowledge_claims')
 if(!componentOnly)await add('source_sessions',`EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.session_id=r."sessionId")`,[JSON.stringify(d.roots)])
 await add('knowledge_claims','t.claim_id=ANY($1::uuid[])',[claimIds])
 for(const [table,key,ids] of [['source_events','source_event_id',d.sourceEventIds],['source_artifacts','artifact_id',exactSources.artifactIds],['work_episodes','episode_id',episodeIds],['memory_candidates','candidate_id',d.candidateIds],['memory_context_packs','pack_id',d.packIds],['memory_task_bundles','bundle_id',d.bundleIds]] as const)await add(table,`t.${qi(key)}=ANY($1::uuid[])`,[ids])
 // Explicit trigger reverse edges. These are not inferred as generic FK parents.
 for(let round=0;round<(frozen?1:32);round++){
  changed=false
  for(const e of edges){const refs=rows[e.parent];if(refs?.length)await add(e.child,`EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) r WHERE ${match(e.childColumns,e.parentColumns)})`,[JSON.stringify(refs)])}
  const sources=rows.memory_skill_archive_sources??[]
  if(sources.length)await add('memory_skill_archives',"t.archive_id::text=ANY(ARRAY(SELECT r->>'archive_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(sources)])
  const replayCases=rows.memory_skill_replay_cases??[]
  if(replayCases.length)await add('memory_skill_replay_runs',"t.run_id::text=ANY(ARRAY(SELECT r->>'run_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(replayCases)])
  const replayRuns=rows.memory_skill_replay_runs??[]
  if(replayRuns.length)await add('memory_git_snapshot_assets',"t.skill_version_id::text=ANY(ARRAY(SELECT r->>'version_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(replayRuns)])
  const evidence=rows.memory_context_pack_evidence??[]
  if(evidence.length)await add('memory_context_packs',"t.pack_id::text=ANY(ARRAY(SELECT r->>'pack_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(evidence)])
  const tasks=[...(rows.memory_skill_archives??[]),...(rows.memory_skill_task_runs??[])]
  // task_id/generation are trigger inputs and included below even when not FK targets.
  if(tasks.length)await add('memory_skill_tasks',"t.task_id::text=ANY(ARRAY(SELECT a.task_id::text FROM memory.memory_skill_archives a WHERE a.archive_id::text=ANY(ARRAY(SELECT r->>'archive_id' FROM jsonb_array_elements($1::jsonb) r)) UNION SELECT a.task_id::text FROM memory.memory_skill_task_runs a WHERE a.run_id::text=ANY(ARRAY(SELECT r->>'run_id' FROM jsonb_array_elements($1::jsonb) r))))",[JSON.stringify(tasks)])
  const git=[...(rows.memory_git_snapshot_sources??[]),...(rows.memory_git_asset_bindings??[]),...(rows.memory_git_snapshot_assets??[])]
  if(git.length)await add('memory_git_connections',"t.connection_id::text=ANY(ARRAY(SELECT r->>'connection_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(git)])
  const skillRuns=[...(rows.memory_skill_task_runs??[]),...(crossSource?(rows.memory_extraction_runs??[]):[])]
  if(skillRuns.length)await add('memory_generation_runs',"t.run_id::text=ANY(ARRAY(SELECT r->>'generation_run_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(skillRuns)])
  const attempts=[...(rows.memory_skill_task_runs??[]),...(rows.memory_extraction_runs??[])]
  if(crossSource&&attempts.length)await add('memory_provider_budget_reservations',"t.reservation_id::text=ANY(ARRAY(SELECT r->>'budget_reservation_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(attempts)])
  const generationEffects=rows.memory_generation_runs??[]
  if(crossSource&&generationEffects.length)await add('memory_usage_outbox',"EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) r WHERE t.installation_id::text=r->>'installation_id' AND t.usage_id='generation:'||(r->>'run_id'))",[JSON.stringify(generationEffects)])
  const jobs=[...(rows.memory_generation_runs??[]),...(rows.memory_git_runs??[])]
  if(jobs.length)await add('memory_jobs',"t.job_id::text=ANY(ARRAY(SELECT r->>'job_id' FROM jsonb_array_elements($1::jsonb) r))",[JSON.stringify(jobs)])
  const taskRefs=rows.memory_skill_task_runs??[]
  if(taskRefs.length)await add('memory_jobs',"t.job_type='extract_skill_candidate' AND EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) r WHERE t.installation_id::text=r->>'installation_id' AND t.payload->>'task_id'=r->>'task_id' AND t.payload->>'generation'=r->>'generation')",[JSON.stringify(taskRefs)])
  if(!changed)break
  if(round===31)throw Error('cleanup_linked_dependency_depth_exceeded')
 }
 const versionIds=(rows.knowledge_versions??[]).map(r=>r.version_id!)
 await assertIndependentAcceptedEvidence(c,versionIds,'memory')
 const supportEpisodeIds=frozen?.supportEpisodeIds??(await c.query('SELECT DISTINCT episode_id::text AS id FROM memory.knowledge_evidence WHERE version_id=ANY($1::uuid[]) AND episode_id IS NOT NULL ORDER BY id LIMIT 1025',[versionIds])).rows.map(r=>r.id as string)
 if(supportEpisodeIds.length>limit)throw Error('cleanup_linked_dependency_row_bound_exceeded:replacement_supports')
 for(const list of Object.values(rows))list.sort((a,b)=>hash(a).localeCompare(hash(b)))
 return {version:crossSource?3:2,...(crossSource?{exactSources}:{}),schemaHash,rows,primaryKeys,ledgerFloor:frozen?.ledgerFloor??(await c.query('SELECT COALESCE(max(sequence),0)::text AS floor FROM memory.memory_governance_migration_changes WHERE installation_id=ANY($1::uuid[])',[d.installationIds])).rows[0].floor,claimIds,versionIds,supportEpisodeIds,jobKeys:frozen?.jobKeys??[],tombstones:frozen?.tombstones??[],removableCapsuleIds:frozen?.removableCapsuleIds??[]}
}
export async function assertLinkedClosure(c:pg.Client,d:CleanupDependencies,locked=false){
 if(locked){
  const tables=(await c.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='memory' AND c.relkind IN('r','p') ORDER BY c.relname")).rows.map(r=>r.relname as string)
  if(!tables.length||tables.some(t=>!Object.hasOwn(TABLE_POLICY,t)))throw Error('cleanup_dependency_schema_unreviewed')
  await c.query('LOCK TABLE '+tables.map(t=>'memory.'+qi(t)).join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')
 }
 await discoverLinkedClosure(c,d,d.linked)
}

/** Exact prospective mature tombstone digests and idempotent reindex keys. */
export async function bindLinkedPolicyOutputs(c:pg.Client,l:LinkedCleanupClosure,d:CleanupDependencies,keys:readonly {version:string;key:string}[]){
 const claims=(await c.query('SELECT * FROM memory.knowledge_claims WHERE claim_id=ANY($1::uuid[])',[l.claimIds])).rows
 const versions=(await c.query('SELECT * FROM memory.knowledge_versions WHERE version_id=ANY($1::uuid[])',[l.versionIds])).rows
 const tombstones:LinkedCleanupClosure['tombstones']=[],jobKeys:string[]=[]
 for(const claim of claims){
  // The mature repository's dependency policy is Session specific. Include
  // each actual per-root removal descriptor, never fabricate a broader purge.
  if(l.exactSources?.episodeIds.length){
   const dependent=(await c.query(`SELECT v.* FROM memory.knowledge_versions v WHERE v.claim_id=$1 AND EXISTS(SELECT 1 FROM memory.knowledge_evidence e WHERE e.installation_id=v.installation_id AND e.version_id=v.version_id AND e.episode_id=ANY($2::uuid[])) AND NOT EXISTS(SELECT 1 FROM memory.knowledge_evidence e WHERE e.installation_id=v.installation_id AND e.version_id=v.version_id AND e.episode_id IS NOT NULL AND NOT(e.episode_id=ANY($2::uuid[]))) AND NOT ${independentlyAcceptedVersionSupportSql('memory')}`,[claim.claim_id,l.exactSources.episodeIds])).rows
   const identities=sessionPurgeVersionIdentities(claim,claim,claim.current_version_id,dependent as any)
   for(const identity of new Set([...identities.normalizedKeys,...identities.normalizedKeysV2.map(identityTombstoneDomainV2)]))for(const key of keys)tombstones.push({installation_id:claim.installation_id,key_id:key.version,identity_hmac:'\\x'+tombstoneIdentityHmac(identity,key.key).toString('hex')})
  }
  const previous:string[]=[]
  for(const root of d.roots.filter(r=>r.installationId===claim.installation_id)){
   const dependent=(await c.query(`SELECT v.* FROM memory.knowledge_versions v WHERE v.claim_id=$1 AND EXISTS(SELECT 1 FROM memory.knowledge_evidence e JOIN memory.work_episodes w USING(installation_id,episode_id) WHERE e.installation_id=v.installation_id AND e.version_id=v.version_id AND w.session_id=$2) AND NOT EXISTS(SELECT 1 FROM memory.knowledge_evidence e JOIN memory.work_episodes w USING(installation_id,episode_id) WHERE e.installation_id=v.installation_id AND e.version_id=v.version_id AND w.session_id<>$2 AND NOT(w.session_id=ANY($3::text[])) AND NOT(w.episode_id=ANY($4::uuid[]))) AND NOT ${independentlyAcceptedVersionSupportSql('memory')}`, [claim.claim_id,root.sessionId,previous,l.exactSources?.episodeIds??[]])).rows
   previous.push(root.sessionId)
   const identities=sessionPurgeVersionIdentities(claim,claim,claim.current_version_id,dependent as any)
   for(const identity of new Set([...identities.normalizedKeys,...identities.normalizedKeysV2.map(identityTombstoneDomainV2)]))for(const key of keys)tombstones.push({installation_id:claim.installation_id,key_id:key.version,identity_hmac:'\\x'+tombstoneIdentityHmac(identity,key.key).toString('hex')})
  }
  for(const v of versions.filter(v=>v.claim_id===claim.claim_id))jobKeys.push(`purge-reindex:${claim.claim_id}:${v.version_id}`)
 }
 if(Object.values(l.rows).reduce((n,r)=>n+r.length,0)*4+tombstones.length*2+jobKeys.length*2>limit)throw Error('cleanup_linked_policy_output_row_bound_exceeded')
 // Every proved capsule is independently owned; unproved capsules refused
 // during discovery. A Session purge has no capsule deletion exemption.
 l.removableCapsuleIds=[]
 l.tombstones=[...new Map(tombstones.map(r=>[hash(r),r])).values()].sort((a,b)=>hash(a).localeCompare(hash(b)));l.jobKeys=[...new Set(jobKeys)].sort()
}

export function linkedOperationalPredicate(table:string,l:LinkedCleanupClosure){
 if(table==='memory_governance_migration_changes')return `t.installation_id=ANY($2::uuid[]) AND t.sequence>($10::jsonb->>'ledgerFloor')::bigint`
 if(table==='memory_logical_tombstones')return `t.logical_key=ANY(ARRAY(SELECT r->>'logical_key' FROM jsonb_array_elements($10::jsonb->'rows'->'memory_logical_claims') r)) AND t.installation_id=ANY($2::uuid[])`
 if(['memory_git_tombstones','memory_git_lifecycle_epochs','memory_git_run_receipts','memory_git_projection_invalidations','memory_git_remote_cleanup','memory_git_retained_outcomes','memory_git_retained_steps','memory_git_audit_events','memory_git_proposal_identities','memory_git_original_authors','memory_git_resolution_authors'].includes(table))return `t.connection_id::text=ANY(ARRAY(SELECT r->>'connection_id' FROM jsonb_array_elements($10::jsonb->'rows'->'memory_git_connections') r))`
 return 'false'
}
