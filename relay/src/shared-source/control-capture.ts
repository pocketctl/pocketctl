import type pg from 'pg'
import {assertRelayCaptureMigrationCompatible} from './capture.js'
type Descriptor={schema:'public'|'shared';table:string;id:string;kind:string;columns:readonly string[];key:string;providerIndex?:number}
const descriptors:readonly Descriptor[]=[
 {schema:'public',table:'extension_providers',id:'providers',kind:'provider',columns:['provider_id','status'],key:'fact->>0',providerIndex:0},
 {schema:'public',table:'extension_installations',id:'installations',kind:'installation',columns:['installation_id','provider_id','owner_user_id','owner_scope_kind','owner_scope_id','status','authorization_epoch','config_version','granted_scopes','enabled_services','subscriptions','event_filter','start_policy','start_feed_id'],key:'fact->>0',providerIndex:1},
 {schema:'public',table:'users',id:'users',kind:'user',columns:['id','team_enabled'],key:'fact->>0'},
 {schema:'public',table:'daemons',id:'daemons',kind:'daemon',columns:['daemon_id','user_id'],key:'fact->>0'},
 {schema:'public',table:'team_agent_offers',id:'offers',kind:'offer',columns:['offer_id','daemon_id'],key:'fact->>0'},
 {schema:'public',table:'extension_teams',id:'scope_teams',kind:'scope',columns:['team_id','organization_id','state','authorization_epoch'],key:"'team:'||(fact->>0)"},
 {schema:'public',table:'extension_organizations',id:'organizations',kind:'scope',columns:['organization_id','state','authorization_epoch'],key:"'organization:'||(fact->>0)"},
 {schema:'public',table:'extension_scope_memberships',id:'scope_members',kind:'scope',columns:['scope_kind','scope_id','user_id','state','roles','membership_revision','membership_id'],key:"(fact->>0)||':'||(fact->>1)"},
 {schema:'public',table:'collaboration_teams',id:'teams',kind:'collaboration_team',columns:['team_id','state'],key:'fact->>0'},
 {schema:'public',table:'collaboration_sessions',id:'sessions',kind:'collaboration_session',columns:['team_session_id','team_id','state'],key:'fact->>0'},
 {schema:'public',table:'team_memory_bindings',id:'bindings',kind:'collaboration_team',columns:['team_id','binding_id','installation_id','owner_scope_kind','owner_scope_id','state','revision'],key:'fact->>0'},
 {schema:'public',table:'collaboration_session_participants',id:'participants',kind:'collaboration_session',columns:['team_session_id','user_id','state','revision'],key:'fact->>0'},
 {schema:'public',table:'collaboration_team_memberships',id:'team_members',kind:'collaboration_team',columns:['team_id','user_id','state'],key:'fact->>0'},
 {schema:'shared',table:'memory_source_modes',id:'modes',kind:'mode',columns:['installation_id','mode','generation'],key:'fact->>0'},
]
const operations=['INSERT','UPDATE','DELETE'] as const
const trigger=(d:Descriptor,op:string)=>`memory_control_${d.id}_${op.toLowerCase()}`
const expected=descriptors.flatMap(d=>operations.map(op=>`('${d.schema}.${d.table}','${trigger(d,op)}','shared.capture_memory_control_${d.id}()',${{INSERT:4,UPDATE:16,DELETE:8}[op]})`)).join(',')
const missing=`SELECT 1 FROM(VALUES ${expected}) expected(relation,trigger_name,function_name,trigger_type)
 WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name
  AND t.tgfoid=to_regprocedure(expected.function_name) AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A')) LIMIT 1`
export async function assertRelayControlCapture(db:Pick<pg.Pool,'query'>):Promise<void>{
 const version=(await db.query("SELECT to_jsonb(c)->>'control_capture_version' AS version FROM shared.memory_source_contract c")).rows
 if(version.length!==1||version[0].version!=='1'||(await db.query(missing)).rowCount)throw Error('relay_control_capture_required')
}
/** Explicit migrator only. Transitions compare named semantic control fields;
 * no row serialization, credentials, event bodies, or per-installation fanout. */
export async function applyRelayControlCapture(pool:pg.Pool):Promise<void>{
 const c=await pool.connect()
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s'")
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-source-contract-v1',0))")
  await assertRelayCaptureMigrationCompatible(c as unknown as pg.Pool)
  const version=(await c.query("SELECT COALESCE(to_jsonb(c)->>'control_capture_version','0') AS version FROM shared.memory_source_contract c")).rows
  if(version.length!==1||!['0','1'].includes(version[0].version))throw Error('unsupported_shared_control_capture_contract')
  if(!(await c.query("SELECT to_regprocedure('shared.mark_memory_control_dirty(text,text)') IS NOT NULL AS present")).rows[0].present)throw Error('source_control_contract_required')
  for(const d of descriptors){
   const columns=(await c.query('SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped',[d.schema+'.'+d.table])).rows.map(r=>r.attname)
   if(d.columns.some(name=>!columns.includes(name)))throw Error('source_control_capture_schema_required')
  }
  await c.query('ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS control_capture_version INT NOT NULL DEFAULT 0')
  for(const d of descriptors){
   const facts=(table:string)=>`SELECT jsonb_build_array(${d.columns.map(name=>'r.'+name).join(',')}) AS fact FROM ${table} r`
   const emit=(rows:string)=>`FOR changed_control IN SELECT DISTINCT (${d.key}) COLLATE "C" AS control_key FROM (${rows}) changed
    ${d.providerIndex===undefined?'':`WHERE fact->>${d.providerIndex}='pocketctl-memory'`} ORDER BY 1
    LOOP PERFORM shared.mark_memory_control_dirty('${d.kind}',changed_control.control_key);END LOOP;`
   await c.query(`CREATE OR REPLACE FUNCTION shared.capture_memory_control_${d.id}() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE changed_control RECORD;BEGIN
    IF TG_OP='INSERT' THEN ${emit(facts('control_new'))}
    ELSIF TG_OP='DELETE' THEN ${emit(facts('control_old'))}
    ELSE ${emit('('+facts('control_new')+' EXCEPT '+facts('control_old')+') UNION ('+facts('control_old')+' EXCEPT '+facts('control_new')+')')}
    END IF;RETURN NULL;END $$`)
   await c.query(`REVOKE ALL ON FUNCTION shared.capture_memory_control_${d.id}() FROM PUBLIC`)
   for(const op of operations)await c.query(`DROP TRIGGER IF EXISTS ${trigger(d,op)} ON ${d.schema}.${d.table};
    CREATE TRIGGER ${trigger(d,op)} AFTER ${op} ON ${d.schema}.${d.table} REFERENCING ${op!=='INSERT'?'OLD TABLE AS control_old ':''}${op!=='DELETE'?'NEW TABLE AS control_new ':''}
     FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_control_${d.id}()`)
  }
  await c.query(`CREATE OR REPLACE FUNCTION shared.assert_memory_control_capture() RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE singleton AND control_capture_version=1)
    OR EXISTS(${missing}) THEN RAISE EXCEPTION 'relay_control_capture_required';END IF;
   END $$;REVOKE ALL ON FUNCTION shared.assert_memory_control_capture() FROM PUBLIC`)
  await c.query('UPDATE shared.memory_source_contract SET control_capture_version=1 WHERE singleton')
  await assertRelayControlCapture(c as unknown as pg.Pool)
  await c.query('COMMIT')
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
