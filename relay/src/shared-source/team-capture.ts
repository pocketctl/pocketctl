import {installRelayDeliveryPrivacyCapture,assertRelayDeliveryPrivacyCapture,DELIVERY_PRIVACY_EXPECTED} from './delivery-privacy-capture.js'
import type pg from 'pg'
import {assertRelayCaptureMigrationCompatible} from './capture.js'
const terminal="('completed','failed','cancelled','blocked')"
const descriptors=[
 {table:'collaboration_events',key:'events',select:(rows:string)=>`SELECT 'team_collaboration'::text AS kind,c.call_id AS root FROM public.collaboration_calls c JOIN ${rows} e ON(e.call_id=c.call_id OR e.event_id=c.event_id) WHERE c.state IN ${terminal}`},
 {table:'collaboration_calls',key:'calls',select:(rows:string)=>`SELECT 'team_collaboration'::text AS kind,c.call_id AS root FROM ${rows} c WHERE c.state IN ${terminal}
  UNION ALL SELECT 'team_delivery',r.source_session_id FROM ${rows} c JOIN public.team_task_submissions s ON s.source_call_id=c.call_id JOIN public.team_delivery_memory_sources r USING(submission_id)`},
 {table:'team_delivery_memory_sources',key:'receipts',select:(rows:string)=>`SELECT 'team_delivery'::text AS kind,r.source_session_id AS root FROM ${rows} r`},
 {table:'team_task_submissions',key:'submissions',select:(rows:string)=>`SELECT 'team_delivery'::text AS kind,r.source_session_id AS root FROM ${rows} s JOIN public.team_delivery_memory_sources r USING(submission_id)`},
 {table:'team_acceptance_decisions',key:'decisions',select:(rows:string)=>`SELECT 'team_delivery'::text AS kind,r.source_session_id AS root FROM ${rows} d JOIN public.team_delivery_memory_sources r USING(decision_id)`},
 {table:'team_task_specs',key:'specs',select:(rows:string)=>`SELECT 'team_delivery'::text AS kind,r.source_session_id AS root FROM ${rows} spec JOIN public.team_task_submissions s ON s.task_id=spec.task_id AND s.spec_revision=spec.revision JOIN public.team_delivery_memory_sources r USING(submission_id)`},
 {table:'team_artifact_revocations',key:'revocations',select:(rows:string)=>`SELECT 'team_delivery'::text AS kind,r.source_session_id AS root FROM ${rows} a JOIN public.team_delivery_memory_sources r USING(submission_id)`},
] as const
const triggerName=(key:string,op:string)=>`memory_team_capture_${key}_${op.toLowerCase()}`
const ordered=(sql:string)=>`SELECT DISTINCT kind,root COLLATE "C" AS root FROM (${sql}) candidates ORDER BY kind,root COLLATE "C"`
const loop=(sql:string)=>`FOR captured_root IN ${ordered(sql)} LOOP PERFORM shared.mark_memory_source_dirty(captured_root.kind,captured_root.root);END LOOP;`
const statements=descriptors.flatMap(d=>[
 `CREATE OR REPLACE FUNCTION shared.capture_memory_team_${d.key}() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE captured_root RECORD;BEGIN
  IF TG_OP='INSERT' THEN ${loop(d.select('capture_new'))}
  ELSIF TG_OP='DELETE' THEN ${loop(d.select('capture_old'))}
  ELSE ${loop(d.select('capture_old')+' UNION ALL '+d.select('capture_new'))}
  END IF;RETURN NULL;END $$`,
 ...(['INSERT','UPDATE','DELETE'] as const).map(op=>`DROP TRIGGER IF EXISTS ${triggerName(d.key,op)} ON public.${d.table};
  CREATE TRIGGER ${triggerName(d.key,op)} AFTER ${op} ON public.${d.table} REFERENCING ${op!=='INSERT'?'OLD TABLE AS capture_old ':''}${op!=='DELETE'?'NEW TABLE AS capture_new ':''} FOR EACH STATEMENT EXECUTE FUNCTION shared.capture_memory_team_${d.key}()`),
 `REVOKE ALL ON FUNCTION shared.capture_memory_team_${d.key}() FROM PUBLIC`,
])
const expected=descriptors.flatMap(d=>(['INSERT','UPDATE','DELETE'] as const).map(op=>`('public.${d.table}','${triggerName(d.key,op)}','shared.capture_memory_team_${d.key}()',${{INSERT:4,UPDATE:16,DELETE:8}[op]})`)).join(',')
export async function assertRelayTeamSourceCapture(db:Pick<pg.Pool,'query'>){
 const versions=(await db.query("SELECT to_jsonb(contract)->>'team_capture_version' AS team_capture_version FROM shared.memory_source_contract contract")).rows
 if(versions.length!==1||versions[0].team_capture_version!=='1')throw Error('relay_shared_team_capture_contract_required')
 const missing=(await db.query(`SELECT 1 FROM(VALUES ${expected}) expected(relation,trigger_name,function_name,trigger_type)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name
   AND t.tgfoid=to_regprocedure(expected.function_name) AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A')) LIMIT 1`)).rowCount
 if(missing)throw Error('relay_shared_team_capture_contract_required')
 await assertRelayDeliveryPrivacyCapture(db)
}
/** No bodies, installation fan-out, application init or model calls. Every SQL
 * write path, including owned clients and cascades, crosses these triggers.
 * UPDATE conservatively dirties once per root/statement without body equality. */
