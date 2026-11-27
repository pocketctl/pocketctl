-- Run on the shared Relay database after upgrading Relay and Memory.
-- Supply expected_database via psql -v. Default rolls back the rehearsal.
-- apply=true commits the same checks and DDL. All locks end with this transaction.
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
BEGIN;
SET LOCAL search_path=pg_catalog,memory,shared;
SET LOCAL lock_timeout='2s';
SELECT set_config('pocketctl.expected_database', :'expected_database', true);
DO $check$
BEGIN
 IF current_database() IS DISTINCT FROM current_setting('pocketctl.expected_database')
 OR NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE singleton AND archive_custody_version=1
  AND artifact_custody_version=1 AND team_history_version=1 AND offline_projection_version=0 AND shadow_version=0)
 THEN RAISE EXCEPTION 'native_retirement_database_or_contract_mismatch'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('memory:retention:migrations',0)) THEN RAISE EXCEPTION 'retention_busy'; END IF;
END $check$;

DO $transport$
DECLARE owner_name name; rel text;col text;
BEGIN
 IF (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton) THEN RETURN; END IF;
 LOCK TABLE memory.memory_feed_inbox,memory.memory_inbox_checkpoints,memory.memory_snapshot_events,memory.memory_snapshot_runs
  IN ACCESS EXCLUSIVE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM memory.memory_feed_inbox WHERE body_reclaimed_at IS NULL OR projection_state='pending')
 OR EXISTS(SELECT 1 FROM memory.memory_snapshot_events WHERE body_reclaimed_at IS NULL)
 OR EXISTS(SELECT 1 FROM memory.memory_snapshot_runs WHERE state='running' OR (state='completed' AND relay_acked_at IS NULL))
 THEN RAISE EXCEPTION 'unsettled_or_unreclaimed_transport_rows'; END IF;
 -- Preserve the complete unfiltered facts, including quarantined gaps and
 -- withdrawal metadata. The existing views retain their OIDs, ACLs and callers.
 CREATE TABLE memory.memory_source_delivery_receipts AS TABLE memory.memory_source_delivery_facts;
 CREATE TABLE memory.memory_source_snapshot_receipts AS TABLE memory.memory_source_snapshot_facts;
 FOREACH col IN ARRAY ARRAY['installation_id','feed_id','envelope_version','topic','source_kind','source_id','event_type','recorded_at','payload_hash','projection_state','received_at'] LOOP
  EXECUTE format('ALTER TABLE memory.memory_source_delivery_receipts ALTER COLUMN %I SET NOT NULL',col);
 END LOOP;
 FOREACH col IN ARRAY ARRAY['run_id','installation_id','generation','state','sessions_seen','events_seen','started_at'] LOOP
  EXECUTE format('ALTER TABLE memory.memory_source_snapshot_receipts ALTER COLUMN %I SET NOT NULL',col);
 END LOOP;
 ALTER TABLE memory.memory_source_delivery_receipts ADD PRIMARY KEY(installation_id,feed_id);
 ALTER TABLE memory.memory_source_snapshot_receipts ADD PRIMARY KEY(run_id);
 -- The replacement table is still private to this transaction. Existing
 -- installations build this index concurrently via the dedicated migrator.
 CREATE INDEX memory_source_delivery_receipts_active_state_installation
  ON memory.memory_source_delivery_receipts(projection_state,installation_id)
  WHERE projection_state IN ('pending','quarantined');
 CREATE INDEX memory_delivery_receipts_session ON memory.memory_source_delivery_receipts(installation_id,session_id,turn_id);
 CREATE INDEX memory_snapshot_receipts_installation ON memory.memory_source_snapshot_receipts(installation_id,state);
 FOREACH rel IN ARRAY ARRAY['delivery','snapshot'] LOOP
  SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class WHERE oid=to_regclass('memory.memory_source_'||rel||'_facts');
  EXECUTE format('ALTER TABLE memory.memory_source_%s_receipts OWNER TO %I',rel,owner_name);
  EXECUTE format('CREATE OR REPLACE VIEW memory.memory_source_%s_facts AS SELECT * FROM memory.memory_source_%s_receipts',rel,rel);
 END LOOP;
 DROP TABLE memory.memory_feed_inbox,memory.memory_inbox_checkpoints,memory.memory_snapshot_events,memory.memory_snapshot_runs RESTRICT;
 UPDATE shared.memory_source_contract SET legacy_transport_retired=TRUE WHERE singleton;
