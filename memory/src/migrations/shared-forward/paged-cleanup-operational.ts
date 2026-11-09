import {pagedRelation} from './paged-cleanup-receipts.js'
import type {PagedCleanupHeader} from './paged-cleanup-manifest.js'
import type pg from 'pg'
import type {PagedCleanupRecord} from './paged-cleanup-manifest.js'
import type {PagedCatalog} from './paged-cleanup-catalog.js'
import type {PagedRoot} from './paged-cleanup-authority.js'
import {selectPagedRows,tableShape} from './paged-cleanup-state.js'
import {bindPagedAccounting} from './paged-cleanup-accounting.js'
export const contextGenerationPredicate=(alias='t')=>`${alias}.installation_id=$1 AND ${alias}.operation='compile_context' AND ${alias}.subject_kind='session' AND ${alias}.subject_key_hash=decode(md5($2),'hex')`
export async function pagedContextGenerationRows(c:pg.Client,catalog:PagedCatalog,root:PagedRoot,cursor:Record<string,string|null>|null,limit=128){
 const rows=await selectPagedRows(c,tableShape(catalog,'memory_generation_runs'),contextGenerationPredicate(),[root.installationId,root.sessionId],cursor,limit)
 if(!rows.length)return {rows,records:[] as PagedCleanupRecord[]}
 const ids=rows.map(r=>r.key.run_id!)
 // Native compiler.ts uses md5(Session) as the subject identity. A currently
 // ambiguous hash cannot be treated as evidence that another owner is absent.
 if((await c.query(`SELECT 1 FROM memory.source_sessions WHERE installation_id=$1 AND session_id<>$2 AND md5(session_id)=md5($2)
  UNION ALL SELECT 1 FROM public.sessions s JOIN public.extension_installations i ON i.installation_id=$1 AND i.owner_user_id=s.user_id WHERE s.session_id<>$2 AND md5(s.session_id)=md5($2) LIMIT 1`,[root.installationId,root.sessionId])).rowCount)throw Error('paged_context_subject_ambiguous')
 if((await c.query('SELECT 1 FROM memory.memory_generation_runs WHERE run_id=ANY($1::uuid[]) AND(job_id IS NOT NULL OR output_kind IS NOT NULL OR output_id IS NOT NULL) LIMIT 1',[ids])).rowCount)throw Error('paged_context_job_output_adapter_required')
 await assertContextOperationalLinks(c,root,ids)
 const records:PagedCleanupRecord[]=rows.map(r=>({...r,disposition:'invalidate',retainReason:'incurred_effect'}))
 const policies=await selectPagedRows(c,tableShape(catalog,'memory_generation_run_policies'),'t.run_id=ANY($1::uuid[])',[ids],null,1024)
 const outbox=await selectPagedRows(c,tableShape(catalog,'memory_usage_outbox'),"t.installation_id=$1 AND t.usage_id=ANY($2::text[])",[root.installationId,ids.map(id=>'generation:'+id)],null,1024)
 if(rows.length+policies.length+outbox.length>256)throw Error('paged_context_component_capacity')
 records.push(...policies,...outbox);await bindPagedAccounting(c,records)
 return {rows,records}
}
/** Known loose job references supplement native job_id/output_id/FK edges.
 * Only declared reference keys are inspected; no unrelated prose leaves SQL. */
export async function assertContextOperationalLinks(c:pg.Client,root:PagedRoot,ids:string[]){
 if((await c.query(`SELECT 1 FROM memory.memory_jobs j CROSS JOIN LATERAL jsonb_path_query(j.payload,'strict $.** ? (@.type() == "object")') object
  CROSS JOIN LATERAL jsonb_each(object) field CROSS JOIN LATERAL jsonb_path_query(field.value,'strict $.**') handle
  WHERE j.installation_id=$1 AND(field.key=ANY(ARRAY['session_id','sessionId','session_ids','sessionIds']) AND handle#>>'{}'=$2
   OR field.key=ANY(ARRAY['run_id','runId','run_ids','runIds','generation_run_id','generationRunId','generation_run_ids','generationRunIds']) AND lower(handle#>>'{}')=ANY($3::text[])) LIMIT 1`,[root.installationId,root.sessionId,ids])).rowCount)throw Error('paged_context_job_output_adapter_required')
}

