/** Per-context checkpoints and complete per-installation progress have
 * different meanings. Only a sealed, wholly ready set may advance the latter. */
export const SHARED_SOURCE_PROJECTION_COMPLETION_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_source_scope_key(p_scope JSONB) RETURNS TEXT
  LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$ BEGIN
   IF jsonb_typeof(p_scope)<>'object' OR octet_length(p_scope::text)>32768 THEN RAISE EXCEPTION 'invalid_source_scope';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_each(p_scope) WHERE jsonb_typeof(value)<>'string') THEN RAISE EXCEPTION 'invalid_source_scope';END IF;
   -- SourceScope is a flat string record. Match canonicalJsonString exactly;
   -- jsonb::text itself has whitespace and a different key order.
   RETURN encode(sha256(convert_to('{'||(SELECT COALESCE(string_agg(to_jsonb(key)::text||':'||value::text,',' ORDER BY key COLLATE "C"),'') FROM jsonb_each(p_scope))||'}','UTF8')),'hex');
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.complete_memory_source_projection(p_execution UUID,p_scope JSONB,p_kind TEXT,p_root TEXT,p_expected JSONB)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE e shared.memory_source_executions;d shared.memory_source_distributions;item RECORD;ready BOOLEAN;BEGIN
   IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'source_completion_requires_read_committed';END IF;
   SELECT * INTO e FROM shared.memory_source_executions WHERE execution_id=p_execution;
   IF NOT FOUND OR e.branch<>'canonical-active' OR p_scope->>'installationId' IS DISTINCT FROM e.installation_id::text
    OR p_scope->>'modeGeneration' IS DISTINCT FROM e.generation::text OR NOT shared.assert_memory_job_source(p_execution,'publish') THEN RAISE EXCEPTION 'source_execution_generation_changed';END IF;
   IF shared.guard_memory_job_source_commit(p_execution) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'source_execution_generation_changed';END IF;
   IF p_kind='relay_event' THEN ready=shared.lock_memory_personal_source_commit(p_scope,p_kind,p_root,p_expected,FALSE);
   ELSIF p_kind IN('team_collaboration','team_delivery') THEN ready=shared.lock_memory_team_source_commit(p_scope,p_kind,p_root,p_expected,FALSE);
   ELSE RAISE EXCEPTION 'invalid_source_completion';END IF;
   IF ready IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'source_reference_changed';END IF;
   SELECT scan.* INTO d FROM shared.memory_source_distributions scan JOIN shared.memory_source_work w USING(source_kind,root_key)
    WHERE scan.source_kind=p_kind AND scan.root_key=p_root AND scan.state='sealed' AND scan.work_revision=w.revision
     AND scan.control_revision=shared.memory_source_control_snapshot()::bigint FOR SHARE OF scan NOWAIT;
   IF NOT FOUND THEN RETURN FALSE;END IF;
   IF (SELECT count(*) FROM shared.memory_source_distribution_targets t WHERE t.scan_id=d.scan_id AND t.installation_id=e.installation_id) NOT BETWEEN 1 AND 512 THEN RETURN FALSE;END IF;
   IF NOT EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t WHERE t.scan_id=d.scan_id AND t.installation_id=e.installation_id
     AND t.state='current' AND t.target_mode='shared-active' AND t.source_scope=p_scope
     AND t.source_version->>'content'=p_expected->>'content' AND t.source_version->>'authorization'=p_expected->>'authorization') THEN RETURN FALSE;END IF;
   IF EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t WHERE t.scan_id=d.scan_id AND t.installation_id=e.installation_id
     AND(t.state NOT IN('current','revoked','deleted') OR t.target_mode<>'shared-active')) THEN RETURN FALSE;END IF;
   -- Writers already own the installation projection mutex. Lock existing
   -- checkpoints in key order as well; absent checkpoints are never ready.
   FOR item IN SELECT p.context_key FROM memory.memory_canonical_projection_progress p
    JOIN shared.memory_source_distribution_targets t ON t.scan_id=d.scan_id AND t.installation_id=e.installation_id AND t.state='current'
     AND p.context_key=shared.memory_source_scope_key(t.source_scope)
    WHERE p.installation_id=e.installation_id AND p.source_kind=p_kind AND p.root_key=p_root
    ORDER BY p.context_key FOR SHARE OF p NOWAIT LOOP END LOOP;
   IF EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t
    LEFT JOIN memory.memory_canonical_projection_progress p ON p.installation_id=t.installation_id AND p.source_kind=p_kind AND p.root_key=p_root
     AND p.context_key=shared.memory_source_scope_key(t.source_scope)
    WHERE t.scan_id=d.scan_id AND t.installation_id=e.installation_id AND t.state='current'
     AND(p.state IS DISTINCT FROM 'ready' OR p.source_version->>'content' IS DISTINCT FROM t.source_version->>'content'
      OR p.source_version->>'authorization' IS DISTINCT FROM t.source_version->>'authorization')) THEN RETURN FALSE;END IF;
   UPDATE shared.memory_source_progress SET processed_revision=GREATEST(processed_revision,d.work_revision),updated_at=clock_timestamp()
    WHERE installation_id=e.installation_id AND source_kind=p_kind AND root_key=p_root AND mode_generation=e.generation
     AND dispatched_revision>=d.work_revision;
   RETURN FOUND;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_scope_key(JSONB),shared.complete_memory_source_projection(UUID,JSONB,TEXT,TEXT,JSONB) FROM PUBLIC`,
] as const
