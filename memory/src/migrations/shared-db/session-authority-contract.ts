// Standalone feed installations continue to lock the row that owns their
// session. The shared installer replaces this entry point with native access.
export const SESSION_AUTHORITY_MIGRATION={version:108,statements:[
 `CREATE FUNCTION memory_legacy_session_available(i UUID,s TEXT,locked BOOLEAN) RETURNS BOOLEAN
  LANGUAGE plpgsql AS $$ BEGIN
   IF locked THEN PERFORM 1 FROM source_sessions WHERE installation_id=i AND session_id=s AND deleted_at IS NULL FOR SHARE;
   ELSE PERFORM 1 FROM source_sessions WHERE installation_id=i AND session_id=s AND deleted_at IS NULL;
   END IF;
   RETURN FOUND AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones WHERE installation_id=i AND session_id=s);
  END $$`,
 `CREATE FUNCTION memory_session_available(i UUID,s TEXT,locked BOOLEAN) RETURNS BOOLEAN
  LANGUAGE sql AS $$ SELECT memory_legacy_session_available(i,s,locked) $$`,
 `CREATE FUNCTION memory_session_first_recorded_at(i UUID,s TEXT) RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
 SELECT first_recorded_at FROM source_sessions WHERE installation_id=i AND session_id=s AND deleted_at IS NULL $$`,
]} as const

