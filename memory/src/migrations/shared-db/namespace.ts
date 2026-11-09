import {assertTransportMetadataContract} from '../../sources/transport-state.js'
import {assertTeamSemanticLegacySchema} from '../../sources/team-semantic-migration.js'
import {assertTeamSemanticLegacyFunction} from './team-semantic-contract.js'
import {assertNativeInputStartCompatible} from './input-start-contract.js'
import {assertPersonalRelayTargetProfile} from './target-contract.js'
import type pg from 'pg'
import {quoteIdentifier} from './schema-context.js'
const ADMIN_SHARED_METADATA_TABLES=new Set(['memory_forward_cleanup_v4_plans','memory_forward_cleanup_v4_pages','memory_forward_cleanup_v4_items','memory_forward_cleanup_v4_receipts','memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])
export interface SharedRoles {memoryRole:string;relayRole:string;migratorRole:string}
async function assertRoles(db:Pick<pg.Pool,'query'>,roles:SharedRoles){
 if(new Set(Object.values(roles)).size!==3 || Object.values(roles).some(v=>!/^[a-z_][a-z0-9_]{0,62}$/.test(v)))throw new Error('invalid_shared_roles')
 const dbOwner=(await db.query('SELECT datdba FROM pg_database WHERE datname=current_database()')).rows[0].datdba
 if((await db.query("SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($2,$1,'MEMBER') AS unsafe",[roles.memoryRole,roles.relayRole])).rows[0].unsafe)throw new Error('runtime_role_escalation')
 for(const name of Object.values(roles)){
  const role=(await db.query(`SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1`,[name])).rows[0]
  if(!role)throw new Error('shared_role_missing')
  if(name===roles.migratorRole)continue
  if(role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls||String(role.oid)===String(dbOwner))throw new Error('unsafe_runtime_role')
  const inherited=(await db.query(`SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($1,$3::oid,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data','pg_maintain')) AND pg_has_role($1,r.oid,'MEMBER')) AS unsafe`,[name,roles.migratorRole,dbOwner])).rows[0].unsafe
  if(inherited)throw new Error('runtime_role_escalation')
 }
}
/** Explicit admin bootstrap for an already constructed target schema, not a
 * startup side effect. Passwords/login provisioning are external to this tool. */
export async function provisionSharedDatabase(pool:pg.Pool,roles:SharedRoles,options:{fencedMemoryRuntime?:boolean}={}):Promise<void>{
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await assertNativeInputStartCompatible(client as unknown as pg.Pool);await assertTeamSemanticLegacySchema(client);await assertTeamSemanticLegacyFunction(client,options.fencedMemoryRuntime?roles.memoryRole:undefined);await assertRoles(client as unknown as pg.Pool,roles)
  const database=quoteIdentifier((await client.query('SELECT current_database() AS name')).rows[0].name)
  const memory=quoteIdentifier(roles.memoryRole),relay=quoteIdentifier(roles.relayRole),migrator=quoteIdentifier(roles.migratorRole)
  const objects=(await client.query(`SELECT n.nspname,c.relname,c.relkind,EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i')) AS owned_sequence FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relnamespace IN ('memory'::regnamespace,'shared'::regnamespace) AND c.relkind IN ('r','p','S','v','m') ORDER BY c.relkind,c.relname`)).rows
  for(const o of objects){
   // Preserve exact separately audited administrator metadata ownership. These
   // objects stay in catalog/ACL audits; no prefix or inventory exclusion.
   if(o.nspname==='shared'&&ADMIN_SHARED_METADATA_TABLES.has(o.relname)){
    if(o.relkind!=='r')throw Error('admin_metadata_relation_type_invalid')
    continue
   }
   if(o.relkind!=='S'||!o.owned_sequence)await client.query(`ALTER ${o.relkind==='S'?'SEQUENCE':o.relkind==='v'?'VIEW':o.relkind==='m'?'MATERIALIZED VIEW':'TABLE'} ${quoteIdentifier(o.nspname)}.${quoteIdentifier(o.relname)} OWNER TO ${migrator}`)
  }
  const functions=(await client.query("SELECT pronamespace::regnamespace::text AS namespace,proname,pg_get_function_identity_arguments(oid) args FROM pg_proc p WHERE (pronamespace='memory'::regnamespace OR pronamespace='shared'::regnamespace AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')) AND prokind IN ('f','p')")).rows
  for(const f of functions)await client.query(`ALTER ROUTINE ${quoteIdentifier(f.namespace)}.${quoteIdentifier(f.proname)}(${f.args}) OWNER TO ${migrator}`)
  if((await client.query("SELECT to_regclass('public.relay_schema_contract') IS NOT NULL AS present")).rows[0].present)await client.query(`REVOKE ALL ON public.relay_schema_contract FROM ${relay}; GRANT SELECT ON public.relay_schema_contract TO ${relay}`)
  const relayTables=['session_aliases','events','sessions','daemons','extension_installations','extension_source_outbox','deleted_sessions','session_archive_manifests','session_archive_chunks',
   'native_source_publications','native_installation_starts','native_input_start_contract','extension_feed','extension_checkpoints',
   'extension_scope_memberships','extension_teams','extension_organizations','collaboration_teams','collaboration_sessions','collaboration_calls','collaboration_events',
   'collaboration_session_participants','collaboration_team_memberships','team_memory_bindings','team_agent_offers','team_delivery_memory_sources','team_task_submissions','team_task_specs','team_acceptance_decisions','team_artifact_revocations','team_delivery_memory_withdrawals']
  for(const table of relayTables)if((await client.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)await client.query(`GRANT SELECT ON public.${quoteIdentifier(table)} TO ${migrator}`)
  if((await client.query("SELECT to_regclass('public.extension_providers') IS NOT NULL AS present")).rows[0].present)await client.query(`GRANT SELECT(provider_id,status) ON public.extension_providers TO ${migrator}`)
  if((await client.query("SELECT to_regclass('public.users') IS NOT NULL AS present")).rows[0].present)await client.query(`GRANT SELECT(id) ON public.users TO ${migrator}`)
  if((await client.query("SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.users') AND attname='team_enabled' AND NOT attisdropped")).rowCount)await client.query(`GRANT SELECT(team_enabled) ON public.users TO ${migrator}`)
  // PostgreSQL row locks require UPDATE on at least one column. Only the
  // non-runtime migrator/definer owns this capability; runtime receives EXECUTE.
  for(const [table,key] of [['session_aliases','old_session_id'],['extension_installations','installation_id'],['extension_teams','team_id'],['extension_organizations','organization_id'],['extension_scope_memberships','membership_id'],['users','id'],['extension_providers','provider_id'],['sessions','session_id'],['daemons','daemon_id'],['collaboration_teams','team_id'],['collaboration_team_memberships','team_id'],['collaboration_sessions','team_session_id'],['collaboration_session_participants','team_session_id'],['team_memory_bindings','binding_id'],['collaboration_calls','call_id'],['team_agent_offers','offer_id'],['team_delivery_memory_sources','source_session_id'],['team_task_submissions','submission_id'],['team_acceptance_decisions','decision_id'],['team_task_specs','task_id']]){
   if((await client.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)await client.query(`GRANT UPDATE(${quoteIdentifier(key)}) ON public.${quoteIdentifier(table)} TO ${migrator}`)
  }
  await client.query(`ALTER SCHEMA memory OWNER TO ${migrator}; ALTER SCHEMA shared OWNER TO ${migrator};
   REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC,${memory},${relay}; GRANT TEMPORARY ON DATABASE ${database} TO ${migrator};
   REVOKE CREATE ON SCHEMA public FROM PUBLIC,${memory},${relay}; REVOKE ALL ON SCHEMA memory,shared FROM ${memory},${relay}; REVOKE ALL ON SCHEMA memory,shared FROM PUBLIC;
   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${memory};
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${memory};
   REVOKE ALL ON ALL TABLES IN SCHEMA shared FROM PUBLIC,${memory},${relay};
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA shared FROM PUBLIC,${memory},${relay};
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA shared FROM PUBLIC,${memory},${relay};
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${relay};
   GRANT INSERT(installation_id,snapshot_required_at),UPDATE(snapshot_required_at,lease_epoch,lease_token_hash,lease_expires_at,updated_at) ON public.extension_checkpoints TO ${migrator};
   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${relay};
   REVOKE ALL ON ALL TABLES IN SCHEMA memory FROM PUBLIC,${relay};
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA memory FROM PUBLIC,${relay};
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA memory FROM PUBLIC,${relay};
   GRANT EXECUTE ON FUNCTION shared.mark_memory_source_dirty(TEXT,TEXT),shared.memory_source_processing_blocks_purge(INT,TEXT[]) TO ${relay};
   GRANT EXECUTE ON FUNCTION shared.assert_session_transport_consumer_policy(),shared.session_transport_consumer_policy(BIGINT),shared.record_session_transport_body_gap(BIGINT) TO ${relay};
   GRANT EXECUTE ON FUNCTION shared.acquire_memory_source_processing_pin(UUID,JSONB,TEXT,JSONB,BOOLEAN),shared.release_memory_source_processing_pins(UUID),shared.guard_memory_source_processing_pins(UUID,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.claim_memory_source_work(TEXT,INTEGER,INTEGER),shared.assert_memory_source_lease(TEXT,TEXT,UUID,TEXT,BIGINT),
    shared.ack_memory_source_work(TEXT,TEXT,UUID,TEXT,BIGINT),shared.fail_memory_source_work(TEXT,TEXT,UUID,TEXT,BIGINT,TEXT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.complete_memory_source_projection(UUID,JSONB,TEXT,TEXT,JSONB),shared.memory_source_scope_key(JSONB) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.lock_memory_legacy_input(UUID,BIGINT),shared.record_memory_source_dispatch(UUID,BIGINT,TEXT,TEXT,BIGINT,BIGINT,BIGINT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.capture_memory_job_source(UUID,TEXT,BIGINT,TEXT),shared.assert_memory_job_source(UUID,TEXT),shared.guard_memory_job_source_commit(UUID),shared.start_memory_source_provider(UUID,UUID,TEXT),shared.finish_memory_source_provider(UUID,UUID,TEXT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.memory_relay_source_authority(JSONB,TEXT,TEXT),shared.memory_retained_relay_authority(JSONB,TEXT,TEXT),shared.read_memory_relay_sources(JSONB,TEXT,BIGINT,INT,BIGINT[]),shared.read_memory_relay_archive(JSONB,TEXT,UUID,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.lock_memory_delivery_commit(JSONB),shared.lock_memory_personal_source_commit(JSONB,TEXT,TEXT,JSONB,BOOLEAN),shared.lock_memory_team_source_commit(JSONB,TEXT,TEXT,JSONB,BOOLEAN) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.memory_delivery_withdrawal_page(UUID,BIGINT,INT),shared.memory_installation_inventory_page(UUID,INT,BIGINT),shared.memory_source_health(),shared.memory_current_grant_states(UUID[],UUID[]),shared.lock_memory_grant_authority(UUID[],UUID[]) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.read_memory_legacy_sources(JSONB,TEXT,UUID,INT,UUID[],BOOLEAN),shared.memory_source_ref_context(UUID,UUID[]) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.memory_team_source_authority(JSONB,TEXT,TEXT),shared.read_memory_team_source(JSONB,TEXT,TEXT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.enumerate_memory_source_targets(TEXT,TEXT,TEXT,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.step_memory_source_distribution(TEXT,TEXT,UUID,TEXT,BIGINT,UUID,TEXT,INT),shared.read_memory_source_context_set(TEXT,TEXT,UUID,UUID,TEXT,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.dispatch_memory_source_distribution(TEXT,TEXT,UUID,TEXT,BIGINT,UUID,TEXT,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.resume_memory_source_distribution(TEXT,TEXT,UUID,TEXT,BIGINT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.current_memory_source_distribution(TEXT,TEXT,UUID) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.step_memory_control_bootstrap(TEXT,TEXT,UUID,TEXT,BIGINT,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.renew_memory_source_lease(TEXT,TEXT,UUID,TEXT,BIGINT,INT),shared.renew_memory_control_lease(TEXT,TEXT,UUID,TEXT,BIGINT,INT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.guard_memory_job_source_comparison(UUID) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.memory_shadow_candidate_headers(UUID,TEXT,TEXT[],TEXT[]),shared.read_memory_source_shadow_progress(UUID,TEXT,TEXT,UUID,TEXT),
    shared.write_memory_source_shadow_progress(UUID,JSONB,TEXT,TEXT,UUID,TEXT,JSONB) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.lock_memory_feed_source_mode(UUID) TO ${relay};
   GRANT EXECUTE ON FUNCTION shared.memory_source_control_snapshot(),shared.guard_memory_control_commit(BIGINT),shared.claim_memory_control_work(TEXT,INT,INT),
    shared.assert_memory_control_lease(TEXT,TEXT,UUID,TEXT,BIGINT),shared.ack_memory_control_work(TEXT,TEXT,UUID,TEXT,BIGINT),shared.fail_memory_control_work(TEXT,TEXT,UUID,TEXT,BIGINT,TEXT) TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.memory_input_start_ready() TO ${memory};
   GRANT EXECUTE ON FUNCTION shared.read_memory_team_legacy_audit(uuid,jsonb),shared.read_memory_team_semantic_group(uuid,text,text),shared.lock_memory_team_semantic_group(uuid,jsonb,boolean),shared.memory_team_semantic_input_admission(uuid,jsonb) TO ${memory};
   GRANT SELECT ON shared.memory_source_contract,shared.memory_source_modes TO ${memory},${relay};
   GRANT USAGE ON SCHEMA public TO ${memory},${relay},${migrator};
   GRANT USAGE ON SCHEMA memory,shared TO ${memory}; GRANT USAGE ON SCHEMA shared TO ${relay};
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA memory TO ${memory};
   REVOKE ALL ON memory.memory_schema_migrations FROM PUBLIC,${memory},${relay}; GRANT SELECT ON memory.memory_schema_migrations TO ${memory};
   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA memory TO ${memory};
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA memory TO ${memory};
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA memory REVOKE ALL ON TABLES FROM PUBLIC;
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA memory REVOKE ALL ON FUNCTIONS FROM PUBLIC;
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA memory GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${memory};
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA memory GRANT USAGE,SELECT ON SEQUENCES TO ${memory};
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA memory GRANT EXECUTE ON FUNCTIONS TO ${memory};
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA shared REVOKE ALL ON TABLES FROM PUBLIC,${memory},${relay};
   ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA shared REVOKE ALL ON FUNCTIONS FROM PUBLIC;
   ALTER ROLE ${memory} SET search_path=pg_catalog,memory,shared;
   ALTER ROLE ${relay} SET search_path=pg_catalog,public,shared;`)
  // A preexisting extension may live in shared. Regrant only its reviewed pure
  // pg_trgm functions, not arbitrary future shared routines.
  const extensionFunctions=(await client.query("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid WHERE p.pronamespace='shared'::regnamespace AND e.extname='pg_trgm'")).rows
  for(const f of extensionFunctions)await client.query(`GRANT EXECUTE ON FUNCTION ${f.signature} TO ${memory}`)
  for(const name of [roles.memoryRole,roles.relayRole]){
   const unsafe=(await client.query("SELECT 1 FROM pg_class c WHERE c.relnamespace='shared'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') LIMIT 1",[name])).rowCount
   if(unsafe)throw new Error('shared_runtime_privilege_escalation')
  }
  if((await client.query("SELECT to_regclass('public.relay_schema_contract') IS NOT NULL AS present")).rows[0].present)await client.query(`REVOKE INSERT,UPDATE,DELETE ON public.relay_schema_contract FROM ${relay}`)
  for(const table of ['native_source_publications','native_installation_starts','native_input_start_contract','native_team_semantic_publications'])if((await client.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)await client.query(`REVOKE ALL ON public.${quoteIdentifier(table)} FROM PUBLIC,${memory},${relay}`)
  if((await client.query("SELECT to_regclass('public.native_team_semantic_publications') IS NOT NULL AS present")).rows[0].present)await client.query(`REVOKE ALL (source_kind,business_key_hash,original_business_key,team_id,team_session_id,call_id,submission_id,decision_id,binding_id,binding_revision,target_installation_id,target_owner_scope_kind,target_owner_scope_id,publication_xid,publication_order,retired) ON public.native_team_semantic_publications FROM PUBLIC,${memory},${relay}`)
  if((await client.query("SELECT to_regclass('public.native_input_start_contract') IS NOT NULL AS present")).rows[0].present)await client.query(`GRANT SELECT ON public.native_input_start_contract TO ${relay}`)
  if((await client.query("SELECT to_regclass('public.native_input_start_order') IS NOT NULL AS present")).rows[0].present)await client.query(`REVOKE ALL ON public.native_input_start_order FROM PUBLIC,${memory},${relay}`)
  // Explicit invoker helpers used by native guards/publishers and shared
  // definers. A repeat schema rebuild must not depend on PUBLIC defaults.
  for(const signature of ['public.native_session_alias_set(text[])','public.native_session_authority(text,integer,text)','public.native_event_authority(bigint,integer)','public.adopt_native_session_owner(text,integer,text)','public.session_event_body_header(jsonb)'])if((await client.query('SELECT to_regprocedure($1) IS NOT NULL AS present',[signature])).rows[0].present)await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${relay},${migrator}`)
  // Native Team row triggers call these existing invoker helpers. Wakeup is
  // a writer, constrained by the Relay role's existing public table ACLs;
  // Memory runtime and shared definers do not receive its write entry point.
  for(const signature of ['public.signal_team_step_wakeup(text)','public.team_task_delivery_complete(text)','public.team_task_legacy_delivery_complete(text)','public.team_delivery_submission_accepted(text,uuid,bigint)'])if((await client.query('SELECT to_regprocedure($1) IS NOT NULL AS present',[signature])).rows[0].present)await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${relay}`)


  if((await client.query("SELECT to_regprocedure('public.read_native_team_semantic_publication(text,text)') IS NOT NULL AND to_regprocedure('shared.read_memory_team_semantic_group(uuid,text,text)') IS NOT NULL AS ready")).rows[0].ready){
   const role=(await client.query('SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[roles.migratorRole])).rows[0]
   if(!role||role.rolcanlogin||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls)throw Error('unsafe_semantic_definer_role')
   const owners=(await client.query("SELECT (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('shared.read_memory_team_semantic_group(uuid,text,text)'))=$1::oid AND(SELECT relowner FROM pg_class WHERE oid='memory.memory_schema_migrations'::regclass)=$1::oid AS valid",[role.oid])).rows[0]
   if(owners?.valid!==true)throw Error('semantic_definer_owner_mismatch')
   await client.query(`REVOKE ALL ON FUNCTION public.read_native_team_semantic_publication(text,text) FROM PUBLIC,${memory},${relay};GRANT EXECUTE ON FUNCTION public.read_native_team_semantic_publication(text,text) TO ${migrator}`)
  }
  await assertNativeInputStartCompatible(client as unknown as pg.Pool)
  await assertTeamSemanticLegacySchema(client);await assertTeamSemanticLegacyFunction(client,options.fencedMemoryRuntime?roles.memoryRole:undefined)
  await client.query('COMMIT')
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function assertSharedRuntimeContract(pool:pg.Pool,launch:{sharedSourceProfile?:'personal-relay-only';installationAllowlist?:readonly string[]}={}):Promise<void>{
 const client=await pool.connect()
 try{
  await client.query('BEGIN READ ONLY')
  const r=(await client.query(`SELECT r.oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    d.datdba,current_setting('search_path') AS path FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname=current_user AND d.datname=current_database()`)).rows[0]
  if(r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolbypassrls||String(r.oid)===String(r.datdba)||r.path.replaceAll(' ','')!=='pg_catalog,memory,shared')throw new Error('unsafe_shared_runtime')
  const unsafe=(await client.query(`SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','memory','shared') AND
    (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER'))
    UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') LIMIT 1`)).rowCount
  if(unsafe)throw new Error('shared_runtime_privilege_escalation')
  const sharedWrite=(await client.query("SELECT 1 FROM pg_class c WHERE c.relnamespace='shared'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') LIMIT 1")).rowCount
  if(sharedWrite)throw new Error('shared_runtime_privilege_escalation')
  const registryWrite=(await client.query("SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND has_table_privilege(r.oid,'memory.memory_schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') LIMIT 1")).rowCount
  if(registryWrite)throw new Error('shared_runtime_privilege_escalation')
  const foreignSequences=(await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r WHERE n.nspname IN ('public','shared') AND pg_has_role(current_user,r.oid,'MEMBER') AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE') ELSE FALSE END LIMIT 1")).rowCount
  if(foreignSequences)throw new Error('shared_runtime_privilege_escalation')
  const inherited=(await client.query("SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data','pg_maintain')) AND pg_has_role(current_user,r.oid,'MEMBER') LIMIT 1")).rowCount
  if(inherited)throw new Error('runtime_role_escalation')
  const indirect=(await client.query("SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))) LIMIT 1")).rowCount
  if(indirect)throw new Error('runtime_role_escalation')
  // A real Relay target must install native routing/storage authority before
  // either runtime starts. Generic namespace-only rehearsals have no Relay contract.
  if((await client.query("SELECT to_regclass('public.relay_schema_contract') IS NOT NULL AS present")).rows[0].present){
   const native=(await client.query(`SELECT to_regprocedure('public.native_session_authority(text,integer,text)') IS NOT NULL
    AND to_regprocedure('public.native_session_alias_set(text[])') IS NOT NULL
    AND to_regprocedure('public.native_event_authority(bigint,integer)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.events') AND attname='owner_retired' AND attnotnull AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.session_aliases') AND attname='owner_boundary' AND attnotnull AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.events') AND attname='logical_source_session_id' AND attnotnull AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.events') AND attname='body_session_id' AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.session_document_versions') AND attname='body_session_id' AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.session_aliases') AND tgname='native_alias_edge_guard' AND tgenabled IN('O','A'))
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.deleted_sessions') AND tgname='native_alias_privacy_guard' AND tgenabled IN('O','A'))
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.events') AND conname='events_body_manifest_binding' AND pg_get_constraintdef(oid) LIKE '%body_session_id%') AS ready`)).rows[0]
   if(native?.ready!==true)throw Error('native_session_alias_migrator_required')
  }
  const contract=(await client.query("SELECT version,COALESCE(to_jsonb(contract)->>'input_start_version','0') AS input_start_version,COALESCE(to_jsonb(contract)->>'consumer_version','0') AS consumer_version,COALESCE(to_jsonb(contract)->>'commit_fence_version','0') AS commit_fence_version,COALESCE(to_jsonb(contract)->>'execution_version','0') AS execution_version,COALESCE(to_jsonb(contract)->>'control_version','0') AS control_version,COALESCE(to_jsonb(contract)->>'distribution_version','0') AS distribution_version,COALESCE(to_jsonb(contract)->>'shadow_version','0') AS shadow_version,COALESCE(to_jsonb(contract)->>'processing_pin_version','0') AS processing_pin_version,COALESCE(to_jsonb(contract)->>'mode_version','0') AS mode_version FROM shared.memory_source_contract contract")).rows
  if(contract.length!==1 || contract[0].version!==1)throw new Error('unsupported_shared_source_contract')
  if(contract[0].input_start_version!=='1')throw new Error('unsupported_shared_input_start_contract')
  if(!(await client.query('SELECT shared.memory_input_start_ready() AS ready')).rows[0]?.ready)throw Error('native_input_start_migrator_required')
  if(contract[0].consumer_version!=='1')throw new Error('unsupported_shared_consumer_contract')
  if(contract[0].commit_fence_version!=='1')throw new Error('unsupported_shared_commit_fence_contract')
  if(contract[0].execution_version!=='1')throw new Error('unsupported_shared_execution_contract')
  if(contract[0].control_version!=='1')throw new Error('unsupported_shared_control_contract')
  if(contract[0].distribution_version!=='1')throw new Error('unsupported_shared_distribution_contract')
  if(contract[0].shadow_version!=='1')throw new Error('unsupported_shared_shadow_contract')
  if(contract[0].processing_pin_version!=='1')throw new Error('unsupported_shared_processing_pin_contract')
  if(contract[0].mode_version!=='1')throw new Error('unsupported_shared_mode_contract')
  const required=['shared.memory_delivery_withdrawal_page(uuid,bigint,integer)','shared.memory_installation_inventory_page(uuid,integer,bigint)','shared.guard_memory_source_processing_pins(uuid,integer)','shared.acquire_memory_source_processing_pin(uuid,jsonb,text,jsonb,boolean)','shared.release_memory_source_processing_pins(uuid)','shared.complete_memory_source_projection(uuid,jsonb,text,text,jsonb)','shared.memory_source_scope_key(jsonb)','shared.guard_memory_job_source_comparison(uuid)','shared.memory_shadow_candidate_headers(uuid,text,text[],text[])','shared.read_memory_source_shadow_progress(uuid,text,text,uuid,text)','shared.write_memory_source_shadow_progress(uuid,jsonb,text,text,uuid,text,jsonb)','shared.step_memory_control_bootstrap(text,text,uuid,text,bigint,integer)','shared.renew_memory_source_lease(text,text,uuid,text,bigint,integer)','shared.renew_memory_control_lease(text,text,uuid,text,bigint,integer)','shared.step_memory_source_distribution(text,text,uuid,text,bigint,uuid,text,integer)','shared.dispatch_memory_source_distribution(text,text,uuid,text,bigint,uuid,text,integer)','shared.resume_memory_source_distribution(text,text,uuid,text,bigint)','shared.current_memory_source_distribution(text,text,uuid)','shared.read_memory_source_context_set(text,text,uuid,uuid,text,integer)','shared.memory_source_control_snapshot()','shared.guard_memory_control_commit(bigint)','shared.enumerate_memory_source_targets(text,text,text,integer)','shared.capture_memory_job_source(uuid,text,bigint,text)','shared.assert_memory_job_source(uuid,text)','shared.guard_memory_job_source_commit(uuid)','shared.start_memory_source_provider(uuid,uuid,text)','shared.finish_memory_source_provider(uuid,uuid,text)','shared.lock_memory_delivery_commit(jsonb)','shared.lock_memory_personal_source_commit(jsonb,text,text,jsonb,boolean)','shared.lock_memory_team_source_commit(jsonb,text,text,jsonb,boolean)','shared.lock_memory_legacy_input(uuid,bigint)','shared.read_memory_legacy_sources(jsonb,text,uuid,integer,uuid[],boolean)','shared.memory_source_health()','shared.memory_current_grant_states(uuid[],uuid[])','shared.lock_memory_grant_authority(uuid[],uuid[])','shared.memory_source_ref_context(uuid,uuid[])','shared.memory_retained_relay_authority(jsonb,text,text)']
  const functions=(await client.query(`SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[]) AS required(signature)
   WHERE to_regprocedure(signature) IS NULL OR NOT COALESCE(has_function_privilege(current_user,to_regprocedure(signature),'EXECUTE'),FALSE)) AS complete`,[required])).rows[0].complete
  if(!functions)throw new Error('shared_consumer_functions_missing')
  const executionFences=(await client.query(`SELECT NOT EXISTS(SELECT 1 FROM(VALUES
    ('shared.memory_source_executions','memory_source_execution_commit',21),
    ('shared.memory_source_provider_attempts','memory_source_provider_commit',5)) expected(relation,trigger_name,trigger_type)
    WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name
      AND t.tgfoid=to_regprocedure('shared.check_memory_source_execution_commit()') AND t.tgtype=expected.trigger_type
      AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled IN('O','A'))) AS ready`)).rows[0].ready
  if(!executionFences)throw Error('shared_source_execution_fence_missing')
  const localDeliveryFence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('memory.memory_team_delivery_withdrawals') AND t.tgname='memory_delivery_privacy_fence' AND t.tgfoid=to_regprocedure('shared.fence_memory_delivery_withdrawal()') AND t.tgtype=31 AND t.tgenabled IN('O','A')) AS ready")).rows[0].ready
  if(!localDeliveryFence)throw Error('shared_delivery_privacy_fence_missing')
  const modeInputFence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('shared.memory_source_modes') AND t.tgname='memory_source_mode_input_fence' AND t.tgfoid=to_regprocedure('shared.fence_memory_source_mode_input()') AND t.tgtype=31 AND t.tgenabled IN('O','A')) AS ready")).rows[0].ready
  if(!modeInputFence)throw Error('shared_mode_input_fence_missing')
  const transportRetirementFences=(await client.query(`SELECT NOT EXISTS(SELECT 1 FROM(VALUES
   ('public.extension_installations','memory_session_transport_retired','shared.enforce_memory_session_transport_retirement()',23),
   ('shared.memory_session_transport_retirements','memory_session_transport_retirement_immutable','shared.guard_memory_session_transport_retirement()',27)
   ) expected(relation,trigger_name,function_name,trigger_type) WHERE NOT EXISTS(
    SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name
     AND t.tgfoid=to_regprocedure(expected.function_name) AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A'))) AS ready`)).rows[0].ready
  if(!transportRetirementFences)throw Error('shared_session_transport_retirement_fence_missing')
  const localControls=(await client.query(`SELECT NOT EXISTS(SELECT 1 FROM(VALUES
   ('memory_feature_control_insert',4),('memory_feature_control_update',16),('memory_feature_control_delete',8)) expected(trigger_name,trigger_type)
   WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('memory.memory_feature_settings')
    AND t.tgname=expected.trigger_name AND t.tgtype=expected.trigger_type
    AND t.tgfoid=to_regprocedure('shared.capture_memory_feature_controls()') AND t.tgenabled IN('O','A'))) AS ready`)).rows[0].ready
  if(!localControls)throw Error('shared_local_control_capture_missing')
  const distributionFence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('shared.memory_source_distributions') AND t.tgname='memory_source_distribution_commit' AND t.tgfoid=to_regprocedure('shared.check_memory_source_distribution_commit()') AND t.tgtype=21 AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled IN('O','A')) AS ready")).rows[0].ready
  if(!distributionFence)throw Error('shared_source_distribution_fence_missing')
  const bootstrapFence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('shared.memory_source_control_progress') AND t.tgname='memory_control_bootstrap_commit' AND t.tgfoid=to_regprocedure('shared.check_memory_control_bootstrap_commit()') AND t.tgtype=21 AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled IN('O','A')) AS ready")).rows[0].ready
  if(!bootstrapFence)throw Error('shared_control_bootstrap_fence_missing')
  const processingPinFence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('shared.memory_source_processing_pins') AND tgname='memory_source_processing_pin_commit' AND tgfoid=to_regprocedure('shared.check_memory_source_processing_pin_commit()') AND tgtype=21 AND tgdeferrable AND tginitdeferred AND tgenabled IN('O','A')) AS ready")).rows[0].ready
  if(!processingPinFence)throw Error('shared_processing_pin_fence_missing')
  const processingOutputFence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('shared.memory_source_executions') AND tgname='memory_execution_processing_commit' AND tgfoid=to_regprocedure('shared.check_memory_execution_processing_commit()') AND tgtype=17 AND tgdeferrable AND tginitdeferred AND tgenabled IN('O','A')) AS ready")).rows[0].ready
  if(!processingOutputFence)throw Error('shared_processing_output_fence_missing')
  const pinRead=(await client.query("SELECT has_table_privilege(current_user,'shared.memory_source_processing_pins','SELECT') OR has_table_privilege(current_user,'shared.memory_source_processing_windows','SELECT') AS unsafe")).rows[0].unsafe
  if(pinRead)throw Error('shared_processing_pin_privilege_escalation')
  const modes=(await client.query("SELECT installation_id::text,mode FROM shared.memory_source_modes WHERE mode IN ('shared-active','shared-shadow') ORDER BY installation_id")).rows
  if(launch.sharedSourceProfile!==undefined){
   if(launch.sharedSourceProfile!=='personal-relay-only')throw Error('shared_source_target_profile_mismatch')
   const ids=launch.installationAllowlist??[]
   if(ids.length<1||ids.length>16||new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)))throw Error('shared_source_launch_scope_mismatch')
   const local=(await client.query("SELECT installation_id::text FROM memory.memory_installations WHERE relay_status IN('pending','active','paused','revoking') AND local_status<>'purged' ORDER BY installation_id")).rows.map(r=>r.installation_id)
   if(JSON.stringify([...ids].sort())!==JSON.stringify(local))throw Error('shared_source_launch_scope_mismatch')
   await assertPersonalRelayTargetProfile(client,ids)
   const facts=(await client.query('SELECT installation_id::text,state FROM shared.memory_current_grant_states($1::uuid[],ARRAY[]::uuid[])',[ids])).rows
   if(facts.length!==ids.length||facts.some(r=>!ids.includes(r.installation_id)))throw Error('shared_source_launch_scope_mismatch')
   // Only the proved personal Session lane may use canonical input. Existing
   // organization control/legacy jobs remain available with unchanged consent.
   if(modes.some(m=>!ids.includes(m.installation_id)||!facts.some(f=>f.installation_id===m.installation_id&&f.state.owner_scope_kind==='personal')))
    throw Error('shared_source_launch_scope_mismatch')
  }else if(modes.length)throw new Error('shared_source_consumers_not_ready')
  await assertTransportMetadataContract(client)
  await client.query('COMMIT')
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
