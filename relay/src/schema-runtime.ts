import {assertNativeInputStartSchema} from './shared-source/input-start.js'
import {assertNativeSessionAliasSchema} from './session-alias/schema.js'
import {assertRelaySessionCaptureContract} from './shared-source/session-capture.js'
import type pg from 'pg'
import {sharedSourceHeadersEnabled,sessionTransportConsumerPolicyEnabled} from './shared-source/headers.js'
import {assertSessionTransportConsumerPolicy} from './shared-source/consumer-policy.js'
import {assertRelayTeamSourceCapture} from './shared-source/team-capture.js'
import {assertRelayControlCapture} from './shared-source/control-capture.js'
export const RELAY_SCHEMA_CONTRACT_VERSION=1
export async function relaySharedTarget(db:Pick<pg.Pool,'query'>):Promise<boolean>{
 return (await db.query(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE (n.nspname='shared' AND c.relname='memory_source_contract') OR (n.nspname='memory' AND c.relname='memory_schema_migrations')) AS present`)).rows[0].present
}
export async function assertRelaySharedContract(db:Pick<pg.Pool,'query'>):Promise<void>{
 if(!await relaySharedTarget(db))return
 if(!(await db.query("SELECT to_regclass('shared.memory_source_contract') IS NOT NULL AS present")).rows[0].present)throw new Error('relay_shared_contract_required')
 const versions=(await db.query('SELECT version FROM shared.memory_source_contract')).rows
 if(versions.length!==1||versions[0].version!==1)throw new Error('relay_shared_contract_unsupported')
}
export async function installRelaySchemaContract(db:Pick<pg.Pool,'query'>):Promise<void>{
 await db.query(`CREATE TABLE IF NOT EXISTS public.relay_schema_contract(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  version INT NOT NULL,installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`)
 const versions=(await db.query('SELECT version FROM public.relay_schema_contract')).rows
 if(versions.some(r=>r.version!==RELAY_SCHEMA_CONTRACT_VERSION))throw new Error('relay_schema_contract_unsupported')
 await db.query('INSERT INTO public.relay_schema_contract(singleton,version) VALUES(TRUE,1) ON CONFLICT DO NOTHING')
}
export async function assertRelaySchemaContract(pool:pg.Pool):Promise<void>{
 const c=await pool.connect()
 try{
  await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='5s'")
  await assertRelaySharedContract(c as unknown as pg.Pool)
  if(sessionTransportConsumerPolicyEnabled())await assertSessionTransportConsumerPolicy(c)
  if(await relaySharedTarget(c as unknown as pg.Pool)){
   const start=(await c.query("SELECT to_jsonb(contract)->>'input_start_version' AS input_start_version FROM shared.memory_source_contract contract")).rows
   if(start.length!==1||start[0].input_start_version!=='1')throw Error('relay_shared_input_start_contract_required')
  }
  if(sharedSourceHeadersEnabled()){
   const versions=(await c.query("SELECT to_jsonb(contract)->>'header_version' AS header_version FROM shared.memory_source_contract contract")).rows
   if(versions.length!==1||versions[0].header_version!=='1')throw Error('relay_shared_header_contract_required')
   const columns=(await c.query("SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('public.events') AND attnum>0 AND NOT attisdropped")).rows.map(r=>r.attname)
   if(['source_sequence','source_header_version','source_classification','canonical_payload_hash'].some(name=>!columns.includes(name)))throw Error('relay_shared_header_contract_required')
   const capture=(await c.query("SELECT to_jsonb(contract)->>'capture_version' AS capture_version FROM shared.memory_source_contract contract")).rows
   if(capture.length!==1||capture[0].capture_version!=='2'||!columns.includes('source_body_change_revision'))throw Error('relay_shared_capture_contract_required')
   const triggers=(await c.query(`SELECT tgname,tgtype FROM pg_trigger WHERE tgrelid='public.events'::regclass AND tgenabled IN('O','A')
     AND ((tgname IN('memory_source_capture_insert','memory_source_capture_update','memory_source_capture_delete')
       AND tgfoid=to_regprocedure('shared.capture_memory_relay_events()'))
      OR (tgname='memory_source_capture_body_marker' AND tgfoid=to_regprocedure('shared.mark_memory_event_body_write()')))`)).rows
   if(Object.entries({memory_source_capture_insert:4,memory_source_capture_update:16,memory_source_capture_delete:8,memory_source_capture_body_marker:19})
     .some(([name,type])=>!triggers.some(trigger=>trigger.tgname===name&&trigger.tgtype===type)))throw Error('relay_shared_capture_contract_required')
   await assertRelayTeamSourceCapture(c as unknown as pg.Pool)
   await assertRelaySessionCaptureContract(c as unknown as pg.Pool)
   await assertRelayControlCapture(c as unknown as pg.Pool)
   const feedFence=(await c.query(`SELECT COALESCE(has_function_privilege(current_user,
     to_regprocedure('shared.lock_memory_feed_source_mode(uuid)'),'EXECUTE'),FALSE)
     AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('shared.memory_source_modes')
      AND t.tgname='memory_source_mode_input_fence' AND t.tgtype=31 AND t.tgenabled IN('O','A')
      AND t.tgfoid=to_regprocedure('shared.fence_memory_source_mode_input()')) AS ready`)).rows[0].ready
   if(!feedFence)throw Error('relay_feed_input_fence_required')
   const modeContract=(await c.query("SELECT to_jsonb(contract)->>'mode_version' AS version FROM shared.memory_source_contract contract")).rows
   if(modeContract.length!==1||modeContract[0].version!=='1')throw Error('relay_source_mode_contract_required')
   const pinContract=(await c.query("SELECT to_jsonb(contract)->>'processing_pin_version' AS version FROM shared.memory_source_contract contract")).rows
   const pinFunction=(await c.query("SELECT COALESCE(has_function_privilege(current_user,to_regprocedure('shared.memory_source_processing_blocks_purge(integer,text[])'),'EXECUTE'),FALSE) AS ready")).rows[0].ready
   if(pinContract.length!==1||pinContract[0].version!=='1'||!pinFunction)throw Error('relay_processing_pin_contract_required')

  }
  if(!(await c.query("SELECT to_regclass('public.relay_schema_contract') IS NOT NULL AS present")).rows[0].present)throw new Error('relay_schema_migrator_required')
  const versions=(await c.query('SELECT version FROM public.relay_schema_contract')).rows
  if(versions.length!==1 || versions[0].version!==RELAY_SCHEMA_CONTRACT_VERSION)throw new Error('relay_schema_contract_unsupported')
  for(const [table,columns] of Object.entries({events:['id','session_id','event_type','payload','effect_status','user_id'],sessions:['session_id','user_id'],daemons:['daemon_id'],event_inbox:['inbox_id'],realtime_outbox:['outbox_id']})){
   const actual=(await c.query('SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped',['public.'+table])).rows.map(r=>r.attname)
   if(columns.some(column=>!actual.includes(column)))throw new Error('relay_schema_contract_missing')
  }
  await assertNativeSessionAliasSchema(c as unknown as pg.Pool)
  await assertNativeInputStartSchema(c as unknown as pg.Pool)
  await c.query('COMMIT')
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export type RelaySchemaStrategy='auto'|'verify'|'legacy-migrate'
/** Shared deployments must not start a runtime with migrator/peer authority. */
export async function assertSharedRelayRuntime(pool:pg.Pool):Promise<void>{
 const unsafe=(await pool.query(`SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
   WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
    (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.oid=d.datdba
     OR r.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data','pg_maintain')
     OR has_database_privilege(r.oid,d.oid,'CREATE,TEMPORARY')
     OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','memory','shared') AND (pg_has_role(r.oid,n.nspowner,'MEMBER') OR has_schema_privilege(r.oid,n.oid,'CREATE')))
     OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('memory','shared') AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE') ELSE FALSE END)
     OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND
       (n.nspname='memory' AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR n.nspname='shared' AND has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')))) LIMIT 1`)).rowCount
 if(unsafe)throw new Error('unsafe_shared_relay_runtime')
 const path=(await pool.query('SHOW search_path')).rows[0].search_path.replaceAll(' ','')
 if(path!=='pg_catalog,public,shared')throw new Error('unsafe_shared_relay_runtime')
}
/** auto retains independent legacy installations, but detects a shared target
 * and permanently requires the separate migrator there. No DDL fallback. */
export async function prepareRelaySchema(pool:pg.Pool,migrate:()=>Promise<void>,strategy:RelaySchemaStrategy='auto'):Promise<'verify'|'legacy-migrate'>{
 if(!['auto','verify','legacy-migrate'].includes(strategy))throw new Error('invalid_relay_schema_strategy')
 const headers=sharedSourceHeadersEnabled()
 sessionTransportConsumerPolicyEnabled()
 const shared=await relaySharedTarget(pool)
 if(headers&&!shared)throw Error('relay_shared_header_contract_required')
 if(shared && strategy==='legacy-migrate')throw new Error('shared_source_requires_schema_migrator')
 const mode=strategy==='verify'||shared?'verify':'legacy-migrate'
 if(shared)await assertSharedRelayRuntime(pool)
 if(mode==='verify')await assertRelaySchemaContract(pool);else await migrate()
 return mode
}
