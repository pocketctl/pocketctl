/** Comparison-only metadata. No source body, active progress or knowledge is
 * written by these functions, and a body match is not full rollout acceptance. */
// Alias i is the same body-free delivery view row in the header and Worker reads.
export const shadowDeliveryFactRevisionSql="encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')"
export const SHARED_SOURCE_SHADOW_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS shadow_version INT NOT NULL DEFAULT 0`,
 `CREATE TABLE IF NOT EXISTS shared.memory_source_shadow_progress(
  installation_id UUID NOT NULL,source_kind TEXT NOT NULL,root_key TEXT NOT NULL,scan_id UUID NOT NULL,
  context_key TEXT NOT NULL CHECK(context_key ~ '^[a-f0-9]{64}$'),source_version JSONB NOT NULL,
  next_cursor TEXT,last_from_cursor TEXT,last_page_hash TEXT NOT NULL CHECK(last_page_hash ~ '^[a-f0-9]{64}$'),
  matched BIGINT NOT NULL CHECK(matched>=0),unproven BIGINT NOT NULL CHECK(unproven>=0),different BIGINT NOT NULL CHECK(different>=0),
  unknown_provenance BIGINT NOT NULL CHECK(unknown_provenance>=0),canonical_digest TEXT NOT NULL,legacy_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('waiting','scanning','body_identity_ready','different')),
  full_acceptance_ready BOOLEAN NOT NULL DEFAULT FALSE CHECK(NOT full_acceptance_ready),
  last_findings JSONB NOT NULL DEFAULT '[]',created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id,source_kind,root_key,scan_id,context_key))`,
 `ALTER TABLE shared.memory_source_shadow_progress ADD COLUMN IF NOT EXISTS observed_different BIGINT NOT NULL DEFAULT 0 CHECK(observed_different>=0),
  ADD COLUMN IF NOT EXISTS first_findings JSONB NOT NULL DEFAULT '[]',ADD COLUMN IF NOT EXISTS first_different_at TIMESTAMPTZ`,
 `UPDATE shared.memory_source_shadow_progress SET observed_different=different,first_findings=last_findings,first_different_at=updated_at
  WHERE different>observed_different`,
 `CREATE OR REPLACE FUNCTION shared.memory_shadow_candidate_headers(p_installation UUID,p_kind TEXT,p_keys TEXT[],p_sessions TEXT[])
  RETURNS TABLE(source_event_id TEXT,canonical_key TEXT,link_via TEXT,row_version TEXT,origin TEXT,origin_position TEXT,session_id TEXT,
   turn_id TEXT,event_type TEXT,occurred_at TEXT,payload_hash TEXT,classification JSONB,source_provenance JSONB,body_reclaimed BOOLEAN,metadata_limited BOOLEAN)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE snapshot_sources UUID[]:=ARRAY[]::uuid[];
  BEGIN
   IF p_installation IS NULL OR p_kind IS NULL OR p_kind NOT IN('relay_event','team_collaboration','team_delivery')
    OR cardinality(p_keys) NOT BETWEEN 0 AND 128 OR cardinality(p_sessions) NOT BETWEEN 0 AND 128 THEN RAISE EXCEPTION 'invalid_shadow_page';END IF;
   -- Snapshot event rows have no receipt projection. This statement is planned
   -- only before retirement, when the original per-event proof still exists.
   IF p_kind='relay_event' AND NOT COALESCE((SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton),FALSE) THEN
    SELECT ARRAY(
     SELECT s.source_event_id FROM memory.source_events s
     WHERE s.installation_id=p_installation AND s.origin='snapshot' AND s.origin_position=ANY(p_keys)
      AND EXISTS(SELECT 1 FROM memory.memory_snapshot_events snapshot
       WHERE snapshot.installation_id=s.installation_id AND snapshot.session_id=s.session_id AND snapshot.relay_event_id::text=s.origin_position
        AND snapshot.event_type=s.event_type AND snapshot.payload_hash=s.payload_hash)
     ORDER BY s.source_event_id LIMIT 257
    ) INTO snapshot_sources;
   END IF;
   RETURN QUERY WITH relations AS(
    SELECT s.source_event_id,s.canonical_key AS key,'typed-ref'::text AS via,NULL::text AS delivery_revision FROM memory.source_events s
     WHERE s.installation_id=p_installation AND s.source_kind=p_kind AND s.mapping_state='verified' AND s.canonical_key=ANY(p_keys)
    UNION
    SELECT s.source_event_id,substr(i.source_id,7),'inbox',${shadowDeliveryFactRevisionSql}
     FROM memory.memory_source_delivery_facts i JOIN memory.source_events s
     ON s.installation_id=i.installation_id AND s.origin='feed' AND s.origin_position=i.feed_id::text
      AND s.session_id=i.session_id AND s.turn_id IS NOT DISTINCT FROM i.turn_id
      AND s.event_type=i.event_type AND s.occurred_at=i.recorded_at
     WHERE p_kind='relay_event' AND i.installation_id=p_installation AND i.session_id=ANY(p_sessions) AND i.source_kind='canonical_event'
      AND i.projection_state='projected' AND i.error_code IS NULL
      AND i.source_id IN(SELECT 'event:'||key FROM unnest(p_keys) keys(key))
    UNION
    SELECT s.source_event_id,s.origin_position,'snapshot',NULL::text FROM memory.source_events s
     WHERE s.installation_id=p_installation AND s.source_event_id=ANY(snapshot_sources)
    UNION
    SELECT s.source_event_id,s.origin_position,'team-adapter',NULL::text FROM memory.source_events s
     WHERE s.installation_id=p_installation AND s.origin='team' AND s.origin_position=ANY(p_keys)
      AND s.source_provenance->>'source_kind'='team_session'
      AND s.source_provenance->>'source_version'=CASE WHEN p_kind='team_collaboration' THEN '1' WHEN p_kind='team_delivery' THEN '2' ELSE '' END
   ) SELECT s.source_event_id::text,r.key,r.via,s.xmin::text||COALESCE(':'||r.delivery_revision,''),
     s.origin,s.origin_position,s.session_id,s.turn_id,s.event_type,
     to_jsonb(s)->>'occurred_at',encode(s.payload_hash,'hex'),
     CASE WHEN octet_length(s.classification::text)<=1048576 THEN s.classification END,
     CASE WHEN octet_length(s.source_provenance::text)<=1048576 THEN s.source_provenance END,
     s.body_reclaimed_at IS NOT NULL,octet_length(s.classification::text)>1048576 OR octet_length(s.source_provenance::text)>1048576
    FROM relations r JOIN memory.source_events s USING(source_event_id)
    WHERE s.installation_id=p_installation AND s.origin IN('feed','snapshot','team') ORDER BY s.source_event_id,r.key,r.via LIMIT 257;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_source_shadow_progress(p_installation UUID,p_kind TEXT,p_root TEXT,p_scan UUID,p_context TEXT)
  RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
   SELECT jsonb_build_object('version',source_version,'nextCursor',next_cursor,'lastFromCursor',last_from_cursor,'pageHash',last_page_hash,
    'matched',matched::text,'unproven',unproven::text,'different',different::text,'unknownProvenance',unknown_provenance::text,
    'canonicalDigest',canonical_digest,'legacyDigest',legacy_digest,'state',state,'fullAcceptanceReady',FALSE,'findings',last_findings,
    'observedDifferent',observed_different::text,'firstFindings',first_findings,'firstDifferentAt',first_different_at)
   FROM shared.memory_source_shadow_progress WHERE installation_id=p_installation AND source_kind=p_kind AND root_key=p_root AND scan_id=p_scan AND context_key=p_context
  $$`,
 `CREATE OR REPLACE FUNCTION shared.write_memory_source_shadow_progress(p_execution UUID,p_scope JSONB,p_kind TEXT,p_root TEXT,p_scan UUID,p_context TEXT,p_meta JSONB)
  RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE execution shared.memory_source_executions;previous shared.memory_source_shadow_progress;comparison JSONB;
   installation UUID;source_keys TEXT[];session_keys TEXT[];session_key TEXT;observed JSONB;current_rows JSONB;
   source_fn TEXT;from_cursor TEXT;next_cursor TEXT;same_version BOOLEAN;waiting BOOLEAN;current_state TEXT;BEGIN
   IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'shadow_requires_read_committed';END IF;
   IF p_meta IS NULL OR jsonb_typeof(p_meta)<>'object' OR octet_length(p_meta::text)>1048576
    OR p_meta-ARRAY['version','fromCursor','nextCursor','canonicalKeys','sessionKeys','observations','comparison','pageHash']<>'{}'::jsonb
    OR p_context IS NULL OR p_context!~'^[a-f0-9]{64}$' OR p_meta->>'pageHash'!~'^[a-f0-9]{64}$'
    OR COALESCE(jsonb_typeof(p_meta->'version')<>'object',TRUE) OR (p_meta->'version')-ARRAY['content','authorization','storage']<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['content','authorization','storage']) fields(key) WHERE jsonb_typeof(p_meta->'version'->key) IS DISTINCT FROM 'string'
     OR length(p_meta->'version'->>key) NOT BETWEEN 1 AND 2048)
    OR COALESCE(length(p_meta->>'fromCursor'),0)>8192 OR COALESCE(length(p_meta->>'nextCursor'),0)>8192 THEN RAISE EXCEPTION 'invalid_shadow_page';END IF;
   IF NOT shared.assert_memory_job_source(p_execution,'compare') THEN RAISE EXCEPTION 'source_shadow_changed';END IF;
   SELECT * INTO execution FROM shared.memory_source_executions WHERE execution_id=p_execution AND branch='canonical-shadow';
   installation=(p_scope->>'installationId')::uuid;
   IF NOT FOUND OR execution.installation_id IS DISTINCT FROM installation OR execution.generation::text IS DISTINCT FROM p_scope->>'modeGeneration'
    OR NOT EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t JOIN shared.memory_source_distributions d ON d.scan_id=t.scan_id
      WHERE t.scan_id=p_scan AND t.source_scope=p_scope AND t.state='current' AND d.source_kind=p_kind AND d.root_key=p_root
       AND d.state='sealed' AND d.control_revision=execution.control_revision) THEN RAISE EXCEPTION 'source_shadow_changed';END IF;
   IF p_kind='relay_event' AND p_context IS DISTINCT FROM
    encode(sha256(convert_to('["'||shared.memory_source_scope_key(p_scope)||'","feed-envelope-v1"]','UTF8')),'hex')
   THEN RAISE EXCEPTION 'source_shadow_proof_context_changed';END IF;
   comparison=p_meta->'comparison';
   IF jsonb_typeof(comparison)<>'object' OR comparison-ARRAY['schemaVersion','matched','unproven','different','unknownProvenance','canonicalDigest','legacyDigest','fullAcceptanceReady','findings']<>'{}'::jsonb
    OR comparison->>'schemaVersion'<>'1' OR comparison->>'fullAcceptanceReady'<>'false'
    OR comparison->>'canonicalDigest'!~'^[a-f0-9]{64}$' OR comparison->>'legacyDigest'!~'^[a-f0-9]{64}$'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['matched','unproven','different','unknownProvenance']) fields(key)
     WHERE COALESCE(comparison->>key,'')!~'^[0-9]{1,3}$' OR (comparison->>key)::int>128)
    OR jsonb_typeof(comparison->'findings')<>'array' OR jsonb_array_length(comparison->'findings')>128 THEN RAISE EXCEPTION 'invalid_shadow_page';END IF;
   source_keys=ARRAY(SELECT jsonb_array_elements_text(p_meta->'canonicalKeys'));session_keys=ARRAY(SELECT jsonb_array_elements_text(p_meta->'sessionKeys'));
   IF cardinality(source_keys)>128 OR cardinality(session_keys)>128 OR jsonb_typeof(p_meta->'observations')<>'array'
    OR jsonb_array_length(p_meta->'observations')>256 OR (comparison->>'matched')::int+(comparison->>'unproven')::int+(comparison->>'different')::int<>cardinality(source_keys)
    OR (comparison->>'unknownProvenance')::int>(comparison->>'matched')::int THEN RAISE EXCEPTION 'invalid_shadow_page';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(comparison->'findings') finding
    WHERE jsonb_typeof(finding) IS DISTINCT FROM 'object' OR finding-ARRAY['canonicalKey','reason']<>'{}'::jsonb
     OR NOT COALESCE((finding->>'canonicalKey')=ANY(source_keys),FALSE) OR COALESCE(finding->>'reason','') NOT IN
      ('missing_identity_relation','duplicate_legacy_identity','installation_mismatch','source_metadata_mismatch','original_hash_mismatch','body_hash_mismatch','provenance_mismatch','canonical_hash_mismatch','source_unavailable'))
    THEN RAISE EXCEPTION 'invalid_shadow_page';END IF;
   source_fn=CASE WHEN p_kind='relay_event' THEN 'lock_memory_personal_source_commit' ELSE 'lock_memory_team_source_commit' END;
   IF p_kind NOT IN('relay_event','team_collaboration','team_delivery') THEN RAISE EXCEPTION 'invalid_shadow_page';END IF;
   IF source_fn='lock_memory_personal_source_commit' THEN
    IF NOT shared.lock_memory_personal_source_commit(p_scope,p_kind,p_root,p_meta->'version',FALSE) THEN RAISE EXCEPTION 'source_shadow_changed';END IF;
   ELSIF NOT shared.lock_memory_team_source_commit(p_scope,p_kind,p_root,p_meta->'version',FALSE) THEN RAISE EXCEPTION 'source_shadow_changed';END IF;
   FOR session_key IN SELECT DISTINCT key COLLATE "C" FROM unnest(session_keys) sessions(key) ORDER BY 1 LOOP
    IF length(session_key) NOT BETWEEN 1 AND 1024 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:session:'||installation::text||':'||session_key,0)) THEN RAISE EXCEPTION 'source_shadow_busy' USING ERRCODE='55P03';END IF;
   END LOOP;
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||installation::text,0)) THEN RAISE EXCEPTION 'source_shadow_busy' USING ERRCODE='55P03';END IF;
   PERFORM 1 FROM memory.source_events s WHERE s.installation_id=installation AND s.source_event_id IN
    (SELECT (item->>0)::uuid FROM jsonb_array_elements(p_meta->'observations') items(item)) ORDER BY s.source_event_id FOR SHARE NOWAIT;
   PERFORM 1 FROM memory.memory_source_delivery_facts i JOIN memory.source_events s
    ON s.installation_id=i.installation_id AND s.origin='feed' AND s.origin_position=i.feed_id::text
    WHERE i.installation_id=installation AND i.session_id=ANY(session_keys) AND s.source_event_id IN
     (SELECT (item->>0)::uuid FROM jsonb_array_elements(p_meta->'observations') items(item) WHERE item->>3='inbox')
    ORDER BY i.feed_id FOR SHARE OF i NOWAIT;
   SELECT COALESCE(jsonb_agg(jsonb_build_array(h.source_event_id,h.row_version,h.canonical_key,h.link_via)
    ORDER BY h.source_event_id COLLATE "C",h.canonical_key COLLATE "C",h.link_via COLLATE "C"),'[]') INTO current_rows
    FROM shared.memory_shadow_candidate_headers(installation,p_kind,source_keys,session_keys) h;
   IF current_rows IS DISTINCT FROM p_meta->'observations' THEN RAISE EXCEPTION 'source_shadow_legacy_changed';END IF;
   SELECT * INTO previous FROM shared.memory_source_shadow_progress s WHERE(s.installation_id,s.source_kind,s.root_key,s.scan_id,s.context_key)=(installation,p_kind,p_root,p_scan,p_context) FOR UPDATE NOWAIT;
   same_version=FOUND AND previous.source_version=p_meta->'version';from_cursor=p_meta->>'fromCursor';next_cursor=p_meta->>'nextCursor';
   IF same_version AND previous.last_page_hash=p_meta->>'pageHash' AND previous.last_from_cursor IS NOT DISTINCT FROM from_cursor THEN
    RETURN shared.read_memory_source_shadow_progress(installation,p_kind,p_root,p_scan,p_context);END IF;
   IF same_version AND previous.state IN('body_identity_ready','different') AND from_cursor IS NULL THEN same_version=FALSE;END IF;
   IF NOT same_version AND from_cursor IS NOT NULL OR same_version AND previous.next_cursor IS DISTINCT FROM from_cursor THEN RAISE EXCEPTION 'source_shadow_cursor_changed';END IF;
   IF NOT same_version THEN previous.matched=0;previous.unproven=0;previous.different=0;previous.unknown_provenance=0;
    previous.canonical_digest=encode(sha256(''::bytea),'hex');previous.legacy_digest=previous.canonical_digest;END IF;
   waiting=(comparison->>'unproven')::int>0;
   current_state=CASE WHEN waiting THEN 'waiting' WHEN next_cursor IS NOT NULL THEN 'scanning'
    WHEN previous.different+(comparison->>'different')::bigint>0 THEN 'different' ELSE 'body_identity_ready' END;
   INSERT INTO shared.memory_source_shadow_progress(installation_id,source_kind,root_key,scan_id,context_key,source_version,next_cursor,last_from_cursor,last_page_hash,
    matched,unproven,different,unknown_provenance,canonical_digest,legacy_digest,state,last_findings,observed_different,first_findings,first_different_at)
    VALUES(installation,p_kind,p_root,p_scan,p_context,p_meta->'version',CASE WHEN waiting THEN from_cursor ELSE next_cursor END,from_cursor,p_meta->>'pageHash',
     previous.matched+CASE WHEN waiting THEN 0 ELSE (comparison->>'matched')::bigint END,(comparison->>'unproven')::bigint,
     previous.different+CASE WHEN waiting THEN 0 ELSE (comparison->>'different')::bigint END,previous.unknown_provenance+CASE WHEN waiting THEN 0 ELSE (comparison->>'unknownProvenance')::bigint END,
     CASE WHEN waiting THEN previous.canonical_digest ELSE encode(sha256(convert_to(jsonb_build_array(previous.canonical_digest,comparison->>'canonicalDigest')::text,'UTF8')),'hex') END,
     CASE WHEN waiting THEN previous.legacy_digest ELSE encode(sha256(convert_to(jsonb_build_array(previous.legacy_digest,comparison->>'legacyDigest')::text,'UTF8')),'hex') END,current_state,comparison->'findings',
     (comparison->>'different')::bigint,CASE WHEN(comparison->>'different')::int>0 THEN comparison->'findings' ELSE '[]'::jsonb END,
     CASE WHEN(comparison->>'different')::int>0 THEN clock_timestamp() END)
    ON CONFLICT(installation_id,source_kind,root_key,scan_id,context_key) DO UPDATE SET source_version=EXCLUDED.source_version,next_cursor=EXCLUDED.next_cursor,
     last_from_cursor=EXCLUDED.last_from_cursor,last_page_hash=EXCLUDED.last_page_hash,matched=EXCLUDED.matched,unproven=EXCLUDED.unproven,different=EXCLUDED.different,
     unknown_provenance=EXCLUDED.unknown_provenance,canonical_digest=EXCLUDED.canonical_digest,legacy_digest=EXCLUDED.legacy_digest,state=EXCLUDED.state,
     last_findings=EXCLUDED.last_findings,observed_different=memory_source_shadow_progress.observed_different+EXCLUDED.observed_different,
     first_findings=CASE WHEN memory_source_shadow_progress.first_different_at IS NULL AND EXCLUDED.first_different_at IS NOT NULL THEN EXCLUDED.first_findings ELSE memory_source_shadow_progress.first_findings END,
     first_different_at=COALESCE(memory_source_shadow_progress.first_different_at,EXCLUDED.first_different_at),updated_at=clock_timestamp();
   RETURN shared.read_memory_source_shadow_progress(installation,p_kind,p_root,p_scan,p_context);
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_shadow_candidate_headers(UUID,TEXT,TEXT[],TEXT[]),shared.read_memory_source_shadow_progress(UUID,TEXT,TEXT,UUID,TEXT),
  shared.write_memory_source_shadow_progress(UUID,JSONB,TEXT,TEXT,UUID,TEXT,JSONB) FROM PUBLIC`,
 `UPDATE shared.memory_source_contract SET shadow_version=1 WHERE singleton`,
] as const
