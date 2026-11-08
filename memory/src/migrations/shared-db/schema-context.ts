import type pg from 'pg'
import {assertNativeInputStartCompatible} from './input-start-contract.js'
export type MemoryNamespace='public'|'memory'
const quoteLiteral=(value:string):string=>"E'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'"
export const quoteIdentifier=(value:string):string=>'"'+value.replaceAll('"','""')+'"'
/** Run before any schema DDL; a wrong default namespace must not construct a
 * second Memory ledger beside a shared target. */
export async function assertMemoryNamespace(db:Pick<pg.Pool,'query'>,namespace:MemoryNamespace,intent:'migrate'|'runtime-verify'='migrate'):Promise<void>{
 if(intent!=='migrate'&&intent!=='runtime-verify')throw Error('unsupported_memory_schema_intent')
 const state=(await db.query("SELECT to_regclass('shared.memory_source_contract') IS NOT NULL AS shared,to_regclass('memory.memory_schema_migrations') IS NOT NULL AS target,to_regclass('public.memory_schema_migrations') IS NOT NULL AS legacy")).rows[0]
 if(namespace==='public'&&(state.shared||state.target))throw new Error('shared_source_requires_memory_namespace')
 if(namespace==='memory'&&state.legacy)throw new Error('dual_memory_namespace_forbidden')
 if(state.shared){
  const versions=(await db.query("SELECT version,COALESCE(to_jsonb(contract)->>'input_start_version','0') AS input_start_version,COALESCE(to_jsonb(contract)->>'execution_version','0') AS execution_version,COALESCE(to_jsonb(contract)->>'control_version','0') AS control_version,COALESCE(to_jsonb(contract)->>'distribution_version','0') AS distribution_version,COALESCE(to_jsonb(contract)->>'shadow_version','0') AS shadow_version,COALESCE(to_jsonb(contract)->>'processing_pin_version','0') AS processing_pin_version,COALESCE(to_jsonb(contract)->>'mode_version','0') AS mode_version,COALESCE(to_jsonb(contract)->>'delivery_source_set_capture_version','0') AS delivery_source_set_capture_version FROM shared.memory_source_contract contract")).rows
  if(versions.length!==1||versions[0].version!==1)throw new Error('unsupported_shared_source_contract')
  if(!['0','1'].includes(versions[0].input_start_version))throw new Error('unsupported_shared_input_start_contract')
  if(!['0','1'].includes(versions[0].execution_version))throw new Error('unsupported_shared_execution_contract')
  if(!['0','1'].includes(versions[0].control_version))throw new Error('unsupported_shared_control_contract')
  if(!['0','1'].includes(versions[0].distribution_version))throw new Error('unsupported_shared_distribution_contract')
  if(!['0','1'].includes(versions[0].shadow_version))throw new Error('unsupported_shared_shadow_contract')
  if(!['0','1'].includes(versions[0].processing_pin_version))throw new Error('unsupported_shared_processing_pin_contract')
  if(!['0','1'].includes(versions[0].mode_version))throw new Error('unsupported_shared_mode_contract')
  if(!['0','1'].includes(versions[0].delivery_source_set_capture_version))throw new Error('unsupported_delivery_source_set_capture_contract')
 }
 // Runtime startup checks private native facts through its granted definer
 // readiness capability; migrators must reject lost history before any DDL.
 if(intent==='migrate')await assertNativeInputStartCompatible(db)
}
/** Only a migrator calls this. Never run from API/Worker startup in shared mode. */
export async function prepareMemorySchemaContext(client:pg.PoolClient,namespace:MemoryNamespace){
 const previous=(await client.query('SHOW search_path')).rows[0].search_path as string
 if(namespace==='memory'){
  await client.query('CREATE SCHEMA IF NOT EXISTS memory; CREATE SCHEMA IF NOT EXISTS shared')
  let extension=(await client.query("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'")).rows[0]
  if(!extension){await client.query('CREATE EXTENSION pg_trgm WITH SCHEMA shared');extension={nspname:'shared'}}
  if(extension.nspname!=='shared' && extension.nspname!=='memory')await client.query(`CREATE OR REPLACE FUNCTION memory.word_similarity(TEXT,TEXT) RETURNS REAL LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog,memory,shared AS ${quoteLiteral('SELECT '+quoteIdentifier(String(extension.nspname))+'.word_similarity($1,$2)')}`)
  await client.query('SET search_path=memory,shared,pg_catalog')
  return {previous,extensionSchema:String(extension.nspname)}
 }
 await client.query('SET search_path=public,pg_catalog')
 return {previous,extensionSchema:'public'}
}
/** Exact audited historical namespace assumptions only; never globally replace
 * public in a dump, SQL literal or function body. Legacy statements stay frozen. */
export function namespacedStatement(namespace:MemoryNamespace,version:number,sql:string,extensionSchema:string):string{
 if(namespace==='public')return sql
 if(version===53 || version===65)sql=sql.replaceAll("to_regclass('public.'||table_name)","to_regclass('memory.'||table_name)")
 if(sql.includes("to_regclass('public.'"))throw new Error('unreviewed_memory_namespace_statement')
 return sql.replace('document gin_trgm_ops',`document ${quoteIdentifier(extensionSchema)}.gin_trgm_ops`)
}
export async function pinMemoryFunctions(client:pg.PoolClient):Promise<void>{
 const functions=(await client.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p
   WHERE p.pronamespace='memory'::regnamespace AND p.prokind IN ('f','p') ORDER BY p.oid`)).rows
 for(const f of functions)await client.query(`ALTER ROUTINE memory.${quoteIdentifier(f.proname)}(${f.arguments}) SET search_path=pg_catalog,memory,shared`)
}
