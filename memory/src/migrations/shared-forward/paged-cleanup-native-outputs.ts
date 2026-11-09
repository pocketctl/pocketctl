import type pg from 'pg'
import {pagedHash,type PagedCleanupPart} from './paged-cleanup-manifest.js'
import {pagedRelation} from './paged-cleanup-receipts.js'
import type {observePagedPart} from './paged-cleanup-state.js'
type Observed=Awaited<ReturnType<typeof observePagedPart>>
/** Called only after the exhaustive Memory table locks. The sequence boundary
 * includes native EXCEPTION subtransactions; xmin/top-XID is not an effects
 * ledger. Sequence state is never changed or reset by maintenance. */
export async function nativeOutputBoundary(c:pg.Client):Promise<string>{
 return (await c.query('SELECT COALESCE(max(sequence),0)::text AS sequence FROM memory.memory_governance_migration_changes')).rows[0].sequence
}
export async function observeNativeOutputs(c:pg.Client,page:PagedCleanupPart,boundary:string,after:Observed){
 const rows=(await c.query(`SELECT sequence::text,installation_id::text,entity_kind,
  (SELECT jsonb_object_agg(key,value#>>'{}') FROM jsonb_each(entity_id::jsonb)) AS entity_key,
  xmin::text AS version,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,
  octet_length(to_jsonb(t)::text)::text AS bytes
  FROM memory.memory_governance_migration_changes t WHERE sequence>$1::bigint ORDER BY sequence LIMIT 1025`,[boundary])).rows
 if(rows.length>1024)throw Error('paged_native_effect_capacity')
 return rows.map(row=>{
  const admitted=after.some((item,i)=>item.table===row.entity_kind&&pagedHash(item.actual?.key??item.key)===pagedHash(row.entity_key)&&
   (page.records[i].references.installation_id??page.root.installationId)===row.installation_id)
  if(!admitted)throw Error('paged_native_output_unbound')
  const key={sequence:row.sequence as string}
  return {kind:'native_governance',table:'memory_governance_migration_changes',key,actual:{key,version:row.version as string,fingerprint:row.fingerprint as string,bytes:row.bytes as string}}
 })
}
/** Authenticate exact observed output PKs on every resume and readonly verify.
 * Rows contain only hashes, identities and counts; audit prose is never read. */
export async function assertNativeOutputState(c:pg.Client,planHash:string){
 if((await c.query(`SELECT 1 FROM ${pagedRelation('receipts')} r CROSS JOIN LATERAL jsonb_array_elements(r.outputs) o
  LEFT JOIN memory.memory_governance_migration_changes t ON t.sequence=(o->'actual'->'key'->>'sequence')::bigint
  WHERE r.plan_hash=$1 AND o->>'kind'='native_governance' AND(t.sequence IS NULL OR t.xmin::text IS DISTINCT FROM o->'actual'->>'version'
   OR encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') IS DISTINCT FROM o->'actual'->>'fingerprint') LIMIT 1`,[planHash])).rowCount)throw Error('paged_native_output_drift')
}
