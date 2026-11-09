/** Only new, proven canonical references are body-free. No existing body,
 * UUID, origin or digest is rewritten by this additive migration. */
export const CANONICAL_REFERENCE_MIGRATION={version:91,statements:[
 `ALTER TABLE source_events ALTER COLUMN payload DROP NOT NULL`,
 `ALTER TABLE source_events DROP CONSTRAINT source_events_origin_check`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_origin_check CHECK(origin IN('feed','snapshot','team','canonical'))`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_bodyless_proof CHECK(payload IS NOT NULL OR
  COALESCE((mapping_state IN('verified','deleted','revoked') AND source_kind IN('relay_event','team_collaboration','team_delivery','legacy_archive')
   AND canonical_key IS NOT NULL AND canonical_session_key IS NOT NULL AND content_hash IS NOT NULL
   AND hash_version='canonical-json-sha256-v1' AND source_version IS NOT NULL AND adapter_version IS NOT NULL),FALSE))`,
 `ALTER TABLE source_events ADD CONSTRAINT source_events_canonical_metadata_only CHECK(origin<>'canonical' OR
  COALESCE((payload IS NULL AND mapping_state IN('verified','deleted','revoked') AND source_kind IN('relay_event','team_collaboration','team_delivery')
   AND adapter_version='canonical-ref-v1' AND content_hash=payload_hash),FALSE))`,
 // Retention revokes local usage rights without manufacturing a JSON body
 // for a reference that has never owned a compatibility body.
 `CREATE OR REPLACE FUNCTION memory_retention_source_metadata(value JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE retained JSONB;BEGIN
   IF value IS NULL THEN RETURN NULL;END IF;
   SELECT COALESCE(jsonb_object_agg(key,v),'{}'::jsonb) INTO retained FROM jsonb_each(value) AS e(key,v)
    WHERE key=ANY(ARRAY['repository_id','repo_snapshot_id','branch','commit_sha','worktree_identity',
     'session_id','turn_id','source_turn_id','event_id','message_id','part_id','revision','call_id','event_type',
     'status','team_source','accepted_delivery','source_class','source_kind','source_version']);
   IF pg_column_size(retained)>32768 THEN RAISE EXCEPTION 'retention_metadata_too_large';END IF;
   RETURN retained;END $$`,
]} as const
