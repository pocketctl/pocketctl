/** Operator-only retirement of the original personal Session transport.
 * The durable receipt contains no user/body data and cannot restore input.
 * Current authority, model consent, external Providers and Team remain separate. */
const sessionTopics="ARRAY['session.event.v1','session.lifecycle.v1','turn.lifecycle.v1','session.deleted.v1','session.access.revoked.v1']::text[]"
export const SHARED_SESSION_TRANSPORT_RETIREMENT_FUNCTIONS=[
 `CREATE TABLE IF NOT EXISTS shared.memory_session_transport_retirements(
  installation_id UUID PRIMARY KEY,mode_generation BIGINT NOT NULL CHECK(mode_generation>0),
  retired_config_version BIGINT NOT NULL CHECK(retired_config_version>1),
  removed_topics TEXT[] NOT NULL CHECK(removed_topics<@${sessionTopics}),
  retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
 `CREATE OR REPLACE FUNCTION shared.guard_memory_session_transport_retirement() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   RAISE EXCEPTION 'session_transport_retirement_is_durable';
  END $$`,
 `DROP TRIGGER IF EXISTS memory_session_transport_retirement_immutable ON shared.memory_session_transport_retirements;
  CREATE TRIGGER memory_session_transport_retirement_immutable BEFORE UPDATE OR DELETE ON shared.memory_session_transport_retirements
   FOR EACH ROW EXECUTE FUNCTION shared.guard_memory_session_transport_retirement()`,
 `CREATE OR REPLACE FUNCTION shared.enforce_memory_session_transport_retirement() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE epoch BIGINT;BEGIN
   SELECT retired_config_version INTO epoch FROM shared.memory_session_transport_retirements WHERE installation_id=NEW.installation_id;
   IF NOT FOUND THEN RETURN NEW;END IF;
   IF NEW.provider_id<>'pocketctl-memory' OR NEW.owner_scope_kind<>'personal' OR NEW.owner_user_id IS NULL
    OR TG_OP='UPDATE' AND(NEW.provider_id,NEW.owner_scope_kind,NEW.owner_scope_id,NEW.owner_user_id)
      IS DISTINCT FROM(OLD.provider_id,OLD.owner_scope_kind,OLD.owner_scope_id,OLD.owner_user_id)
    THEN RAISE EXCEPTION 'session_transport_retirement_scope_mismatch';END IF;
   IF NEW.config_version<epoch THEN RAISE EXCEPTION 'session_transport_retirement_epoch_mismatch';END IF;
   -- Preserve every unrelated subscription and its order. Ordinary API
   -- configuration writes cannot resurrect a retired first-party body feed.
   NEW.subscriptions=ARRAY(SELECT topic FROM unnest(NEW.subscriptions) WITH ORDINALITY input(topic,position)
    WHERE NOT(topic=ANY(${sessionTopics})) ORDER BY position);
   RETURN NEW;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_session_transport_retired ON public.extension_installations;
  CREATE TRIGGER memory_session_transport_retired BEFORE INSERT OR UPDATE OF provider_id,owner_scope_kind,owner_scope_id,owner_user_id,subscriptions,config_version
   ON public.extension_installations FOR EACH ROW EXECUTE FUNCTION shared.enforce_memory_session_transport_retirement()`,
 `CREATE OR REPLACE FUNCTION shared.retire_memory_session_transport(p_installation UUID,p_owner BIGINT,p_config BIGINT,p_generation BIGINT)
  RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,shared AS $$
  DECLARE i RECORD;m RECORD;previous shared.memory_session_transport_retirements;removed TEXT[];new_config BIGINT;BEGIN
   IF p_installation IS NULL OR p_owner IS NULL OR p_owner<1 OR p_config IS NULL OR p_config<1 OR p_generation IS NULL OR p_generation<1
    OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'invalid_session_transport_retirement';END IF;
   PERFORM shared.assert_memory_control_capture();
   SELECT * INTO i FROM public.extension_installations WHERE installation_id=p_installation FOR UPDATE NOWAIT;
   IF NOT FOUND OR i.provider_id<>'pocketctl-memory' OR i.owner_scope_kind<>'personal' OR i.owner_user_id IS DISTINCT FROM p_owner
    OR i.status<>'active' THEN RAISE EXCEPTION 'session_transport_retirement_scope_mismatch';END IF;
   PERFORM 1 FROM public.extension_providers WHERE provider_id='pocketctl-memory' AND status='enabled' FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'session_transport_retirement_scope_mismatch';END IF;
   PERFORM 1 FROM public.users WHERE id=p_owner FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'session_transport_retirement_scope_mismatch';END IF;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=p_installation FOR SHARE NOWAIT;
   IF NOT FOUND OR m.mode<>'shared-active' OR m.generation<>p_generation THEN RAISE EXCEPTION 'session_transport_retirement_epoch_mismatch';END IF;
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract c WHERE c.singleton AND c.activation_ready
    AND(c.target_profile='full' OR p_installation=ANY(c.target_installations))) THEN RAISE EXCEPTION 'session_transport_retirement_scope_mismatch';END IF;
   SELECT * INTO previous FROM shared.memory_session_transport_retirements WHERE installation_id=p_installation;
   IF FOUND THEN
    IF previous.mode_generation<>p_generation OR previous.retired_config_version<>p_config+1 OR i.config_version<previous.retired_config_version
     OR i.subscriptions&&${sessionTopics} THEN RAISE EXCEPTION 'session_transport_retirement_epoch_mismatch';END IF;
    RETURN jsonb_build_object('alreadyRetired',TRUE,'retiredConfigVersion',previous.retired_config_version::text,
     'currentConfigVersion',i.config_version::text,'modeGeneration',m.generation::text,'removedTopics',previous.removed_topics);
   END IF;
   IF i.config_version<>p_config THEN RAISE EXCEPTION 'session_transport_retirement_epoch_mismatch';END IF;
   IF NOT EXISTS(SELECT 1 FROM memory.memory_installations local JOIN memory.memory_native_control_observations observed USING(installation_id)
     WHERE local.installation_id=p_installation AND local.local_status='ready' AND NOT local.snapshot_required
      AND local.config_version=p_config AND observed.control_revision=shared.memory_source_control_snapshot()::bigint)
    OR NOT EXISTS(SELECT 1 FROM memory.source_events s WHERE s.installation_id=p_installation AND s.origin='canonical'
      AND s.adapter_version='canonical-ref-v1' AND s.mapping_state='verified' AND s.payload IS NULL)
    OR NOT EXISTS(SELECT 1 FROM shared.memory_source_executions e WHERE e.installation_id=p_installation AND e.branch='canonical-active' AND e.last_guarded_at IS NOT NULL)
    THEN RAISE EXCEPTION 'session_transport_retirement_not_ready';END IF;
   removed=ARRAY(SELECT topic FROM unnest(i.subscriptions) WITH ORDINALITY input(topic,position) WHERE topic=ANY(${sessionTopics}) ORDER BY position);
   INSERT INTO shared.memory_session_transport_retirements(installation_id,mode_generation,retired_config_version,removed_topics)
    VALUES(p_installation,p_generation,p_config+1,removed);
   UPDATE public.extension_installations SET subscriptions=ARRAY(SELECT topic FROM unnest(i.subscriptions) WITH ORDINALITY input(topic,position)
     WHERE NOT(topic=ANY(${sessionTopics})) ORDER BY position),config_version=config_version+1,updated_at=clock_timestamp()
    WHERE installation_id=p_installation AND config_version=p_config RETURNING config_version INTO new_config;
   IF new_config IS DISTINCT FROM p_config+1 THEN RAISE EXCEPTION 'session_transport_retirement_epoch_mismatch';END IF;
   RETURN jsonb_build_object('alreadyRetired',FALSE,'retiredConfigVersion',new_config::text,'currentConfigVersion',new_config::text,
    'modeGeneration',p_generation::text,'removedTopics',removed);
  END $$`,
 `REVOKE ALL ON shared.memory_session_transport_retirements FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.guard_memory_session_transport_retirement(),shared.enforce_memory_session_transport_retirement(),
  shared.retire_memory_session_transport(UUID,BIGINT,BIGINT,BIGINT) FROM PUBLIC`,
] as const