export const SHARED_SESSION_AUTHORITY=[
 `CREATE OR REPLACE FUNCTION memory.memory_session_available(i UUID,s TEXT,locked BOOLEAN) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$
 DECLARE ctx JSONB;roster JSONB;pub RECORD;source_scope JSONB;archive_version RECORD;key TEXT;BEGIN
  IF i IS NULL OR s IS NULL OR locked IS NULL OR EXISTS(SELECT 1 FROM memory.memory_session_tombstones t
   WHERE t.installation_id=i AND t.session_id=s) THEN RETURN FALSE;END IF;
  SELECT p.source_kind,p.source_roster,p.native_publication_proof INTO pub FROM memory.memory_team_semantic_publications p
   WHERE p.installation_id=i AND p.semantic_session_id=s AND p.disposition IN('published','legacy_related');
  IF FOUND THEN
   roster=shared.read_memory_team_semantic_group(i,pub.source_kind,pub.source_roster->>'seed');
   RETURN COALESCE(roster->'publication'=pub.native_publication_proof AND roster->>'admission'='eligible'
    AND roster->>'withdrawn'='false' AND (roster->>'supportCount')::int>0
    AND (NOT locked OR shared.lock_memory_team_semantic_group(NULL,roster,TRUE)),FALSE);
  END IF;
  IF shared.uses_turn_dialogue(i) THEN
   ctx=shared.memory_dialogue_context(i,s);
   IF ctx IS NOT NULL THEN RETURN NOT locked OR shared.lock_memory_personal_source_commit(ctx->'scope','relay_event',ctx->>'root',ctx->'version',FALSE);END IF;
  END IF;
   SELECT jsonb_build_object('installationId',i,'principalUserId',a.owner_user_id::text,'ownerScopeKind','personal',
    'ownerScopeId',inst.owner_scope_id,'authorizationRevision',inst.authorization_epoch::text,'configVersion',inst.config_version::text,
    'modeGeneration',m.generation::text),a.owner_user_id::text||':'||s INTO source_scope,key
    FROM shared.memory_archive_records a JOIN public.extension_installations inst USING(installation_id)
    JOIN shared.memory_source_modes m USING(installation_id) WHERE a.installation_id=i AND a.session_id=s
     AND inst.owner_user_id=a.owner_user_id AND inst.owner_scope_kind='personal' LIMIT 1;
   IF FOUND THEN
   SELECT * INTO archive_version FROM shared.memory_retained_relay_authority(source_scope,'legacy_archive',key);
   RETURN archive_version.state='current' AND (NOT locked OR shared.lock_memory_personal_source_commit(source_scope,'legacy_archive',key,
    jsonb_build_object('content',archive_version.content_revision,'authorization',archive_version.authorization_revision,'storage',archive_version.storage_revision),TRUE));
   END IF;
  RETURN FALSE;
 END $$`,
 `CREATE OR REPLACE FUNCTION memory.memory_session_first_recorded_at(i UUID,s TEXT) RETURNS TIMESTAMPTZ
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$
 DECLARE started TIMESTAMPTZ;ctx JSONB;authority JSONB;BEGIN
  IF NOT memory.memory_session_available(i,s,FALSE) THEN RETURN NULL;END IF;
  SELECT min(g.occurred_at) INTO started FROM memory.memory_team_semantic_groups g
   JOIN memory.memory_team_semantic_publications p USING(installation_id,semantic_turn_id)
   WHERE g.installation_id=i AND g.semantic_session_id=s AND g.registration_state='published'
    AND p.disposition IN('published','legacy_related');
  IF started IS NOT NULL THEN RETURN started;END IF;
  ctx=shared.memory_dialogue_context(i,s);
  IF ctx IS NOT NULL THEN
    authority=public.native_session_authority(s,(ctx#>>'{scope,principalUserId}')::int,NULL);
    IF authority->>'state'='current' THEN
     SELECT created_at INTO started FROM public.sessions WHERE session_id=authority->>'sessionId';
    END IF;
   RETURN started;
  END IF;
  SELECT min(occurred_at) INTO started FROM shared.memory_archive_records WHERE installation_id=i AND session_id=s;
  RETURN started;
 END $$`,
 `REVOKE ALL ON FUNCTION memory.memory_session_first_recorded_at(UUID,TEXT) FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION memory.memory_session_available(UUID,TEXT,BOOLEAN) FROM PUBLIC`,
 // Polymorphic session identities use the original source's lock. Both
 // tables already observe session tombstones. Preserve physical legacy deletes
 // for installations where a feed session is still the surviving authority.
 `CREATE OR REPLACE FUNCTION memory.guard_skill_session_reference() RETURNS TRIGGER LANGUAGE plpgsql
  SET search_path=pg_catalog,memory AS $$ BEGIN
   IF NEW.session_id IS NULL THEN RETURN NEW;END IF;
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:session:'||NEW.installation_id||':'||NEW.session_id,0))
      OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||NEW.installation_id,0)) THEN
     RAISE EXCEPTION 'source_privacy_fence_busy' USING ERRCODE='55P03';END IF;
   IF memory.memory_session_available(NEW.installation_id,NEW.session_id,TRUE) IS NOT TRUE THEN
    RAISE EXCEPTION 'skill_session_unavailable' USING ERRCODE='23503';END IF;
   RETURN NEW;
 END $$`,
 `CREATE OR REPLACE FUNCTION memory.remove_unavailable_skill_session() RETURNS TRIGGER LANGUAGE plpgsql
 SET search_path=pg_catalog,memory AS $$ BEGIN
  IF memory.memory_session_available(OLD.installation_id,OLD.session_id,FALSE) IS NOT TRUE THEN
   DELETE FROM memory.memory_skill_executions WHERE installation_id=OLD.installation_id AND session_id=OLD.session_id;
   DELETE FROM memory.memory_skill_replay_cases WHERE installation_id=OLD.installation_id AND session_id=OLD.session_id;
  END IF;
  RETURN NULL;
 END $$`,
 `DO $$ BEGIN IF to_regclass('memory.source_sessions') IS NOT NULL THEN
   DROP TRIGGER IF EXISTS remove_unavailable_skill_session ON memory.source_sessions;
   CREATE TRIGGER remove_unavailable_skill_session AFTER DELETE ON memory.source_sessions FOR EACH ROW
     EXECUTE FUNCTION memory.remove_unavailable_skill_session();
 END IF;END $$`,
 ...['memory_skill_executions','memory_skill_replay_cases'].map(table=>`
  ALTER TABLE memory.${table} DROP CONSTRAINT IF EXISTS ${table}_installation_id_session_id_fkey;
  DROP TRIGGER IF EXISTS guard_skill_session_reference ON memory.${table};
  CREATE TRIGGER guard_skill_session_reference BEFORE INSERT OR UPDATE OF session_id,installation_id ON memory.${table}
   FOR EACH ROW EXECUTE FUNCTION memory.guard_skill_session_reference()`),
] as const