export async function applyRelayTeamSourceCapture(pool:pg.Pool){
 const c=await pool.connect()
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s'")
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-source-contract-v1',0))")
  await assertRelayCaptureMigrationCompatible(c as unknown as pg.Pool)
  for(const d of descriptors)if(!(await c.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+d.table])).rows[0].present)throw Error('team_capture_schema_required')
  if(!(await c.query("SELECT to_regprocedure('shared.mark_memory_source_dirty(text,text)') IS NOT NULL AS present")).rows[0].present)throw Error('shared_dirty_contract_required')
  await c.query('ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS team_capture_version INT NOT NULL DEFAULT 0')
  for(const sql of statements)await c.query(sql)
  await installRelayDeliveryPrivacyCapture(c as unknown as pg.Pool)
  await c.query(`CREATE OR REPLACE FUNCTION shared.assert_memory_team_capture() RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE version=1 AND team_capture_version=1 AND delivery_privacy_capture_version=1 AND delivery_source_set_capture_version=1)
    OR EXISTS(SELECT 1 FROM(VALUES ${expected},${DELIVERY_PRIVACY_EXPECTED}) expected(relation,trigger_name,function_name,trigger_type)
     WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.trigger_name
      AND t.tgfoid=to_regprocedure(expected.function_name) AND t.tgtype=expected.trigger_type AND t.tgenabled IN('O','A')))
    THEN RAISE EXCEPTION 'team_source_capture_required_before_bootstrap';END IF;END $$;
   REVOKE ALL ON FUNCTION shared.assert_memory_team_capture() FROM PUBLIC`)
  await c.query(`CREATE OR REPLACE FUNCTION shared.bootstrap_memory_team_roots(p_kind TEXT,p_after TEXT,p_limit INT)
   RETURNS TABLE(root_key TEXT,revision TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE r RECORD;v BIGINT;BEGIN
    IF p_kind IS NULL OR p_kind NOT IN('team_collaboration','team_delivery') OR p_after IS NULL OR length(p_after)>1024 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid_team_source_bootstrap';END IF;
    PERFORM shared.assert_memory_team_capture();
    IF p_kind='team_collaboration' THEN
     FOR r IN SELECT call_id AS root FROM public.collaboration_calls WHERE call_id COLLATE "C">p_after COLLATE "C" AND state IN ${terminal} ORDER BY call_id COLLATE "C" LIMIT p_limit
      LOOP v=shared.mark_memory_source_dirty(p_kind,r.root);RETURN QUERY SELECT r.root,v::text;END LOOP;
    ELSE
     FOR r IN SELECT source_session_id AS root FROM public.team_delivery_memory_sources WHERE source_session_id COLLATE "C">p_after COLLATE "C" ORDER BY source_session_id COLLATE "C" LIMIT p_limit
      LOOP v=shared.mark_memory_source_dirty(p_kind,r.root);RETURN QUERY SELECT r.root,v::text;END LOOP;
    END IF;END $$;
   REVOKE ALL ON FUNCTION shared.bootstrap_memory_team_roots(TEXT,TEXT,INT) FROM PUBLIC`)
  await c.query('UPDATE shared.memory_source_contract SET team_capture_version=1 WHERE version=1')
  await c.query('SELECT shared.assert_memory_team_capture()')
  await c.query('COMMIT')
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
export async function bootstrapTeamSourceRoots(pool:Pick<pg.Pool,'query'>,options:{kind:'team_collaboration'|'team_delivery';after:string;limit:number}){
 if(!['team_collaboration','team_delivery'].includes(options.kind)||typeof options.after!=='string'||options.after.length>1024||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>256)throw Error('invalid_team_source_bootstrap')
 const rows=(await pool.query('SELECT * FROM shared.bootstrap_memory_team_roots($1,$2,$3)',[options.kind,options.after,options.limit])).rows
 return {roots:rows.map(r=>({rootKey:r.root_key,revision:r.revision})),nextAfter:rows.at(-1)?.root_key??options.after}
}