END $transport$;

DO $core$
BEGIN
 IF (SELECT projection_storage_retired FROM shared.memory_source_contract WHERE singleton) THEN RETURN; END IF;
 LOCK TABLE memory.source_events,memory.source_artifacts,memory.source_sessions,memory.source_turns,memory.memory_task_bundle_sources
  IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE memory.memory_jobs,memory.memory_task_bundles,memory.work_episodes,memory.knowledge_evidence,
  memory.memory_skill_archive_sources,memory.memory_source_retention_receipts,shared.memory_source_modes,
  shared.memory_archive_records,shared.memory_retained_artifact_refs,shared.memory_team_history_inputs,
  shared.memory_team_history_bundle_links,memory.memory_team_semantic_groups IN SHARE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM shared.memory_source_provider_attempts WHERE state='inflight')
 OR EXISTS(SELECT 1 FROM memory.memory_governance_migration_runs WHERE sealed_at IS NULL AND abandoned_at IS NULL)
 OR EXISTS(SELECT 1 FROM memory.memory_jobs WHERE state IN('running','pending') AND
   (job_type IN('project_feed','snapshot_reconcile') OR job_type='compile_episode' AND NOT(payload ?& ARRAY['dialogue_session','turn'])
   OR job_type='project_shared_source' AND COALESCE(payload#>>'{root,kind}','') NOT IN('team_delivery','team_collaboration')))
 OR EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts WHERE state='reclaiming' AND compiler_version<>'relay-turn-v1')
 THEN RAISE EXCEPTION 'old_work_requires_resolution'; END IF;
 IF EXISTS(SELECT 1 FROM public.extension_installations i JOIN shared.memory_source_contract c ON c.singleton
   LEFT JOIN shared.memory_source_modes m USING(installation_id)
   WHERE i.provider_id='pocketctl-memory' AND i.status='active' AND (c.target_profile='full' OR i.installation_id=ANY(c.target_installations))
    AND (m.mode IS NULL OR m.mode IN('legacy-feed','shared-shadow') OR
     m.mode='shared-active' AND i.owner_scope_kind='personal' AND NOT shared.uses_turn_dialogue(i.installation_id)))
 THEN RAISE EXCEPTION 'active_installation_requires_native_cutover'; END IF;
 IF EXISTS(SELECT 1 FROM memory.source_events e WHERE NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones t
   WHERE (t.installation_id,t.session_id)=(e.installation_id,e.session_id)) AND NOT (
    (e.source_kind='legacy_archive' AND e.mapping_state='verified' AND EXISTS(SELECT 1 FROM shared.memory_archive_records a
      WHERE (a.installation_id,a.source_event_id,a.owner_user_id,a.session_id,a.manifest_hash,a.content_hash,a.payload_hash)=
       (e.installation_id,e.source_event_id,e.legacy_owner_user_id,e.session_id,e.legacy_manifest_hash,e.content_hash,e.payload_hash)
      AND a.body_reclaimed_at IS NOT DISTINCT FROM e.body_reclaimed_at AND (a.body_reclaimed_at IS NOT NULL OR a.payload=e.payload)))
    OR (e.source_kind IN('team_delivery','team_collaboration') AND EXISTS(SELECT 1 FROM shared.memory_team_history_inputs h
      WHERE h.installation_id=e.installation_id AND h.kind='source' AND h.id=e.source_event_id::text
       AND h.native_ref->>'key'=e.canonical_key AND h.native_ref->'version'=e.source_version
       AND h.metadata->>'contentDigest'=encode(e.content_hash,'hex') AND h.metadata->>'payloadDigest'=encode(e.payload_hash,'hex')))
    OR (e.source_kind='team_semantic' AND EXISTS(SELECT 1 FROM memory.memory_team_semantic_groups g
       WHERE g.installation_id=e.installation_id AND g.semantic_ref_id=e.source_event_id AND g.registration_state='published'
       AND g.semantic_payload_hash=e.payload_hash))
    OR (e.source_kind='relay_event' AND e.mapping_state='verified' AND e.origin<>'team'
       AND e.session_id=e.canonical_session_key AND NOT(e.source_provenance ? 'team')
       AND e.source_provenance->>'source_kind' IS DISTINCT FROM 'team_session'
       AND EXISTS(SELECT 1 FROM public.extension_installations i JOIN public.events r ON r.user_id=i.owner_user_id
        WHERE i.installation_id=e.installation_id AND i.owner_scope_kind='personal' AND i.provider_id='pocketctl-memory'
         AND r.id=CASE WHEN e.canonical_key ~ '^[1-9][0-9]{0,18}$' AND (length(e.canonical_key)<19 OR e.canonical_key COLLATE "C"<='9223372036854775807') THEN e.canonical_key::bigint END
         AND r.logical_source_session_id=e.session_id))) IS TRUE)
 THEN RAISE EXCEPTION 'source_custody_unproved'; END IF;
 IF EXISTS(SELECT 1 FROM memory.source_artifacts a JOIN memory.source_events e USING(installation_id,source_event_id)
  WHERE e.source_kind IS DISTINCT FROM 'relay_event'
   AND NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones t WHERE (t.installation_id,t.session_id)=(a.installation_id,a.session_id))
   AND NOT EXISTS(SELECT 1 FROM shared.memory_retained_artifact_refs h WHERE
    (h.installation_id,h.artifact_id,h.source_event_id,h.session_id,h.turn_id,h.artifact_type,h.identity_key,h.path,h.status,h.occurred_at,h.body_reclaimed_at)
     IS NOT DISTINCT FROM (a.installation_id,a.artifact_id,a.source_event_id,a.session_id,a.turn_id,a.artifact_type,a.identity_key,a.path,a.status,a.occurred_at,a.body_reclaimed_at)))
 THEN RAISE EXCEPTION 'artifact_custody_unproved'; END IF;
 IF EXISTS(SELECT 1 FROM memory.source_turns t WHERE t.turn_id NOT LIKE 'team-semantic:%'
  AND NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones d WHERE (d.installation_id,d.session_id)=(t.installation_id,t.session_id))
  AND NOT EXISTS(SELECT 1 FROM shared.memory_team_history_inputs h WHERE h.installation_id=t.installation_id AND h.kind='turn' AND h.id=t.turn_id
   AND h.session_id=t.session_id AND h.state=t.state AND h.metadata=jsonb_build_object('turn_id',t.turn_id,'session_id',t.session_id,
    'first_source_event_id',t.first_source_event_id,'last_source_event_id',t.last_source_event_id,'event_count',t.event_count))
  AND NOT EXISTS(SELECT 1 FROM memory.source_events e WHERE e.installation_id=t.installation_id AND e.turn_id=t.turn_id
    HAVING count(*)=t.event_count AND count(*)>0 AND bool_or(e.source_event_id=t.first_source_event_id)
     AND bool_or(e.source_event_id=t.last_source_event_id) AND bool_and(COALESCE(e.session_id=t.session_id AND e.canonical_session_key=t.session_id
      AND e.mapping_state='verified' AND e.source_kind IN('relay_event','legacy_archive') AND e.origin<>'team'
      AND e.source_provenance->>'source_kind' IS DISTINCT FROM 'team_session' AND NOT(e.source_provenance ? 'team'),FALSE))))
 THEN RAISE EXCEPTION 'historical_turn_identity_changed'; END IF;
 IF EXISTS(SELECT 1 FROM memory.source_sessions s WHERE s.deleted_at IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM memory.memory_session_tombstones t WHERE (t.installation_id,t.session_id)=(s.installation_id,s.session_id)))
 THEN RAISE EXCEPTION 'session_tombstone_not_adopted'; END IF;
 IF EXISTS(SELECT 1 FROM memory.memory_task_bundle_sources m WHERE NOT EXISTS(SELECT 1 FROM shared.memory_team_history_bundle_links h
   WHERE (h.installation_id,h.bundle_id,h.source_event_id,h.source_digest,h.source_sequence)=
    (m.installation_id,m.bundle_id,m.source_event_id,m.source_digest,m.source_sequence)))
 OR EXISTS(SELECT 1 FROM memory.memory_task_bundles WHERE dialogue_members IS NULL AND state NOT IN('completed','skipped_unresolved'))
 THEN RAISE EXCEPTION 'historical_task_members_unresolved'; END IF;
 IF EXISTS(SELECT 1 FROM memory.memory_task_bundles b
  JOIN memory.memory_task_bundle_sources member USING(installation_id,bundle_id)
  JOIN memory.source_events s USING(installation_id,source_event_id)
  JOIN memory.memory_source_retention_receipts r ON (r.installation_id,r.session_id,r.turn_id)=(s.installation_id,s.session_id,s.turn_id)
  WHERE b.dialogue_members IS NULL AND b.body_state='present')
 THEN RAISE EXCEPTION 'historical_bundle_retention_requires_review'; END IF;
 -- Preserve original episode identities and downstream audit links when
 -- their complete turn and every external locator have surviving parents.
 IF EXISTS(SELECT 1 FROM memory.work_episodes w WHERE w.compiler_version IS DISTINCT FROM 'relay-turn-v1'
  AND NOT (COALESCE(w.state='invalidated' OR w.body_reclaimed_at IS NOT NULL,FALSE)
    AND w.evidence_manifest='{}'::jsonb AND w.document='{}'::jsonb)
  AND (jsonb_typeof(w.evidence_manifest) IS DISTINCT FROM 'object'
   OR NOT EXISTS(SELECT 1 FROM memory.source_events s WHERE s.installation_id=w.installation_id
    AND s.session_id=w.session_id AND s.turn_id=w.turn_id
    HAVING count(*)>0 AND bool_and(COALESCE(s.source_kind IN('legacy_archive','team_semantic','team_delivery','team_collaboration'),FALSE)))
   OR NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(w.evidence_manifest)='object' THEN w.evidence_manifest ELSE '{}' END) entry
     WHERE entry.value ?| ARRAY['source_event_id','artifact_id'])
   OR EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(w.evidence_manifest)='object' THEN w.evidence_manifest ELSE '{}' END) entry
    CROSS JOIN LATERAL (VALUES('source_event_id'),('artifact_id')) keys(key)
    WHERE entry.value ? keys.key AND NOT EXISTS(SELECT 1 FROM shared.memory_native_evidence_handle(w.installation_id,
       CASE WHEN keys.key='source_event_id' THEN (entry.value->>keys.key)::uuid END,
       CASE WHEN keys.key='artifact_id' THEN (entry.value->>keys.key)::uuid END) h WHERE h.session_id=w.session_id))))
 THEN RAISE EXCEPTION 'historical_episode_dependencies_require_review'; END IF;
 IF EXISTS(SELECT 1 FROM (
  SELECT installation_id,source_event_id,artifact_id FROM memory.knowledge_evidence
  UNION ALL SELECT installation_id,source_event_id,artifact_id FROM memory.memory_skill_archive_sources) k
  WHERE (k.source_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shared.memory_native_evidence_handle(k.installation_id,k.source_event_id,NULL)))
  OR (k.artifact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shared.memory_native_evidence_handle(k.installation_id,NULL,k.artifact_id))))
 THEN RAISE EXCEPTION 'evidence_or_skill_parent_unresolved'; END IF;
 DROP TABLE memory.memory_task_bundle_sources,memory.source_artifacts,memory.source_turns,memory.source_events,memory.source_sessions RESTRICT;
 DROP FUNCTION IF EXISTS memory.memory_legacy_session_available(UUID,TEXT,BOOLEAN),shared.delete_unadopted_evidence() RESTRICT;
 UPDATE shared.memory_source_contract SET projection_storage_retired=TRUE,projection_retired_at=clock_timestamp() WHERE singleton;
END $core$;

DO $verify$
BEGIN
 IF EXISTS(SELECT FROM unnest(ARRAY['memory.source_events','memory.source_artifacts','memory.source_turns','memory.source_sessions',
  'memory.memory_task_bundle_sources','memory.memory_canonical_projection_progress','shared.memory_projection_policies',
  'shared.memory_projection_windows','shared.memory_source_shadow_progress','memory.memory_feed_inbox','memory.memory_inbox_checkpoints',
  'memory.memory_snapshot_events','memory.memory_snapshot_runs']) old_table WHERE to_regclass(old_table) IS NOT NULL)
 THEN RAISE EXCEPTION 'projection_retirement_incomplete'; END IF;
END $verify$;
\if :apply
COMMIT;
\else
ROLLBACK;
\endif
