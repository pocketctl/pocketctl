import type pg from 'pg'
export async function initUsageAnalyticsSchema(db:Pick<pg.Pool,'query'>){await db.query(`
 CREATE TABLE IF NOT EXISTS usage_analytics_state(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),version INT NOT NULL,revision BIGINT NOT NULL DEFAULT 0,write_enabled BOOLEAN NOT NULL DEFAULT FALSE);
 INSERT INTO usage_analytics_state(singleton,version) VALUES(TRUE,1) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS usage_owner_revisions(owner_user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,revision BIGINT NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS usage_source_metadata(
  fact_key TEXT PRIMARY KEY,owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT NOT NULL,
  logical_usage_id TEXT NOT NULL,metadata JSONB NOT NULL,received_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS usage_token_projection(
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT NOT NULL,source_session TEXT NOT NULL,
  logical_usage_id TEXT NOT NULL,source_fact_key TEXT NOT NULL,accounting_version TEXT NOT NULL DEFAULT 'normalized-v1',
  source_revision_identity TEXT,revision BIGINT NOT NULL DEFAULT 0,agent_type TEXT NOT NULL,model TEXT NOT NULL,parent_session_id TEXT,child_agent_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ NOT NULL,time_basis TEXT NOT NULL,
  input BIGINT,output BIGINT,cache_read BIGINT,cache_create BIGINT,total BIGINT NOT NULL,requests BIGINT,
  request_id TEXT,quality TEXT NOT NULL,attribution_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(owner_user_id,daemon_id,source_session,logical_usage_id,accounting_version));
 ALTER TABLE usage_token_projection ADD COLUMN IF NOT EXISTS source_revision_identity TEXT;
 CREATE INDEX IF NOT EXISTS usage_tokens_owner_time ON usage_token_projection(owner_user_id,daemon_id,occurred_at);
 CREATE INDEX IF NOT EXISTS usage_tokens_session_time ON usage_token_projection(owner_user_id,source_session,occurred_at);
 CREATE TABLE IF NOT EXISTS usage_dirty_days(owner_user_id INT REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT,usage_date DATE,revision BIGINT NOT NULL DEFAULT 1,PRIMARY KEY(owner_user_id,daemon_id,usage_date));
 CREATE TABLE IF NOT EXISTS usage_call_facts(
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT NOT NULL,runtime TEXT NOT NULL,source_session TEXT NOT NULL,
  invocation_id TEXT NOT NULL,source_event_id BIGINT,revision BIGINT NOT NULL DEFAULT 0,tool_kind TEXT NOT NULL CHECK(tool_kind IN('builtin','mcp','unknown')),
  tool_name TEXT NOT NULL,mcp_server TEXT,occurred_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN('success','failure','unknown')),has_start BOOLEAN NOT NULL,quality TEXT NOT NULL,
  attribution_revoked BOOLEAN NOT NULL DEFAULT FALSE,PRIMARY KEY(owner_user_id,daemon_id,runtime,source_session,invocation_id));
 ALTER TABLE usage_call_facts ADD COLUMN IF NOT EXISTS start_revision BIGINT NOT NULL DEFAULT -1;
 ALTER TABLE usage_call_facts ADD COLUMN IF NOT EXISTS outcome_revision BIGINT NOT NULL DEFAULT -1;
 ALTER TABLE usage_call_facts ADD COLUMN IF NOT EXISTS start_identity TEXT;
 ALTER TABLE usage_call_facts ADD COLUMN IF NOT EXISTS outcome_identity TEXT;
 CREATE TABLE IF NOT EXISTS usage_call_event_metadata(owner_user_id INT REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT,runtime TEXT,source_session TEXT,invocation_id TEXT,event_identity TEXT,previous_identity TEXT,PRIMARY KEY(owner_user_id,daemon_id,runtime,source_session,invocation_id,event_identity));
 CREATE INDEX IF NOT EXISTS usage_calls_owner_time ON usage_call_facts(owner_user_id,daemon_id,occurred_at);
 CREATE INDEX IF NOT EXISTS usage_calls_session ON usage_call_facts(owner_user_id,source_session);
 CREATE TABLE IF NOT EXISTS usage_skill_facts(
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT NOT NULL,runtime TEXT NOT NULL,source_session TEXT NOT NULL,
  skill_invocation_id TEXT NOT NULL,skill_key TEXT NOT NULL,skill_name TEXT NOT NULL,occurred_at TIMESTAMPTZ NOT NULL,
  evidence_kind TEXT NOT NULL,evidence_version INT NOT NULL,attribution_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(owner_user_id,daemon_id,runtime,source_session,skill_invocation_id));
 CREATE INDEX IF NOT EXISTS usage_skills_owner_time ON usage_skill_facts(owner_user_id,daemon_id,occurred_at);
 CREATE TABLE IF NOT EXISTS usage_collection_coverage(
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT NOT NULL,agent_type TEXT NOT NULL,capability TEXT NOT NULL,
  from_at TIMESTAMPTZ NOT NULL,to_exclusive TIMESTAMPTZ NOT NULL,state TEXT NOT NULL CHECK(state IN('complete','partial','not_collected','unknown')),
  reason TEXT NOT NULL,source_cursor TEXT,last_synced_at TIMESTAMPTZ,PRIMARY KEY(owner_user_id,daemon_id,agent_type,capability,from_at),CHECK(from_at<to_exclusive));
 CREATE TABLE IF NOT EXISTS usage_backfill_checkpoints(owner_user_id INT REFERENCES users(id) ON DELETE CASCADE,cursor TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(owner_user_id));
 ALTER TABLE usage_source_metadata ADD COLUMN IF NOT EXISTS source_session TEXT;
 UPDATE usage_source_metadata m SET source_session=f.session_id FROM token_usage_facts f WHERE f.fact_key=m.fact_key AND m.source_session IS NULL;
 CREATE OR REPLACE FUNCTION usage_revision_precedes(p_owner INT,p_daemon TEXT,p_session TEXT,p_logical TEXT,p_earlier TEXT,p_later TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $chain$
 WITH RECURSIVE chain(event_id,depth) AS(SELECT p_later,0 UNION ALL SELECT m.metadata->>'previous_event_identity',c.depth+1 FROM chain c JOIN usage_source_metadata m ON m.owner_user_id=p_owner AND m.daemon_id=p_daemon AND m.source_session=p_session AND m.logical_usage_id=p_logical AND m.metadata->>'event_identity'=c.event_id WHERE c.depth<64 AND m.metadata->>'previous_event_identity' IS NOT NULL)
 SELECT p_earlier IS NOT NULL AND EXISTS(SELECT 1 FROM chain WHERE event_id=p_earlier AND depth>0) $chain$;
 CREATE OR REPLACE FUNCTION usage_current_session(p_owner INT,p_daemon TEXT,p_source TEXT) RETURNS TEXT LANGUAGE SQL STABLE AS $authority$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM session_aliases WHERE old_session_id=p_source) THEN CASE WHEN a->>'state'='current' THEN a->>'sessionId' END ELSE (SELECT session_id FROM sessions WHERE session_id=p_source AND user_id=p_owner AND daemon_id=p_daemon AND content_state NOT IN('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM deleted_sessions WHERE session_id=p_source)) END FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM session_aliases WHERE old_session_id=p_source) THEN native_session_authority(p_source,p_owner,p_daemon) END AS a) q $authority$;
 CREATE OR REPLACE VIEW usage_session_authority AS
 SELECT s.user_id AS owner_user_id,s.daemon_id,s.session_id AS source_session,s.session_id AS current_session FROM sessions s WHERE s.user_id IS NOT NULL AND s.content_state NOT IN('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM deleted_sessions d WHERE d.session_id=s.session_id)
 UNION ALL SELECT a.owner_user_id,s.daemon_id,a.old_session_id,s.session_id FROM session_aliases a CROSS JOIN LATERAL (SELECT native_session_authority(a.old_session_id,a.owner_user_id,a.original_daemon_id) AS authority) n JOIN sessions s ON s.session_id=n.authority->>'sessionId' AND s.user_id=a.owner_user_id WHERE NOT a.blocked AND n.authority->>'state'='current';
 CREATE OR REPLACE FUNCTION usage_source_daemon_provenance() RETURNS TRIGGER LANGUAGE plpgsql AS $provenance$ BEGIN
 IF TG_OP='INSERT' THEN NEW.original_daemon_id:=COALESCE(NEW.original_daemon_id,NEW.daemon_id);NEW.original_daemon_basis:=COALESCE(NEW.original_daemon_basis,'capture');
 ELSIF (NEW.original_daemon_id,NEW.original_daemon_basis) IS DISTINCT FROM(OLD.original_daemon_id,OLD.original_daemon_basis) THEN RAISE EXCEPTION 'immutable usage source daemon';END IF;RETURN NEW;END $provenance$;
 ALTER TABLE usage_source_metadata ADD COLUMN IF NOT EXISTS original_daemon_id TEXT;ALTER TABLE usage_source_metadata ADD COLUMN IF NOT EXISTS original_daemon_basis TEXT;UPDATE usage_source_metadata SET original_daemon_id=daemon_id,original_daemon_basis='observed_baseline' WHERE original_daemon_id IS NULL;DROP TRIGGER IF EXISTS usage_source_daemon_provenance ON usage_source_metadata;CREATE TRIGGER usage_source_daemon_provenance BEFORE INSERT OR UPDATE ON usage_source_metadata FOR EACH ROW EXECUTE FUNCTION usage_source_daemon_provenance();
 ALTER TABLE usage_token_projection ADD COLUMN IF NOT EXISTS original_daemon_id TEXT;ALTER TABLE usage_token_projection ADD COLUMN IF NOT EXISTS original_daemon_basis TEXT;UPDATE usage_token_projection SET original_daemon_id=daemon_id,original_daemon_basis='observed_baseline' WHERE original_daemon_id IS NULL;DROP TRIGGER IF EXISTS usage_source_daemon_provenance ON usage_token_projection;CREATE TRIGGER usage_source_daemon_provenance BEFORE INSERT OR UPDATE ON usage_token_projection FOR EACH ROW EXECUTE FUNCTION usage_source_daemon_provenance();
 ALTER TABLE usage_call_facts ADD COLUMN IF NOT EXISTS original_daemon_id TEXT;ALTER TABLE usage_call_facts ADD COLUMN IF NOT EXISTS original_daemon_basis TEXT;UPDATE usage_call_facts SET original_daemon_id=daemon_id,original_daemon_basis='observed_baseline' WHERE original_daemon_id IS NULL;DROP TRIGGER IF EXISTS usage_source_daemon_provenance ON usage_call_facts;CREATE TRIGGER usage_source_daemon_provenance BEFORE INSERT OR UPDATE ON usage_call_facts FOR EACH ROW EXECUTE FUNCTION usage_source_daemon_provenance();
 ALTER TABLE usage_skill_facts ADD COLUMN IF NOT EXISTS original_daemon_id TEXT;ALTER TABLE usage_skill_facts ADD COLUMN IF NOT EXISTS original_daemon_basis TEXT;UPDATE usage_skill_facts SET original_daemon_id=daemon_id,original_daemon_basis='observed_baseline' WHERE original_daemon_id IS NULL;DROP TRIGGER IF EXISTS usage_source_daemon_provenance ON usage_skill_facts;CREATE TRIGGER usage_source_daemon_provenance BEFORE INSERT OR UPDATE ON usage_skill_facts FOR EACH ROW EXECUTE FUNCTION usage_source_daemon_provenance();
 ALTER TABLE usage_call_event_metadata ADD COLUMN IF NOT EXISTS original_daemon_id TEXT;ALTER TABLE usage_call_event_metadata ADD COLUMN IF NOT EXISTS original_daemon_basis TEXT;UPDATE usage_call_event_metadata SET original_daemon_id=daemon_id,original_daemon_basis='observed_baseline' WHERE original_daemon_id IS NULL;DROP TRIGGER IF EXISTS usage_source_daemon_provenance ON usage_call_event_metadata;CREATE TRIGGER usage_source_daemon_provenance BEFORE INSERT OR UPDATE ON usage_call_event_metadata FOR EACH ROW EXECUTE FUNCTION usage_source_daemon_provenance();
 CREATE OR REPLACE FUNCTION usage_project_token_fact(f token_usage_facts) RETURNS VOID LANGUAGE plpgsql AS $usage$
 DECLARE source_identity TEXT; m JSONB; metadata_known BOOLEAN:=FALSE; envelope JSONB; event_identity TEXT; previous_identity TEXT; identity TEXT; occurred TIMESTAMPTZ; basis TEXT:='receipt_fallback'; qual TEXT:='legacy_unverified'; inp BIGINT; outp BIGINT; cr BIGINT; cc BIGINT; req BIGINT; total_value BIGINT; prior usage_token_projection; rev BIGINT:=0;
 BEGIN
 IF NOT EXISTS(SELECT 1 FROM usage_analytics_state WHERE write_enabled) THEN RETURN;END IF;
 source_identity:=COALESCE((SELECT a->>'originSessionId' FROM (SELECT native_session_authority(f.session_id,f.user_id,f.daemon_id) AS a) q WHERE a->>'state'='current'),f.session_id);
 SELECT metadata INTO m FROM usage_source_metadata WHERE fact_key=f.fact_key;metadata_known:=FOUND;
 SELECT COALESCE(payload,body_header) INTO envelope FROM events WHERE id=f.source_event_id;
 IF m IS NULL THEN m:=envelope->'usage_meta';END IF;
 event_identity:=COALESCE(NULLIF(m->>'event_identity',''),left(envelope->>'event_id',300));previous_identity:=COALESCE(NULLIF(m->>'previous_event_identity',''),left(envelope->>'previous_event_id',300));
 inp:=f.input;outp:=f.output;cr:=f.cache_read;cc:=f.cache_create;total_value:=inp+outp+cr+cc;occurred:=f.recorded_at;
 identity:=f.fact_key;
 IF jsonb_typeof(m)='object' AND m->>'version'='1' AND COALESCE(m->>'revision','0') ~ '^[0-9]{1,16}$' AND length(m->>'source_usage_id') BETWEEN 1 AND 200 AND m->>'mode' IN('delta','cumulative') THEN
  identity:=m->>'source_usage_id';rev:=GREATEST(COALESCE((m->>'revision')::bigint,0),0);qual:=CASE WHEN m->>'input_semantics' IN('includes_cache','excludes_cache') THEN 'normalized' ELSE 'unknown_cache_semantics' END;
  IF m->>'input_semantics'='includes_cache' THEN
   IF inp<cr+cc THEN qual:='invalid_inclusive_cache';ELSE inp:=inp-cr-cc;END IF;
  END IF;
  total_value:=inp+outp+cr+cc;
  BEGIN occurred:=(m->>'occurred_at')::timestamptz;EXCEPTION WHEN OTHERS THEN occurred:=NULL;END;
  IF occurred IS NOT NULL AND occurred>='2000-01-01'::timestamptz AND occurred<=f.recorded_at+INTERVAL '5 minutes' THEN basis:='source';ELSE occurred:=f.recorded_at;END IF;
  IF length(m->>'request_id') BETWEEN 1 AND 200 THEN req:=1;END IF;
 ELSE inp:=NULL;outp:=NULL;cr:=NULL;cc:=NULL;END IF;
 IF qual<>'normalized' THEN inp:=NULL;outp:=NULL;cr:=NULL;cc:=NULL;req:=NULL;total_value:=f.input+f.output+f.cache_read+f.cache_create;END IF;
 INSERT INTO usage_source_metadata(fact_key,owner_user_id,daemon_id,logical_usage_id,metadata,received_at,source_session) VALUES(f.fact_key,f.user_id,f.daemon_id,identity,jsonb_build_object('event_identity',event_identity,'previous_event_identity',previous_identity,'version',CASE WHEN qual IN('normalized','unknown_cache_semantics','invalid_inclusive_cache') THEN 1 ELSE 0 END,'provider',left(m->>'provider',100),'source_usage_id',CASE WHEN qual IN('normalized','unknown_cache_semantics','invalid_inclusive_cache') THEN identity END,'request_id',CASE WHEN req IS NOT NULL THEN left(m->>'request_id',200) END,'revision',rev,'mode',left(m->>'mode',20),'occurred_at',left(m->>'occurred_at',80),'model',left(m->>'model',200),'agent_type',left(m->>'agent_type',100),'input_semantics',left(m->>'input_semantics',30),'parent_session_id',CASE WHEN EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=m->>'parent_session_id' AND s.user_id=f.user_id AND s.daemon_id=f.daemon_id) THEN left(m->>'parent_session_id',100) END,'child_agent_id',COALESCE(left(m->>'child_agent_id',100),CASE WHEN envelope->>'is_subagent'='true' THEN left(envelope->>'agent_id',100) END)),f.recorded_at,source_identity) ON CONFLICT DO NOTHING;
 SELECT * INTO prior FROM usage_token_projection WHERE owner_user_id=f.user_id AND daemon_id=f.daemon_id AND source_session=source_identity AND logical_usage_id=identity AND accounting_version='normalized-v1' FOR UPDATE;
 IF FOUND THEN
  IF usage_revision_precedes(f.user_id,f.daemon_id,source_identity,identity,event_identity,prior.source_revision_identity) THEN RETURN;END IF;
  IF event_identity IS NOT NULL AND event_identity=prior.source_revision_identity THEN RETURN;END IF;
  IF rev<=prior.revision THEN
   IF usage_revision_precedes(f.user_id,f.daemon_id,source_identity,identity,prior.source_revision_identity,event_identity) THEN rev:=prior.revision+1;
   ELSE
    IF rev>0 AND rev<prior.revision THEN RETURN;END IF;
    IF (prior.total,prior.model,prior.occurred_at,prior.input,prior.output,prior.cache_read,prior.cache_create) IS DISTINCT FROM (total_value,COALESCE(NULLIF(left(m->>'model',200),''),'unknown'),occurred,inp,outp,cr,cc) THEN
     UPDATE usage_token_projection SET quality='revision_order_unverified',input=NULL,output=NULL,cache_read=NULL,cache_create=NULL WHERE owner_user_id=f.user_id AND daemon_id=f.daemon_id AND source_session=source_identity AND logical_usage_id=identity AND accounting_version='normalized-v1';
     INSERT INTO usage_collection_coverage(owner_user_id,daemon_id,agent_type,capability,from_at,to_exclusive,state,reason) VALUES(f.user_id,f.daemon_id,f.agent_type,'tokens',LEAST(occurred,f.recorded_at),GREATEST(occurred,f.recorded_at)+INTERVAL '1 microsecond','partial','revision_order_unverified') ON CONFLICT DO NOTHING;
    END IF;RETURN;
   END IF;
  END IF;
 END IF;
 INSERT INTO usage_token_projection(owner_user_id,daemon_id,source_session,logical_usage_id,source_fact_key,source_revision_identity,revision,agent_type,model,parent_session_id,child_agent_id,occurred_at,received_at,time_basis,input,output,cache_read,cache_create,total,requests,request_id,quality,attribution_revoked,original_daemon_id,original_daemon_basis)
 VALUES(f.user_id,f.daemon_id,source_identity,identity,f.fact_key,event_identity,rev,COALESCE(NULLIF(left(m->>'agent_type',100),''),f.agent_type,'unknown'),COALESCE(NULLIF(left(m->>'model',200),''),'unknown'),CASE WHEN EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=m->>'parent_session_id' AND s.user_id=f.user_id AND s.daemon_id=f.daemon_id) THEN left(m->>'parent_session_id',100) END,COALESCE(left(m->>'child_agent_id',100),CASE WHEN envelope->>'is_subagent'='true' THEN left(envelope->>'agent_id',100) END),occurred,f.recorded_at,basis,inp,outp,cr,cc,total_value,req,CASE WHEN req IS NOT NULL THEN m->>'request_id' END,qual,f.session_attribution_revoked,(SELECT original_daemon_id FROM usage_source_metadata WHERE fact_key=f.fact_key),(SELECT original_daemon_basis FROM usage_source_metadata WHERE fact_key=f.fact_key))
 ON CONFLICT(owner_user_id,daemon_id,source_session,logical_usage_id,accounting_version) DO UPDATE SET source_fact_key=EXCLUDED.source_fact_key,source_revision_identity=EXCLUDED.source_revision_identity,revision=EXCLUDED.revision,agent_type=EXCLUDED.agent_type,model=EXCLUDED.model,occurred_at=EXCLUDED.occurred_at,received_at=EXCLUDED.received_at,time_basis=EXCLUDED.time_basis,input=EXCLUDED.input,output=EXCLUDED.output,cache_read=EXCLUDED.cache_read,cache_create=EXCLUDED.cache_create,total=EXCLUDED.total,requests=EXCLUDED.requests,request_id=EXCLUDED.request_id,quality=EXCLUDED.quality,parent_session_id=EXCLUDED.parent_session_id,child_agent_id=EXCLUDED.child_agent_id,attribution_revoked=usage_token_projection.attribution_revoked OR EXCLUDED.attribution_revoked;
 INSERT INTO usage_dirty_days VALUES(f.user_id,f.daemon_id,(occurred AT TIME ZONE 'UTC')::date,1) ON CONFLICT(owner_user_id,daemon_id,usage_date) DO UPDATE SET revision=usage_dirty_days.revision+1;
 IF prior.occurred_at IS NOT NULL THEN INSERT INTO usage_dirty_days VALUES(f.user_id,f.daemon_id,(prior.occurred_at AT TIME ZONE 'UTC')::date,1) ON CONFLICT(owner_user_id,daemon_id,usage_date) DO UPDATE SET revision=usage_dirty_days.revision+1;END IF;

 END $usage$;
 CREATE SEQUENCE IF NOT EXISTS usage_change_revision;
 CREATE TABLE IF NOT EXISTS usage_scope_changes(owner_user_id INT REFERENCES users(id) ON DELETE CASCADE,daemon_id TEXT NOT NULL,from_at TIMESTAMPTZ NOT NULL,to_exclusive TIMESTAMPTZ NOT NULL,revision BIGINT NOT NULL DEFAULT nextval('usage_change_revision'));
 CREATE INDEX IF NOT EXISTS usage_scope_changes_scope ON usage_scope_changes(owner_user_id,daemon_id,revision DESC);
 CREATE OR REPLACE FUNCTION usage_record_change() RETURNS TRIGGER LANGUAGE plpgsql AS $change$ DECLARE value JSONB;point TIMESTAMPTZ;finish TIMESTAMPTZ; BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=COALESCE((to_jsonb(NEW)->>'owner_user_id')::int,(to_jsonb(OLD)->>'owner_user_id')::int)) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN value:=to_jsonb(OLD);point:=COALESCE((value->>'occurred_at')::timestamptz,(value->>'from_at')::timestamptz);finish:=COALESCE((value->>'to_exclusive')::timestamptz,point+INTERVAL '1 microsecond');INSERT INTO usage_scope_changes(owner_user_id,daemon_id,from_at,to_exclusive) VALUES((value->>'owner_user_id')::int,value->>'daemon_id',point,finish);END IF;
 IF TG_OP<>'DELETE' THEN value:=to_jsonb(NEW);point:=COALESCE((value->>'occurred_at')::timestamptz,(value->>'from_at')::timestamptz);finish:=COALESCE((value->>'to_exclusive')::timestamptz,point+INTERVAL '1 microsecond');INSERT INTO usage_scope_changes(owner_user_id,daemon_id,from_at,to_exclusive) VALUES((value->>'owner_user_id')::int,value->>'daemon_id',point,finish);END IF;RETURN NULL;END $change$;
 DROP TRIGGER IF EXISTS usage_scope_change ON usage_token_projection;CREATE TRIGGER usage_scope_change AFTER INSERT OR UPDATE OR DELETE ON usage_token_projection FOR EACH ROW EXECUTE FUNCTION usage_record_change();
 DROP TRIGGER IF EXISTS usage_scope_change ON usage_call_facts;CREATE TRIGGER usage_scope_change AFTER INSERT OR UPDATE OR DELETE ON usage_call_facts FOR EACH ROW EXECUTE FUNCTION usage_record_change();
 DROP TRIGGER IF EXISTS usage_scope_change ON usage_skill_facts;CREATE TRIGGER usage_scope_change AFTER INSERT OR UPDATE OR DELETE ON usage_skill_facts FOR EACH ROW EXECUTE FUNCTION usage_record_change();
 DROP TRIGGER IF EXISTS usage_scope_change ON usage_collection_coverage;CREATE TRIGGER usage_scope_change AFTER INSERT OR UPDATE OR DELETE ON usage_collection_coverage FOR EACH ROW EXECUTE FUNCTION usage_record_change();
 CREATE OR REPLACE FUNCTION usage_token_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ DECLARE owner_id INT; BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN owner_id:=OLD.owner_user_id;ELSE owner_id:=NEW.owner_user_id;END IF;
 IF EXISTS(SELECT 1 FROM users WHERE id=owner_id) THEN INSERT INTO usage_owner_revisions VALUES(owner_id,1) ON CONFLICT(owner_user_id) DO UPDATE SET revision=usage_owner_revisions.revision+1;END IF;RETURN NULL;END $usage$;
 DROP TRIGGER IF EXISTS usage_token_revision ON usage_token_projection;
 CREATE TRIGGER usage_token_revision AFTER INSERT OR UPDATE OR DELETE ON usage_token_projection FOR EACH ROW EXECUTE FUNCTION usage_token_revision();
 DROP TRIGGER IF EXISTS usage_coverage_revision ON usage_collection_coverage;
 CREATE TRIGGER usage_coverage_revision AFTER INSERT OR UPDATE OR DELETE ON usage_collection_coverage FOR EACH ROW EXECUTE FUNCTION usage_token_revision();
 CREATE OR REPLACE FUNCTION usage_call_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ BEGIN
 IF TG_OP='INSERT' OR (NEW.tool_kind,NEW.tool_name,NEW.mcp_server,NEW.occurred_at,NEW.outcome,NEW.has_start,NEW.attribution_revoked) IS DISTINCT FROM (OLD.tool_kind,OLD.tool_name,OLD.mcp_server,OLD.occurred_at,OLD.outcome,OLD.has_start,OLD.attribution_revoked) THEN INSERT INTO usage_owner_revisions VALUES(NEW.owner_user_id,1) ON CONFLICT(owner_user_id) DO UPDATE SET revision=usage_owner_revisions.revision+1;END IF;RETURN NULL;END $usage$;
 DROP TRIGGER IF EXISTS usage_call_revision ON usage_call_facts;
 CREATE TRIGGER usage_call_revision AFTER INSERT OR UPDATE ON usage_call_facts FOR EACH ROW EXECUTE FUNCTION usage_call_revision();
 CREATE OR REPLACE FUNCTION usage_skill_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ BEGIN INSERT INTO usage_owner_revisions VALUES(NEW.owner_user_id,1) ON CONFLICT(owner_user_id) DO UPDATE SET revision=usage_owner_revisions.revision+1;RETURN NULL;END $usage$;
 DROP TRIGGER IF EXISTS usage_skill_revision ON usage_skill_facts;
 CREATE TRIGGER usage_skill_revision AFTER INSERT OR UPDATE ON usage_skill_facts FOR EACH ROW EXECUTE FUNCTION usage_skill_revision();
 CREATE OR REPLACE FUNCTION usage_token_fact_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $usage$ BEGIN
 IF TG_OP='INSERT' THEN PERFORM usage_project_token_fact(NEW);ELSE UPDATE usage_token_projection SET attribution_revoked=NEW.session_attribution_revoked WHERE owner_user_id=NEW.user_id AND source_session=NEW.session_id;END IF;RETURN NEW;END $usage$;
 DROP TRIGGER IF EXISTS usage_token_fact_capture ON token_usage_facts;
 CREATE TRIGGER usage_token_fact_capture AFTER INSERT OR UPDATE OF session_attribution_revoked ON token_usage_facts FOR EACH ROW EXECUTE FUNCTION usage_token_fact_capture();
 `)
 if(process.env.PERSONAL_USAGE_WRITE==='true')await db.query('UPDATE usage_analytics_state SET write_enabled=TRUE')
}
export async function readUsageAnalyticsSchemaCapabilities(db:Pick<pg.Pool,'query'>){
 const r=await db.query(`
  SELECT to_regclass('public.usage_analytics_state') IS NOT NULL AS ready,
   EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid=to_regclass('public.usage_scope_changes') AND attname='legacy_day'
      AND attnum>0 AND NOT attisdropped) AS history_watermark
 `)
 if(!r.rows[0]?.ready)throw Error('usage_schema_migrator_required')
 const v=await db.query('SELECT version,write_enabled FROM usage_analytics_state')
 if(v.rows.length!==1||v.rows[0].version!==1)throw Error('usage_schema_unsupported')
 // The database switch activates token-fact triggers independently of the
 // process flag. A missing nextval capability otherwise rolls back ingress.
 if(v.rows[0].write_enabled===true||process.env.PERSONAL_USAGE_WRITE==='true'){
  const capability=await db.query("SELECT COALESCE(has_sequence_privilege(current_user,to_regclass('public.usage_change_revision'),'USAGE'),FALSE) AS ready")
  if(!capability.rows[0]?.ready)throw Error('usage_change_sequence_usage_required')
 }
 return {historyWatermark:r.rows[0].history_watermark===true}
}

export async function assertUsageAnalyticsSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
 await readUsageAnalyticsSchemaCapabilities(db)
}
