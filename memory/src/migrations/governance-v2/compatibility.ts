import type pg from 'pg'
import {MEMORY_MIGRATIONS} from '../../schema.js'

/** Image contract, not an attestation or an authorization grant. This producer
 * follows the locked per-installation generation, maintaining bridge shadows
 * until Task26 authorizes the real data/index/control cutover.
 */
export const MEMORY_BRIDGE_COMPATIBILITY=Object.freeze({
 image_contract:'memory-governance-identity-v2',
 writer_capability:'identity_v2',
 read_identity_generations:Object.freeze([1,2]),
 write_identity_generations:Object.freeze([1,2]),
 automation_writes:false,
})
export const MEMORY_WRITER_STARTUP_OPTIONS='-c pocketctl.writer_capability=identity_v2 -c pocketctl.writer_identity_generation=adaptive'

export class MemoryRuntimeCompatibilityError extends Error{
 readonly code:string
 constructor(reason:'schema'|'writer_floor'|'identity_generation'|'writer_declaration'){
  super(`memory_runtime_incompatible:${reason}`)
  this.name='MemoryRuntimeCompatibilityError';this.code=this.message
 }
}

/** Read-only startup check before listeners/loops. Scope degradation/hold is not
 * a global readiness failure; unsupported persisted contracts are. No backfill,
 * automatic authority, state creation, model call or writer lease is implicit.
 */
export async function assertMemoryRuntimeCompatibility(pool:pg.Pool):Promise<void>{
 const client=await pool.connect()
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try{
   await client.query("SET LOCAL statement_timeout='5s'")
   const versions=(await client.query<{version:number}>('SELECT version FROM memory_schema_migrations')).rows.map(r=>Number(r.version))
   if(versions.length!==MEMORY_MIGRATIONS.length||versions.some(v=>!MEMORY_MIGRATIONS.some(m=>m.version===v)))throw new MemoryRuntimeCompatibilityError('schema')
   const floors=await client.query("SELECT 1 FROM memory_governance_v2_states WHERE writer_floor NOT IN('v1','bridge_v2','identity_v2') LIMIT 1")
   if(floors.rowCount)throw new MemoryRuntimeCompatibilityError('writer_floor')
   const generations=await client.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_governance_v2_states WHERE identity_generation NOT IN(1,2))
      OR EXISTS(SELECT 1 FROM knowledge_claims c JOIN memory_governance_v2_states s USING(installation_id)
       WHERE s.identity_generation=2 AND c.state='active' AND c.consumption_hold_reason IS NULL AND
       (c.identity_generation<>2 OR c.normalized_key_v2 IS NULL OR c.topic_key_v2 IS NULL OR c.duplicate_digest_v2 IS NULL))`)
   if(generations.rowCount)throw new MemoryRuntimeCompatibilityError('identity_generation')
   const declaration=(await client.query("SELECT current_setting('pocketctl.writer_capability',true) AS capability,current_setting('pocketctl.writer_identity_generation',true) AS generation")).rows[0]
   if(declaration.capability!=='identity_v2'||declaration.generation!=='adaptive')throw new MemoryRuntimeCompatibilityError('writer_declaration')
   const indexes=(await client.query<{relname:string;indisvalid:boolean;indisunique:boolean;definition:string;predicate:string}>(`SELECT c.relname,i.indisvalid,i.indisunique,
    pg_get_indexdef(i.indexrelid) AS definition,pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indexrelid IN(to_regclass('knowledge_claims_active_identity_v1_idx'),to_regclass('knowledge_claims_active_identity_v2_idx'))`)).rows
   if(indexes.length!==2||indexes.some(i=>!i.indisvalid||!i.indisunique||!i.definition.includes('ON public.knowledge_claims USING btree')
     ||!i.definition.includes(i.relname.endsWith('v1_idx')?'(installation_id, claim_type, scope_key, normalized_key, conflict_variant)':'(installation_id, duplicate_digest_v2, conflict_variant)')
     ||i.predicate!==`((state = 'active'::text) AND (identity_generation = ${i.relname.endsWith('v1_idx')?1:2}))`))throw new MemoryRuntimeCompatibilityError('identity_generation')
   await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}
 }finally{client.release()}
}
