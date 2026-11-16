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
    'modes',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM(SELECT COALESCE(m.mode,'legacy-feed') AS mode,count(*)::text AS count FROM memory.memory_installations i LEFT JOIN shared.memory_source_modes m USING(installation_id) GROUP BY COALESCE(m.mode,'legacy-feed'))m),'[]'::jsonb),
    'copies',(SELECT jsonb_agg(jsonb_build_object('table',relation,'bytes',CASE WHEN to_regclass('memory.'||relation) IS NOT NULL THEN pg_total_relation_size(to_regclass('memory.'||relation))::text
       WHEN relation IN('memory_feed_inbox','memory_snapshot_events') AND (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton) THEN '0'
       ELSE shared.memory_missing_transport_relation(relation) END))
      FROM unnest(ARRAY['source_events','source_artifacts','memory_feed_inbox','memory_snapshot_events'])relation)));
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_health() FROM PUBLIC`,
 // Current scheduled targets only. This is operational metadata, never a
 // substitute for a fresh source authority check or permission to replay.
 `CREATE OR REPLACE FUNCTION shared.memory_source_pipeline_health(p_installation UUID)
  RETURNS TABLE(failed_jobs TEXT,stalled_roots TEXT) LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,shared AS $$ BEGIN
   RETURN QUERY WITH targets AS MATERIALIZED (
    SELECT d.source_kind,d.root_key,t.source_scope,p.processed_revision,p.dispatched_revision,
     COALESCE(GREATEST(cp.updated_at,j.created_at),p.updated_at) AS last_progress_at,j.job_id,j.state AS job_state
    FROM shared.memory_source_modes m
    JOIN public.extension_installations i USING(installation_id)
    JOIN shared.memory_source_distribution_targets t ON t.installation_id=m.installation_id AND t.target_mode=m.mode
    JOIN shared.memory_source_distributions d ON d.scan_id=t.scan_id AND d.state='sealed'
     AND d.control_revision=shared.memory_source_control_snapshot()::bigint
    JOIN shared.memory_source_progress p ON p.installation_id=m.installation_id AND p.source_kind=d.source_kind
     AND p.root_key=d.root_key AND p.mode_generation=m.generation
    LEFT JOIN memory.memory_jobs j ON j.installation_id=m.installation_id AND j.job_type='project_shared_source'
     AND j.idempotency_key='shared-source:'||t.scan_id::text||':'||encode(sha256(convert_to(t.cursor_key,'UTF8')),'hex')
    LEFT JOIN memory.memory_canonical_projection_progress cp ON cp.installation_id=m.installation_id
     AND cp.source_kind=d.source_kind AND cp.root_key=d.root_key AND cp.context_key=shared.memory_source_scope_key(t.source_scope)
    WHERE m.installation_id=p_installation AND m.mode='shared-active' AND i.status='active'
     AND i.provider_id='pocketctl-memory' AND t.state='current'
     AND t.source_scope->>'modeGeneration'=m.generation::text
     AND t.source_scope->>'configVersion'=i.config_version::text
     AND t.source_scope->>'authorizationRevision'=i.authorization_epoch::text
   ), failures AS (
    SELECT job_id FROM targets WHERE job_state='dead' AND processed_revision<dispatched_revision
    UNION
    SELECT j.job_id FROM memory.memory_jobs j JOIN memory.source_turns st
     ON st.installation_id=j.installation_id AND j.idempotency_key='compile_episode:'||st.turn_id
    WHERE j.installation_id=p_installation AND j.job_type='compile_episode' AND j.state='dead'
     AND EXISTS(SELECT 1 FROM targets t WHERE t.source_kind='relay_event'
      AND t.root_key=(t.source_scope->>'principalUserId')||':'||st.session_id)
     AND EXISTS(SELECT 1 FROM memory.source_events e WHERE e.installation_id=j.installation_id AND e.turn_id=st.turn_id AND e.body_reclaimed_at IS NULL)
     AND NOT EXISTS(SELECT 1 FROM memory.memory_source_processing_receipts r WHERE r.installation_id=j.installation_id
      AND r.turn_id=st.turn_id AND r.created_at>=j.completed_at)
     AND NOT EXISTS(SELECT 1 FROM memory.work_episodes e WHERE e.installation_id=j.installation_id AND e.turn_id=st.turn_id AND e.compiled_at>=j.completed_at)
    LIMIT 1001
   ), stalled AS (
    SELECT DISTINCT source_kind,root_key FROM targets WHERE processed_revision<dispatched_revision
     AND last_progress_at<clock_timestamp()-interval '5 minutes' LIMIT 1001
   ) SELECT (SELECT count(*)::text FROM failures),(SELECT count(*)::text FROM stalled);
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_pipeline_health(UUID) FROM PUBLIC`,
] as const
