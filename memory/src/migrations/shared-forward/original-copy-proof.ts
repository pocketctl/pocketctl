import type pg from 'pg'
import {canonicalJsonString} from '@pocketctl/session-source'
import {assertFrozenMemorySource} from '../shared-source/maintenance.js'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {hash} from './source-maintenance-common.js'
export interface OriginalBindingCopyReceipt {
 schemaVersion:number;kind:string;verified:boolean;manifestHash:string;migrationId:string;sourceIdentity:string;targetIdentity:string
 sourceEvents:{sourceColumns:string[];rows:string;hash:string}
}
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
export function assertOriginalCopyReceipt(copy:OriginalBindingCopyReceipt){
 if(copy?.schemaVersion!==1||copy.kind!=='memory-forward-verification'||copy.verified!==true||!hex(copy.manifestHash)
  ||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(copy.migrationId)||!hex(copy.sourceIdentity)||!hex(copy.targetIdentity)
  ||!copy.sourceEvents||!hex(copy.sourceEvents.hash)||!/^\d+$/.test(copy.sourceEvents.rows)
  ||!Array.isArray(copy.sourceEvents.sourceColumns)||!copy.sourceEvents.sourceColumns.length||new Set(copy.sourceEvents.sourceColumns).size!==copy.sourceEvents.sourceColumns.length
  ||copy.sourceEvents.sourceColumns.some(c=>typeof c!=='string'||!c))throw Error('original_binding_input_invalid')
}
/** Shared physical copy proof, never a source-identity or access grant. */
export async function assertOriginalCopiedSource(source:pg.Client,target:pg.Client,copy:OriginalBindingCopyReceipt){
 assertOriginalCopyReceipt(copy)
 const admin=(await target.query("SELECT r.rolsuper,(a.xact_start=a.query_start) AS standalone FROM pg_roles r JOIN pg_stat_activity a ON a.pid=pg_backend_pid() WHERE r.rolname=current_user")).rows[0]
 if(!admin?.rolsuper||!admin.standalone)throw Error('original_binding_standalone_administrator_required')
 const identity=async(db:pg.Client)=>hash((await db.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",d.oid::text AS oid FROM pg_database d WHERE datname=current_database()`)).rows[0])
 if(await identity(source)!==copy.sourceIdentity||await identity(target)!==copy.targetIdentity||copy.sourceIdentity===copy.targetIdentity)throw Error('original_binding_database_mismatch')
 await assertFrozenMemorySource(source);await assertTargetMemoryWritersFenced(target)
 const checkpoint=(await target.query(`SELECT r.manifest_hash,t.row_count,t.row_hash FROM shared.memory_forward_runs r JOIN shared.memory_forward_tables t USING(migration_id) WHERE r.migration_id=$1 AND t.table_name='source_events'`,[copy.migrationId])).rows[0]
 if(!checkpoint||checkpoint.manifest_hash!==copy.manifestHash||checkpoint.row_count!==copy.sourceEvents.rows||checkpoint.row_hash!==copy.sourceEvents.hash)throw Error('original_binding_copy_unverified')
 const columns=(await source.query("SELECT attname FROM pg_attribute WHERE attrelid='public.source_events'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows.map(r=>r.attname as string)
 if(canonicalJsonString(columns)!==canonicalJsonString(copy.sourceEvents.sourceColumns))throw Error('original_binding_source_shape_changed')
 return columns
}
