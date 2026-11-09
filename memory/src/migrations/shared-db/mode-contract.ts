export const SHARED_SOURCE_MODE_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS mode_version INT NOT NULL DEFAULT 0`,
 `CREATE INDEX IF NOT EXISTS memory_source_canonical_committed ON shared.memory_source_executions(installation_id) WHERE branch='canonical-active' AND last_guarded_at IS NOT NULL`,
 `CREATE OR REPLACE FUNCTION shared.fence_memory_source_mode_input() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE installation UUID;BEGIN
   -- This is durable input history, including after an installation purge.
   -- Deleting/re-keying it would restore the implicit generation 1 and could
   -- re-admit an original network response or cursor after a mode cycle.
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source_mode_record_is_durable';END IF;
   IF TG_OP='UPDATE' AND OLD.installation_id IS DISTINCT FROM NEW.installation_id THEN RAISE EXCEPTION 'source_mode_identity_is_immutable';END IF;
   IF TG_OP='UPDATE' AND(OLD.installation_id,OLD.mode,OLD.generation) IS NOT DISTINCT FROM(NEW.installation_id,NEW.mode,NEW.generation) THEN RETURN NEW;END IF;
   FOR installation IN SELECT DISTINCT id FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.installation_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.installation_id END]) ids(id)
    WHERE id IS NOT NULL ORDER BY id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('memory-source-mode:'||installation::text,0)) THEN RAISE EXCEPTION 'source_mode_input_busy' USING ERRCODE='55P03';END IF;
   END LOOP;
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END $$`,
 `DROP TRIGGER IF EXISTS memory_source_mode_input_fence ON shared.memory_source_modes;
  CREATE TRIGGER memory_source_mode_input_fence BEFORE INSERT OR UPDATE OR DELETE ON shared.memory_source_modes FOR EACH ROW EXECUTE FUNCTION shared.fence_memory_source_mode_input()`,
 `CREATE OR REPLACE FUNCTION shared.lock_memory_feed_source_mode(p_installation UUID) RETURNS JSONB
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE mode_value TEXT;generation_value BIGINT;provider_enabled BOOLEAN;BEGIN
   IF p_installation IS NULL THEN RETURN NULL;END IF;
   PERFORM 1 FROM public.extension_installations WHERE installation_id=p_installation AND provider_id='pocketctl-memory' FOR SHARE NOWAIT;
   IF NOT FOUND THEN RETURN NULL;END IF;
   PERFORM 1 FROM public.extension_providers WHERE provider_id='pocketctl-memory' AND status='enabled' FOR SHARE NOWAIT;
   provider_enabled=FOUND;
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('memory-source-mode:'||p_installation::text,0)) THEN RAISE EXCEPTION 'source_mode_input_busy' USING ERRCODE='55P03';END IF;
   SELECT mode,generation INTO mode_value,generation_value FROM shared.memory_source_modes WHERE installation_id=p_installation FOR SHARE NOWAIT;
   mode_value=COALESCE(mode_value,'legacy-feed');generation_value=COALESCE(generation_value,1);
   RETURN jsonb_build_object('mode',mode_value,'generation',generation_value::text,'allowed',provider_enabled AND mode_value IN('legacy-feed','shared-shadow') AND NOT (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton));
  END $$`,
 `REVOKE ALL ON FUNCTION shared.fence_memory_source_mode_input(),shared.lock_memory_feed_source_mode(UUID) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.lock_memory_legacy_input(p_installation UUID,p_expected BIGINT)
  RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE m RECORD;BEGIN
   IF (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton) THEN RAISE EXCEPTION 'legacy_transport_retired';END IF;
   IF p_installation IS NULL THEN RAISE EXCEPTION 'source_mode_generation_changed';END IF;
   INSERT INTO shared.memory_source_modes(installation_id) SELECT p_installation WHERE NOT EXISTS(SELECT 1 FROM shared.memory_source_modes WHERE installation_id=p_installation) ON CONFLICT DO NOTHING;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=p_installation FOR SHARE;
   IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM m.generation THEN RAISE EXCEPTION 'source_mode_generation_changed';END IF;
   IF m.mode NOT IN('legacy-feed','shared-shadow') THEN RAISE EXCEPTION 'legacy_source_input_disabled';END IF;
   RETURN m.generation;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.lock_memory_legacy_input(UUID,BIGINT) FROM PUBLIC`,
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS activation_ready BOOLEAN NOT NULL DEFAULT FALSE`,
 `CREATE OR REPLACE FUNCTION shared.transition_memory_source_mode(p_installation UUID,p_generation BIGINT,p_mode TEXT)
  RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE g BIGINT;i RECORD;BEGIN
   IF p_mode IN('legacy-feed','shared-shadow') AND (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton) THEN RAISE EXCEPTION 'legacy_transport_retired';END IF;
   IF p_mode NOT IN ('legacy-feed','shared-shadow','shared-active','paused') THEN RAISE EXCEPTION 'invalid_source_mode'; END IF;
   IF p_mode<>'paused' AND current_setting('transaction_isolation')<>'read committed'
    THEN RAISE EXCEPTION 'source_execution_requires_read_committed';END IF;
   IF p_mode IN ('shared-shadow','shared-active') AND NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE singleton AND version=1 AND activation_ready)
     THEN RAISE EXCEPTION 'source_activation_not_ready'; END IF;
   IF p_mode IN('shared-shadow','shared-active') THEN
    IF shared.memory_input_start_ready() IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
    -- This admission is per installation, separate from structural schema
    -- readiness. Lock current installation/provider through physical COMMIT.
    IF to_regclass('public.extension_installations') IS NULL OR to_regclass('public.extension_providers') IS NULL THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
    SELECT owner_scope_kind,owner_scope_id,owner_user_id INTO i FROM public.extension_installations WHERE installation_id=p_installation FOR SHARE NOWAIT;
    PERFORM provider_id FROM public.extension_providers WHERE provider_id='pocketctl-memory' FOR SHARE NOWAIT;
    IF i.owner_scope_kind='personal' THEN PERFORM id FROM public.users WHERE id=i.owner_user_id FOR SHARE NOWAIT;
    ELSIF i.owner_scope_kind='team' THEN
     PERFORM team_id FROM public.extension_teams WHERE team_id=i.owner_scope_id FOR SHARE NOWAIT;
     PERFORM o.organization_id FROM public.extension_organizations o JOIN public.extension_teams t USING(organization_id) WHERE t.team_id=i.owner_scope_id FOR SHARE OF o NOWAIT;
    ELSIF i.owner_scope_kind='organization' THEN PERFORM organization_id FROM public.extension_organizations WHERE organization_id=i.owner_scope_id FOR SHARE NOWAIT;
    END IF;

    IF shared.memory_installation_input_ready(p_installation) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
   END IF;
   INSERT INTO shared.memory_source_modes(installation_id) SELECT p_installation WHERE NOT EXISTS(SELECT 1 FROM shared.memory_source_modes WHERE installation_id=p_installation) ON CONFLICT DO NOTHING;
   -- Holding the mode row closes admission before inspecting the durable
   -- in-flight set. No row/advisory lock is held across external model IO.
   PERFORM 1 FROM shared.memory_source_modes WHERE installation_id=p_installation FOR UPDATE NOWAIT;
   -- Once canonical output has physically committed, pause/forward repair
   -- may resume that authority but must not reopen the legacy active branch.
   -- Original execution receipts remain durable audit/fee history.
   IF p_mode IN('legacy-feed','shared-shadow') AND EXISTS(SELECT 1 FROM shared.memory_source_executions e
     WHERE e.installation_id=p_installation AND e.branch='canonical-active' AND e.last_guarded_at IS NOT NULL)
    THEN RAISE EXCEPTION 'source_mode_forward_only';END IF;
   IF p_mode<>'paused' AND EXISTS(SELECT 1 FROM shared.memory_source_provider_attempts a
     JOIN shared.memory_source_executions e USING(execution_id) WHERE e.installation_id=p_installation AND a.state='inflight')
    THEN RAISE EXCEPTION 'source_executions_not_drained';END IF;
   UPDATE shared.memory_source_modes SET mode=p_mode,generation=generation+1,updated_at=clock_timestamp()
    WHERE installation_id=p_installation AND generation=p_generation RETURNING generation INTO g;
   IF g IS NULL THEN RAISE EXCEPTION 'source_mode_generation_changed'; END IF;RETURN g;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.record_memory_source_dispatch(p_installation UUID,p_generation BIGINT,p_kind TEXT,p_root TEXT,p_revision BIGINT,p_binding BIGINT,p_authorization BIGINT)
  RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE active_mode TEXT;BEGIN
   SELECT mode INTO active_mode FROM shared.memory_source_modes WHERE installation_id=p_installation AND generation=p_generation FOR SHARE;
   IF active_mode IS DISTINCT FROM 'shared-active' THEN RAISE EXCEPTION 'source_mode_generation_changed'; END IF;
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key=p_root AND revision>=p_revision) OR p_revision<=0
    THEN RAISE EXCEPTION 'source_revision_invalid'; END IF;
   INSERT INTO shared.memory_source_progress(installation_id,source_kind,root_key,mode_generation,binding_revision,authorization_revision,dispatched_revision,bootstrap_state)
    VALUES(p_installation,p_kind,p_root,p_generation,p_binding,p_authorization,p_revision,'ready')
    ON CONFLICT(installation_id,source_kind,root_key) DO UPDATE SET mode_generation=p_generation,binding_revision=p_binding,authorization_revision=p_authorization,
     dispatched_revision=CASE WHEN (memory_source_progress.mode_generation,memory_source_progress.binding_revision,memory_source_progress.authorization_revision) IS DISTINCT FROM (p_generation,p_binding,p_authorization) THEN p_revision ELSE GREATEST(memory_source_progress.dispatched_revision,p_revision) END,
     processed_revision=CASE WHEN (memory_source_progress.mode_generation,memory_source_progress.binding_revision,memory_source_progress.authorization_revision) IS DISTINCT FROM (p_generation,p_binding,p_authorization) THEN 0 ELSE memory_source_progress.processed_revision END,bootstrap_state='ready',updated_at=clock_timestamp();
  END $$`,
 `UPDATE shared.memory_source_contract SET mode_version=1 WHERE singleton`,
 `REVOKE ALL ON FUNCTION shared.transition_memory_source_mode(UUID,BIGINT,TEXT),shared.record_memory_source_dispatch(UUID,BIGINT,TEXT,TEXT,BIGINT,BIGINT,BIGINT) FROM PUBLIC`,
] as const
