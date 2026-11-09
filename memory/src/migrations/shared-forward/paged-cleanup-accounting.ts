import type pg from 'pg'
import type {PagedCleanupHeader,PagedCleanupRecord} from './paged-cleanup-manifest.js'
import {pagedRelation} from './paged-cleanup-receipts.js'
import {qi} from './source-maintenance-common.js'
const tables=['memory_generation_runs','memory_extraction_runs','memory_skill_task_runs'] as const
const hashSql="encode(sha256(convert_to((to_jsonb(t)-ARRAY['state','error_code','completed_at'])::text,'UTF8')),'hex')"
const errorHashSql="encode(sha256(convert_to(to_jsonb(t.error_code)::text,'UTF8')),'hex')"
/** Only native terminal state/time/error transitions are mutable. All original
 * fee, provider, lineage, reservation, request identity and output links stay
 * exact. A pre-existing error (including uncertain provider result) is also
 * immutable; a newly assigned cancellation reason is allowed only from NULL. */
export async function bindPagedAccounting(c:pg.Client,records:PagedCleanupRecord[]){
 const retainedEpisodes=new Set(records.filter(r=>r.table==='work_episodes'&&r.retainReason==='incurred_effect').map(r=>r.key.episode_id))
 for(const table of tables){
  const selected=records.filter(row=>row.table===table&&(table!=='memory_skill_task_runs'||retainedEpisodes.has(row.references.episode_id)))
  if(!selected.length)continue
  const rows=(await c.query(`SELECT run_id::text,${hashSql} AS accounting_hash,${errorHashSql} AS error_hash FROM memory.${qi(table)} t WHERE t.run_id=ANY($1::uuid[])`,[selected.map(r=>r.key.run_id)])).rows
  if(rows.length!==selected.length)throw Error('paged_accounting_identity_unproved')
  const byId=new Map(rows.map(row=>[row.run_id,row]))
  for(const row of selected){const state=byId.get(row.key.run_id)!;row.references.accounting_hash=state.accounting_hash;if(state.error_hash)row.references.accounting_error_hash=state.error_hash}
 }
}
export async function assertPagedAccounting(c:pg.Client,header:PagedCleanupHeader){
 for(const table of tables)if((await c.query(`SELECT 1 FROM ${pagedRelation('items')} i LEFT JOIN memory.${qi(table)} t ON t.run_id=(i.original->'key'->>'run_id')::uuid
  WHERE i.plan_hash=$1 AND i.table_name=$2 AND i.original->'references'?'accounting_hash' AND(t.run_id IS NULL
   OR ${hashSql} IS DISTINCT FROM i.original->'references'->>'accounting_hash'
   OR i.original->'references'?'accounting_error_hash' AND ${errorHashSql} IS DISTINCT FROM i.original->'references'->>'accounting_error_hash') LIMIT 1`,[header.manifestHash,table])).rowCount)throw Error('paged_accounting_invariant_drift')
}
