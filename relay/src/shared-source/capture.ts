import {assertNativeInputStartCompatible} from './input-start.js'
import {RELAY_SESSION_CAPTURE_SQL} from './session-capture.js'
import type pg from 'pg'
import {RELAY_SOURCE_HEADER_SQL} from './header-contract.js'
import {RELAY_SOURCE_CAPTURE_SQL} from './capture-contract.js'
/** Validate every known subcontract before any Relay schema initialization. */
export async function assertRelayCaptureMigrationCompatible(db:Pick<pg.Pool,'query'>){
 const versions=(await db.query("SELECT version,COALESCE(to_jsonb(contract)->>'input_start_version','0') AS input_start_version,COALESCE(to_jsonb(contract)->>'capture_version','0') AS capture_version,COALESCE(to_jsonb(contract)->>'header_version','0') AS header_version,COALESCE(to_jsonb(contract)->>'team_capture_version','0') AS team_capture_version,COALESCE(to_jsonb(contract)->>'session_capture_version','0') AS session_capture_version,COALESCE(to_jsonb(contract)->>'delivery_privacy_capture_version','0') AS delivery_privacy_capture_version,COALESCE(to_jsonb(contract)->>'control_capture_version','0') AS control_capture_version,COALESCE(to_jsonb(contract)->>'control_version','0') AS control_version,COALESCE(to_jsonb(contract)->>'distribution_version','0') AS distribution_version,COALESCE(to_jsonb(contract)->>'shadow_version','0') AS shadow_version,COALESCE(to_jsonb(contract)->>'processing_pin_version','0') AS processing_pin_version,COALESCE(to_jsonb(contract)->>'mode_version','0') AS mode_version,COALESCE(to_jsonb(contract)->>'delivery_source_set_capture_version','0') AS delivery_source_set_capture_version FROM shared.memory_source_contract contract")).rows
 if(versions.length!==1||versions[0].version!==1)throw Error('unsupported_shared_source_contract')
 if(!['0','1'].includes(versions[0].input_start_version))throw Error('unsupported_shared_input_start_contract')
 if(versions[0].input_start_version==='1')await assertNativeInputStartCompatible(db)
 if(!['0','1','2'].includes(versions[0].capture_version))throw Error('unsupported_shared_capture_contract')
 if(!['0','1'].includes(versions[0].header_version))throw Error('unsupported_shared_header_contract')
 if(!['0','1'].includes(versions[0].delivery_privacy_capture_version))throw Error('unsupported_delivery_privacy_capture_contract')
 if(!['0','1'].includes(versions[0].session_capture_version))throw Error('unsupported_shared_session_capture_contract')
 if(!['0','1'].includes(versions[0].team_capture_version))throw Error('unsupported_shared_team_capture_contract')
 if(!['0','1'].includes(versions[0].control_capture_version))throw Error('unsupported_shared_control_capture_contract')
 if(!['0','1'].includes(versions[0].control_version))throw Error('unsupported_shared_control_contract')
 if(!['0','1'].includes(versions[0].distribution_version))throw Error('unsupported_shared_distribution_contract')
 if(!['0','1'].includes(versions[0].shadow_version))throw Error('unsupported_shared_shadow_contract')
 if(!['0','1'].includes(versions[0].processing_pin_version))throw new Error('unsupported_shared_processing_pin_contract')
 if(!['0','1'].includes(versions[0].mode_version))throw Error('unsupported_shared_mode_contract')
 if(!['0','1'].includes(versions[0].delivery_source_set_capture_version))throw Error('unsupported_delivery_source_set_capture_contract')
}
/** Explicit migrator only; normal standalone legacy startup never installs it. */
export async function applyRelaySourceCapture(pool:pg.Pool):Promise<void>{
 const c=await pool.connect()
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'")
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-source-contract-v1',0))")
  await assertRelayCaptureMigrationCompatible(c as unknown as pg.Pool)
  for(const sql of [...RELAY_SOURCE_HEADER_SQL,...RELAY_SOURCE_CAPTURE_SQL,...RELAY_SESSION_CAPTURE_SQL])await c.query(sql)
  await c.query('COMMIT')
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export async function bootstrapRelaySourceRoots(pool:pg.Pool,options:{afterSessionRowId:string;limit:number}):Promise<{roots:{rootKey:string;revision:string}[];nextAfterSessionRowId:string}>{
 if(!/^(0|[1-9][0-9]*)$/.test(options.afterSessionRowId)||BigInt(options.afterSessionRowId)>9223372036854775807n||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>256)throw Error('invalid_source_bootstrap')
 const rows=(await pool.query('SELECT * FROM shared.bootstrap_memory_relay_roots($1::bigint,$2::int)',[options.afterSessionRowId,options.limit])).rows
 const next=rows.reduce((n,r)=>BigInt(r.session_row_id)>n?BigInt(r.session_row_id):n,BigInt(options.afterSessionRowId))
 return {roots:rows.map(r=>({rootKey:r.root_key,revision:r.revision})),nextAfterSessionRowId:next.toString()}
}
