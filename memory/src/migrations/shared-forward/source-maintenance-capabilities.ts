import type pg from 'pg'
import {connectMaintenance,hash,type MaintenanceDatabase} from './source-maintenance-common.js'
export interface CrossDatabaseCapabilityProof {databaseOid:string;database:string;catalogHash:string;connect:boolean;capabilityHash:string|null}
/** A credential can have useful business capabilities through PUBLIC without
 * any pg_shdepend edge to its OID. Every other connectable database is inspected
 * using an independently identity-checked, server-read-only admin connection.
 * No table rows, function source, credentials or bodies are read. */
export async function inspectCrossDatabaseCapabilities(source:pg.Client,config:MaintenanceDatabase,oldRole:string,signal?:AbortSignal):Promise<CrossDatabaseCapabilityProof[]>{
 if(signal?.aborted)throw Error('maintenance_interrupted')
 const databases=(await source.query(`SELECT d.oid::text AS "databaseOid",d.datname AS database,encode(sha256(convert_to(ROW(d.datdba,d.datacl,d.datallowconn,d.datistemplate)::text,'UTF8')),'hex') AS "catalogHash",
  d.datallowconn AND has_database_privilege($1,d.oid,'CONNECT') AS connect FROM pg_database d WHERE d.datname<>current_database() ORDER BY d.oid`,[oldRole])).rows
 if(databases.length>128)throw Error('cross_database_review_scope_limit')
 const proof:CrossDatabaseCapabilityProof[]=[]
 for(const database of databases){
  if(signal?.aborted)throw Error('maintenance_interrupted')
  if(!database.connect){proof.push({...database,capabilityHash:null});continue}
  const url=new URL(config.url);url.pathname='/'+encodeURIComponent(database.database)
  const peer=await connectMaintenance({url:url.toString(),expected:{...config.expected,database:database.database,databaseOid:database.databaseOid}},true)
  try{
   await peer.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
   const capabilities=(await peer.client.query(`WITH role_identity AS(SELECT oid FROM pg_roles WHERE rolname=$1),business_schemas AS(
    SELECT oid FROM pg_namespace WHERE nspname NOT IN('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%')
    SELECT 'schema_create' AS kind,n.oid::text AS oid FROM business_schemas n,role_identity r WHERE has_schema_privilege(r.oid,n.oid,'CREATE')
    UNION ALL SELECT 'relation',c.oid::text FROM pg_class c JOIN business_schemas n ON n.oid=c.relnamespace CROSS JOIN role_identity r
     WHERE has_schema_privilege(r.oid,n.oid,'USAGE') AND ((c.relkind IN('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
      OR c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE'))
    UNION ALL SELECT 'privileged_routine',p.oid::text FROM pg_proc p JOIN business_schemas n ON n.oid=p.pronamespace CROSS JOIN role_identity r
     WHERE p.prosecdef AND has_schema_privilege(r.oid,n.oid,'USAGE') AND has_function_privilege(r.oid,p.oid,'EXECUTE')
    ORDER BY kind,oid LIMIT 2`,[oldRole])).rows
   if(capabilities.length)throw Error('old_memory_role_cross_database_public_capability')
   // Bind effective capability facts, not unrelated private object churn.
   // Every run rescans all business objects and column ACLs; any newly usable
   // object aborts, while inaccessible new objects cannot affect this role.
   const catalog={effectiveBusinessCapabilities:capabilities}
   proof.push({...database,capabilityHash:hash(catalog)})
  }catch(error){if((error as Error).message==='old_memory_role_cross_database_public_capability')throw error;throw Error('cross_database_dedication_unproven')}
  finally{await peer.client.query('ROLLBACK').catch(()=>{});await peer.close()}
 }
 return proof
}
/** NOINHERIT suppresses inherited privileges, not SET ROLE. PG16 introduced
 * per-membership SET options; older servers need conservative MEMBER closure. */
export async function memoryWriterReachabilitySql(c:pg.Client):Promise<string>{
 const version=Number((await c.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)
 const permission=version>=160000?'SET':'MEMBER'
 return `EXISTS(SELECT 1 FROM pg_roles capable WHERE (capable.oid=r.oid OR pg_has_role(r.oid,capable.oid,'${permission}')) AND (capable.rolsuper OR EXISTS(
  SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='memory' AND t.relkind IN('r','p') AND has_schema_privilege(capable.oid,n.oid,'USAGE')
   AND (has_table_privilege(capable.oid,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(capable.oid,t.oid,'INSERT,UPDATE')))))`
}
/** Shared by forward copy and overlay admission. No mutations, startup or DSN
 * fallback; caller supplies its already identity-checked admin connection. */
export async function assertTargetMemoryWritersFenced(c:pg.Client):Promise<void>{
 const writers=await memoryWriterReachabilitySql(c)
 if((await c.query(`SELECT 1 FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname<>current_user AND ${writers} LIMIT 1`)).rowCount)throw Error('target_writers_not_fenced')
 if((await c.query(`SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND (r.rolsuper OR ${writers}) LIMIT 1`)).rowCount)throw Error('target_memory_not_drained')
}
