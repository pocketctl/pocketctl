/** Enrollment belongs to the shared migrator. Runtime roles cannot select another
 * installation's sources by supplying their own owner or grant fields. */
export const TURN_DIALOGUE_SCHEMA = [
  `CREATE UNIQUE INDEX IF NOT EXISTS work_episodes_session_turn ON memory.work_episodes(installation_id,session_id,turn_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS work_episodes_projected_turn ON memory.work_episodes(installation_id,turn_id)
   WHERE compiler_version<>'relay-turn-v1'`,
  `ALTER TABLE memory.work_episodes DROP CONSTRAINT IF EXISTS work_episodes_installation_id_turn_id_key`,
  `ALTER TABLE memory.work_episodes ADD COLUMN IF NOT EXISTS dialogue_completion JSONB`,
  `ALTER TABLE memory.memory_task_bundles ADD COLUMN IF NOT EXISTS dialogue_members JSONB`,
  `CREATE TABLE IF NOT EXISTS shared.memory_dialogue_installations (
   installation_id UUID PRIMARY KEY REFERENCES public.extension_installations ON DELETE CASCADE,
   enabled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
  `CREATE OR REPLACE FUNCTION shared.check_dialogue_enrollment() RETURNS TRIGGER LANGUAGE plpgsql
 SET search_path=pg_catalog,shared AS $$ BEGIN
  IF (SELECT count(*) FROM pg_index WHERE indisvalid AND indrelid='public.events'::regclass AND indexrelid IN(
    to_regclass('public.events_dialogue_turn'),to_regclass('public.events_dialogue_control'),to_regclass('public.events_dialogue_message'),to_regclass('public.events_dialogue_stream'),to_regclass('public.events_dialogue_operation')))<>5
   OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.events'::regclass AND tgname IN('turn_dialogue_insert','turn_dialogue_update','turn_dialogue_delete') AND tgenabled IN('O','A'))<>3
   OR NOT EXISTS(SELECT 1 FROM public.extension_installations i JOIN shared.memory_source_modes m USING(installation_id)
    WHERE i.installation_id=NEW.installation_id AND i.provider_id='pocketctl-memory' AND i.owner_scope_kind='personal' AND m.mode='shared-active')
   THEN RAISE EXCEPTION 'turn_dialogue_capture_not_ready';END IF; RETURN NEW;
 END $$`,
  `DROP TRIGGER IF EXISTS check_dialogue_enrollment ON shared.memory_dialogue_installations;
 CREATE TRIGGER check_dialogue_enrollment BEFORE INSERT OR UPDATE ON shared.memory_dialogue_installations FOR EACH ROW EXECUTE FUNCTION shared.check_dialogue_enrollment()`,
  `CREATE TABLE IF NOT EXISTS memory.memory_dialogue_gaps(
   installation_id UUID REFERENCES memory.memory_installations ON DELETE CASCADE,session_id TEXT,turn_id TEXT,reason TEXT NOT NULL,
   first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(installation_id,session_id,turn_id))`,
  `CREATE TABLE IF NOT EXISTS shared.memory_dialogue_pending(
   installation_id UUID REFERENCES shared.memory_dialogue_installations ON DELETE CASCADE,
   session_id TEXT,turn_id TEXT,enqueued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),touched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
   PRIMARY KEY(installation_id,session_id,turn_id))`,
  `CREATE INDEX IF NOT EXISTS memory_dialogue_pending_age ON shared.memory_dialogue_pending(enqueued_at)`,
  `CREATE OR REPLACE FUNCTION shared.dispatch_turn_dialogues() RETURNS INT LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$ DECLARE count_jobs INT;BEGIN
  WITH batch AS MATERIALIZED(SELECT * FROM shared.memory_dialogue_pending ORDER BY enqueued_at LIMIT 64 FOR UPDATE SKIP LOCKED),
  sent AS (INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
   SELECT gen_random_uuid(),installation_id,'compile_episode','dialogue:'||encode(sha256(convert_to(jsonb_build_array(session_id,turn_id)::text,'UTF8')),'hex'),80,jsonb_build_object('dialogue_session',session_id,'turn',turn_id)
   FROM batch ORDER BY installation_id,turn_id
   ON CONFLICT(installation_id,job_type,idempotency_key) DO UPDATE SET
    state=CASE WHEN memory_jobs.state='running' THEN 'running' ELSE 'pending' END,
    attempts=CASE WHEN memory_jobs.state='running' THEN memory_jobs.attempts ELSE 0 END,available_at=now(),
    last_error_code=CASE WHEN memory_jobs.state='running' THEN 'rerun_required' END,completed_at=NULL)
  DELETE FROM shared.memory_dialogue_pending p USING batch b WHERE (p.installation_id,p.session_id,p.turn_id)=(b.installation_id,b.session_id,b.turn_id);
  GET DIAGNOSTICS count_jobs=ROW_COUNT; RETURN count_jobs;
 END $$`,
  `CREATE OR REPLACE FUNCTION shared.uses_turn_dialogue(p_install UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER
   SET search_path=pg_catalog,shared AS $$ SELECT EXISTS(SELECT 1 FROM shared.memory_dialogue_installations p
    JOIN shared.memory_source_modes m USING(installation_id) WHERE installation_id=p_install AND m.mode='shared-active') $$`,
  `CREATE OR REPLACE FUNCTION shared.memory_dialogue_context(p_install UUID,p_session TEXT)
 RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE scope JSONB;root TEXT;authority RECORD;BEGIN
  SELECT jsonb_build_object('installationId',i.installation_id,'principalUserId',i.owner_user_id::text,
    'ownerScopeKind','personal','ownerScopeId',i.owner_scope_id,'authorizationRevision',i.authorization_epoch::text,
    'configVersion',i.config_version::text,'modeGeneration',m.generation::text),i.owner_user_id::text||':'||p_session
   INTO scope,root FROM shared.memory_dialogue_installations policy
   JOIN public.extension_installations i USING(installation_id)
   JOIN shared.memory_source_modes m USING(installation_id) JOIN memory.memory_installations local USING(installation_id)
   WHERE policy.installation_id=p_install AND m.mode='shared-active' AND i.owner_scope_kind='personal'
    AND local.local_status NOT IN('purged','purging','integrity_error') AND local.relay_status='active';
  IF scope IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO authority FROM shared.memory_relay_source_authority(scope,'relay_event',root);
  IF authority.state IS DISTINCT FROM 'current' THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('scope',scope,'root',root,'version',jsonb_build_object('content',authority.content_revision,
    'authorization',authority.authorization_revision,'storage',authority.storage_revision));
 END $$`,
  `CREATE OR REPLACE FUNCTION shared.memory_dialogue_members(p_install UUID,p_session TEXT,p_turn TEXT)
 RETURNS TABLE(id TEXT,kind TEXT,header JSONB,hash TEXT,at TIMESTAMPTZ,proof JSONB)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE ctx JSONB;owner_id INT;sid TEXT;BEGIN
  ctx=shared.memory_dialogue_context(p_install,p_session);
  IF ctx IS NULL THEN RETURN;END IF;
  owner_id=(ctx#>>'{scope,principalUserId}')::int;
  sid=public.native_session_authority(p_session,owner_id,NULL)->>'sessionId';
  IF NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=sid AND NOT COALESCE(s.is_subagent,FALSE))
   OR EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts r WHERE r.installation_id=p_install AND r.session_id=p_session AND r.turn_id=p_turn)
   THEN RETURN;END IF;
  RETURN QUERY WITH anchors AS MATERIALIZED(
   SELECT e.id,e.body_header h FROM public.events e WHERE e.session_id=sid AND e.body_header->>'turn_id'=p_turn
    AND (e.event_type IN('user_text','turn_status') OR e.event_type='agent_text' AND e.body_header->>'message_phase'='final_answer')
    AND e.body_header->>'actor_scope'='root' AND e.effect_status IN('completed','none')
  ), selected AS (
   SELECT a.id FROM anchors a
   UNION SELECT part.id FROM (SELECT DISTINCT h->>'stream_id' AS stream FROM anchors WHERE h->>'message_phase'='final_answer') streams
    JOIN public.events part ON part.session_id=sid AND part.body_header->>'turn_id'=p_turn AND part.event_type='agent_text'
     AND part.body_header->>'actor_scope'='root' AND part.body_header->>'stream_id'=streams.stream
   UNION SELECT part.id FROM (SELECT DISTINCT h->>'dialogue_message_id' AS message FROM anchors WHERE h->>'message_phase'='final_answer') finals
    JOIN public.events part ON part.session_id=sid AND part.body_header->>'turn_id'=p_turn AND part.event_type='agent_text'
     AND part.body_header->>'actor_scope'='root' AND part.body_header ? 'dialogue_message_id' AND part.body_header->>'dialogue_message_id'=finals.message
  ), chosen AS (
   SELECT e.* FROM selected JOIN public.events e USING(id)
  )
   SELECT e.id::text,e.event_type::text,e.body_header,e.canonical_payload_hash,e.created_at,e.source_classification->'memory_source'
   FROM chosen e WHERE e.user_id=owner_id AND e.logical_source_session_id=p_session AND NOT e.owner_retired
    AND e.effect_status IN('completed','none') AND public.native_event_authority(e.id,owner_id)->>'state'='current'
    AND shared.memory_input_start_admission(p_install,'relay_event',e.id::text,owner_id::text,p_session)='eligible'
   ORDER BY e.id;
  -- Only the presence of an eligible root operation crosses the Relay boundary.
  RETURN QUERY SELECT e.id::text,'operation'::text,'{}'::jsonb,NULL::text,e.created_at,NULL::jsonb
   FROM public.events e WHERE e.session_id=sid AND e.user_id=owner_id AND e.logical_source_session_id=p_session
    AND e.body_header->>'turn_id'=p_turn AND e.body_header->>'actor_scope'='root'
    AND NOT e.owner_retired AND e.effect_status IN('completed','none')
    AND (e.body_header ? 'dialogue_operation' OR e.source_classification ? 'memory_source' AND (
     e.source_classification#>>'{memory_source,skill_state}'='skill' OR e.source_classification#>>'{memory_source,skill_invocation_id}' IS NOT NULL))
    AND public.native_event_authority(e.id,owner_id)->>'state'='current'
    AND shared.memory_input_start_admission(p_install,'relay_event',e.id::text,owner_id::text,p_session)='eligible'
   ORDER BY e.id LIMIT 1;
  -- Control metadata can disqualify an entire invocation. No excluded
  -- message body is loaded. Missing ancestors still fail ordinary admission.
  RETURN QUERY SELECT e.id::text,'control'::text,'{}'::jsonb,NULL::text,e.created_at,jsonb_build_object('invocation_id',e.source_classification#>>'{memory_source,invocation_id}')
   FROM public.events e WHERE e.session_id=sid AND e.user_id=owner_id AND e.logical_source_session_id=p_session
    AND e.body_header->>'turn_id'=p_turn AND e.source_classification ? 'memory_source'
    AND (e.source_classification#>>'{memory_source,skill_state}' IS DISTINCT FROM 'non_skill'
      OR e.source_classification#>>'{memory_source,lineage_complete}' IS DISTINCT FROM 'true'
      OR e.source_classification#>>'{memory_source,skill_invocation_id}' IS NOT NULL)
   ORDER BY e.id;
 END $$`,
  `CREATE OR REPLACE FUNCTION shared.reclaim_turn_dialogues() RETURNS INT LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,memory,shared AS $$ DECLARE row RECORD;reclaimed INT=0;BEGIN
  FOR row IN SELECT b.installation_id,b.session_id,b.bundle_id,b.revision,b.source_digest,e.turn_id,e.episode_id
   FROM memory.memory_task_bundles b JOIN memory.work_episodes e ON e.installation_id=b.installation_id
    AND e.session_id=b.session_id AND b.task_key='dialogue:'||e.turn_id
   JOIN public.sessions s ON s.session_id=b.session_id AND s.status='exited'
   JOIN shared.memory_dialogue_installations enrollment ON enrollment.installation_id=b.installation_id
   WHERE b.dialogue_members IS NOT NULL AND b.bundle_kind='intake' AND b.state IN('completed','skipped_unresolved')
    AND e.dialogue_completion->>'digest'=encode(b.source_digest,'hex')
    AND NOT EXISTS(SELECT 1 FROM shared.memory_dialogue_pending p WHERE p.installation_id=b.installation_id AND p.session_id=b.session_id)
    AND NOT EXISTS(SELECT 1 FROM memory.memory_jobs j WHERE j.installation_id=b.installation_id AND j.state IN('pending','running')
     AND (j.payload->>'dialogue_session'=b.session_id OR j.payload->>'bundle_id' IN(
      SELECT bundle_id::text FROM memory.memory_task_bundles t WHERE t.installation_id=b.installation_id AND t.session_id=b.session_id)))
   ORDER BY b.updated_at,b.bundle_id LIMIT 16 FOR UPDATE OF b,e SKIP LOCKED LOOP
   IF NOT pg_try_advisory_xact_lock(hashtextextended('purge:session:'||row.installation_id::text||':'||row.session_id,0)) THEN CONTINUE;END IF;
   DELETE FROM memory.memory_task_bundles WHERE installation_id=row.installation_id AND bundle_id=row.bundle_id AND revision=row.revision;
   DELETE FROM memory.memory_source_processing_receipts WHERE installation_id=row.installation_id AND session_id=row.session_id
    AND turn_id=row.turn_id AND source_digest=row.source_digest AND complete;
   reclaimed=reclaimed+1;
  END LOOP; RETURN reclaimed;
 END $$`,
  `CREATE OR REPLACE FUNCTION shared.clear_deleted_dialogue_work() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$ BEGIN
  DELETE FROM shared.memory_dialogue_pending WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id;
  DELETE FROM memory.memory_dialogue_gaps WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id;
  RETURN NULL;
 END $$`,
  `DROP TRIGGER IF EXISTS clear_deleted_dialogue_work ON memory.memory_session_tombstones;
 CREATE TRIGGER clear_deleted_dialogue_work AFTER INSERT ON memory.memory_session_tombstones FOR EACH ROW EXECUTE FUNCTION shared.clear_deleted_dialogue_work()`,
  `REVOKE ALL ON FUNCTION shared.clear_deleted_dialogue_work(),shared.reclaim_turn_dialogues(),shared.uses_turn_dialogue(UUID),shared.dispatch_turn_dialogues(),shared.memory_dialogue_context(UUID,TEXT),shared.memory_dialogue_members(UUID,TEXT,TEXT) FROM PUBLIC`,
] as const
