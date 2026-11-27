/** Aggregate metadata only: no root/installation identity, body or SQL text. */
export const SHARED_SOURCE_HEALTH_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_missing_transport_relation(p_relation TEXT) RETURNS TEXT
  LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'source_health_relation_missing';END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_missing_transport_relation(TEXT) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.memory_source_health() RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   RETURN (SELECT jsonb_build_object('ready',COALESCE((SELECT activation_ready FROM shared.memory_source_contract WHERE singleton),FALSE),
    'roots',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT source_kind AS kind,
      CASE WHEN dead_at IS NOT NULL THEN 'dead' WHEN lease_token IS NOT NULL AND lease_until>clock_timestamp() THEN 'leased' ELSE 'pending' END AS state,
      count(*)::text AS count,greatest(0,extract(epoch FROM clock_timestamp()-min(COALESCE(dirty_since,updated_at))))::text AS oldest_seconds
      FROM shared.memory_source_work WHERE processed_revision<revision GROUP BY source_kind,state)r),'[]'::jsonb),
    'modes',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM(SELECT COALESCE(m.mode,'unconfigured') AS mode,count(*)::text AS count FROM memory.memory_installations i LEFT JOIN shared.memory_source_modes m USING(installation_id) GROUP BY COALESCE(m.mode,'unconfigured'))m),'[]'::jsonb),
    'copies',(SELECT jsonb_agg(jsonb_build_object('table',relation,'bytes',CASE WHEN to_regclass(schema_name||'.'||relation) IS NOT NULL THEN pg_total_relation_size(to_regclass(schema_name||'.'||relation))::text
       WHEN relation IN('memory_feed_inbox','memory_snapshot_events') AND (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton) THEN '0'
       ELSE shared.memory_missing_transport_relation(relation) END))
      FROM (VALUES ('shared','memory_archive_records'),('shared','memory_retained_artifact_refs'),
        ('memory','memory_feed_inbox'),('memory','memory_snapshot_events')) storage(schema_name,relation))));
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_health() FROM PUBLIC`,
 // Current scheduled targets only. This is operational metadata, never a
 // substitute for a fresh source authority check or permission to replay.
 `CREATE OR REPLACE FUNCTION shared.memory_source_pipeline_health(p_installation UUID)
  RETURNS TABLE(failed_jobs TEXT,stalled_roots TEXT) LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,shared AS $$ DECLARE dialogue BOOLEAN; turn_failures INT:=0;turn_stalls INT:=0; BEGIN
   dialogue=shared.uses_turn_dialogue(p_installation);
   IF dialogue THEN
    SELECT count(*) INTO turn_failures FROM (SELECT 1 FROM memory.memory_jobs j
     WHERE j.installation_id=p_installation AND j.job_type='compile_episode' AND j.state='dead'
      AND j.payload ?& ARRAY['dialogue_session','turn']
      AND NOT EXISTS (SELECT 1 FROM memory.memory_dialogue_compile_receipts r WHERE r.installation_id=j.installation_id
        AND r.session_id=j.payload->>'dialogue_session' AND r.turn_id=j.payload->>'turn' AND r.job_id=j.job_id
        AND r.claim_epoch=j.claim_epoch AND r.status IN ('published','not_admitted','failed','input_gap')) LIMIT 1001) f;
    SELECT count(*) INTO turn_stalls FROM (SELECT p.session_id FROM shared.memory_dialogue_pending p
      WHERE p.installation_id=p_installation AND p.enqueued_at<clock_timestamp()-interval '5 minutes'
       AND NOT EXISTS(SELECT 1 FROM memory.memory_dialogue_turns t WHERE t.installation_id=p.installation_id
         AND t.session_id=p.session_id AND t.turn_id=p.turn_id)
     UNION SELECT j.payload->>'dialogue_session' FROM memory.memory_jobs j
      WHERE j.installation_id=p_installation AND j.job_type='compile_episode' AND j.payload ?& ARRAY['dialogue_session','turn']
       AND j.state='pending' AND j.available_at<clock_timestamp()-interval '5 minutes'
       AND NOT EXISTS(SELECT 1 FROM memory.memory_dialogue_turns t WHERE t.installation_id=j.installation_id
        AND t.session_id=j.payload->>'dialogue_session' AND t.turn_id=j.payload->>'turn') LIMIT 1001) s;
    -- One coalesced turn cannot degrade an installation. A stuck dispatcher
    -- still surfaces even before it creates any memory_jobs row.
    SELECT turn_stalls+CASE WHEN count(*)>=3 THEN count(*) ELSE 0 END INTO turn_stalls FROM (
      SELECT 1 FROM shared.memory_dialogue_pending p JOIN memory.memory_dialogue_turns t
       USING(installation_id,session_id,turn_id) WHERE p.installation_id=p_installation
       AND p.enqueued_at<clock_timestamp()-interval '10 minutes' LIMIT 1001) overdue;
   END IF;
    RETURN QUERY WITH outstanding AS (
     SELECT d.source_kind,d.root_key,j.job_id,j.state,GREATEST(j.created_at,p.updated_at) AS changed_at
      FROM shared.memory_source_modes m JOIN public.extension_installations i USING(installation_id)
      JOIN shared.memory_source_distribution_targets t ON t.installation_id=m.installation_id AND t.target_mode=m.mode
      JOIN shared.memory_source_distributions d ON d.scan_id=t.scan_id AND d.state='sealed'
       AND d.control_revision=shared.memory_source_control_snapshot()::bigint
      JOIN shared.memory_source_progress p ON p.installation_id=m.installation_id AND p.source_kind=d.source_kind
       AND p.root_key=d.root_key AND p.mode_generation=m.generation AND p.processed_revision<p.dispatched_revision
      LEFT JOIN memory.memory_jobs j ON j.installation_id=m.installation_id AND j.job_type='project_shared_source'
       AND j.idempotency_key='shared-source:'||t.scan_id::text||':'||encode(sha256(convert_to(t.cursor_key,'UTF8')),'hex')
      WHERE m.installation_id=p_installation AND m.mode='shared-active' AND i.status='active' AND i.provider_id='pocketctl-memory'
       AND d.source_kind IN('team_collaboration','team_delivery') AND t.state='current'
       AND t.source_scope->>'modeGeneration'=m.generation::text AND t.source_scope->>'configVersion'=i.config_version::text
       AND t.source_scope->>'authorizationRevision'=i.authorization_epoch::text
    ) SELECT least(1001,turn_failures+(SELECT count(*) FROM (SELECT DISTINCT job_id FROM outstanding WHERE state='dead' LIMIT 1001) f))::text,
     least(1001,turn_stalls+(SELECT count(*) FROM (SELECT DISTINCT source_kind,root_key FROM outstanding
      WHERE changed_at<clock_timestamp()-interval '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM memory.memory_stage_dispositions d WHERE d.job_id=outstanding.job_id AND d.status<>'resolved') LIMIT 1001) s))::text;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_pipeline_health(UUID) FROM PUBLIC`,
] as const