export async function assertPagedContextCoverage(c:pg.Client,header:PagedCleanupHeader,roots:readonly PagedRoot[]){
 for(const root of roots){
  if((await c.query(`SELECT 1 FROM memory.memory_generation_runs t WHERE ${contextGenerationPredicate()} AND NOT EXISTS(SELECT 1 FROM ${pagedRelation('items')} i WHERE i.plan_hash=$3 AND i.table_name='memory_generation_runs' AND i.original->'key'->>'run_id'=t.run_id::text) LIMIT 1`,[root.installationId,root.sessionId,header.manifestHash])).rowCount)throw Error('paged_original_generation_row_drift')
  if((await c.query(`SELECT 1 FROM memory.memory_generation_runs t WHERE ${contextGenerationPredicate()} AND(job_id IS NOT NULL OR output_kind IS NOT NULL OR output_id IS NOT NULL) LIMIT 1`,[root.installationId,root.sessionId])).rowCount)throw Error('paged_context_job_output_adapter_required')
  // SQL keyset reads only current immutable IDs. No generation body or fee
  // changes are admitted by this scan; the accounting invariant is independent.
  let after:string|null=null
  for(;;){const ids:string[]=(await c.query(`SELECT t.run_id::text AS id FROM memory.memory_generation_runs t WHERE ${contextGenerationPredicate()} AND($3::uuid IS NULL OR t.run_id>$3::uuid) ORDER BY t.run_id LIMIT 128`,[root.installationId,root.sessionId,after])).rows.map(r=>r.id as string);if(!ids.length)break;await assertContextOperationalLinks(c,root,ids);after=ids.at(-1)!}
 }
}

/** Extraction cancellation is outside this adapter. Terminal uncertain rows
 * retain their exact original fee/error/linkage; active work must refuse. */
export async function assertPagedActiveExtractions(c:pg.Client,episodeIds:string[]){
 if(!episodeIds.length)return
 if((await c.query(`SELECT 1 FROM memory.memory_extraction_runs r
  LEFT JOIN memory.memory_generation_runs g ON g.run_id=r.generation_run_id
  WHERE r.episode_id=ANY($1::uuid[]) AND(r.state='running' OR g.state IN('queued','running'))
  UNION ALL SELECT 1 FROM memory.memory_generation_runs g JOIN memory.work_episodes e
   ON g.installation_id=e.installation_id AND g.subject_kind='episode' AND g.subject_key_hash=sha256(convert_to(e.episode_id::text,'UTF8'))
   WHERE e.episode_id=ANY($1::uuid[]) AND g.operation='extract_candidates' AND g.state IN('queued','running') LIMIT 1`,[episodeIds])).rowCount)throw Error('paged_active_extraction_adapter_required')
}
export async function assertPagedFrozenExtractions(c:pg.Client,header:PagedCleanupHeader){
 // Frozen IDs remain authoritative after legitimate parent deletion. Check
 // both original extraction links and exact native generation subject hashes.
 if((await c.query(`SELECT 1 FROM ${pagedRelation('items')} i JOIN memory.memory_extraction_runs r
   ON i.table_name='work_episodes' AND r.episode_id::text=i.original->'key'->>'episode_id'
   LEFT JOIN memory.memory_generation_runs g ON g.run_id=r.generation_run_id
   WHERE i.plan_hash=$1 AND(r.state='running' OR g.state IN('queued','running'))
  UNION ALL SELECT 1 FROM ${pagedRelation('items')} i JOIN memory.memory_generation_runs g
   ON i.table_name='work_episodes' AND g.installation_id::text=i.original->'references'->>'installation_id'
    AND g.subject_kind='episode' AND g.subject_key_hash=sha256(convert_to(i.original->'key'->>'episode_id','UTF8'))
   WHERE i.plan_hash=$1 AND g.operation='extract_candidates' AND g.state IN('queued','running') LIMIT 1`,[header.manifestHash])).rowCount)throw Error('paged_active_extraction_adapter_required')
}
