/** Explicit in-place historical authority: one necessary body, never a
 * fallback to arbitrary legacy payload and never invented provenance. */
export const LEGACY_SOURCE_ARCHIVE_MIGRATION={version:88,statements:[
 `ALTER TABLE source_events ADD COLUMN legacy_owner_user_id INTEGER CHECK(legacy_owner_user_id IS NULL OR legacy_owner_user_id>0),
  ADD COLUMN legacy_manifest_hash TEXT CHECK(legacy_manifest_hash IS NULL OR legacy_manifest_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT source_events_verified_legacy_archive CHECK(mapping_state<>'verified' OR source_kind<>'legacy_archive' OR
   (legacy_owner_user_id IS NOT NULL AND legacy_manifest_hash IS NOT NULL AND canonical_key=source_event_id::text
    AND session_id IS NOT NULL AND left(session_id,5)<>'team_' AND canonical_session_key=session_id AND origin IN('feed','snapshot')
    AND adapter_version='legacy-archive-v1' AND NOT(source_provenance ? 'team') AND NOT(source_provenance ? 'accepted_delivery'))) NOT VALID`,
 `CREATE OR REPLACE FUNCTION capture_memory_legacy_archive_sources() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r RECORD;BEGIN
   IF TG_OP='INSERT' THEN
    FOR r IN SELECT DISTINCT (legacy_owner_user_id::text||':'||canonical_session_key) COLLATE "C" AS root FROM archive_new
     WHERE source_kind='legacy_archive' AND mapping_state='verified' AND legacy_owner_user_id IS NOT NULL AND canonical_session_key IS NOT NULL ORDER BY root
     LOOP PERFORM shared.mark_memory_source_dirty('legacy_archive',r.root);END LOOP;
   ELSIF TG_OP='DELETE' THEN
    FOR r IN SELECT DISTINCT (legacy_owner_user_id::text||':'||canonical_session_key) COLLATE "C" AS root FROM archive_old
     WHERE source_kind='legacy_archive' AND mapping_state='verified' AND legacy_owner_user_id IS NOT NULL AND canonical_session_key IS NOT NULL ORDER BY root
     LOOP PERFORM shared.mark_memory_source_dirty('legacy_archive',r.root);END LOOP;
   ELSE
    FOR r IN SELECT root FROM(SELECT legacy_owner_user_id::text||':'||canonical_session_key AS root FROM archive_new WHERE source_kind='legacy_archive' AND mapping_state='verified' AND legacy_owner_user_id IS NOT NULL AND canonical_session_key IS NOT NULL
     UNION SELECT legacy_owner_user_id::text||':'||canonical_session_key AS root FROM archive_old WHERE source_kind='legacy_archive' AND mapping_state='verified' AND legacy_owner_user_id IS NOT NULL AND canonical_session_key IS NOT NULL)roots ORDER BY root COLLATE "C"
     LOOP PERFORM shared.mark_memory_source_dirty('legacy_archive',r.root);END LOOP;
   END IF;RETURN NULL;
  END $$`,
 `REVOKE ALL ON FUNCTION capture_memory_legacy_archive_sources() FROM PUBLIC`,
 `CREATE TRIGGER legacy_archive_capture_insert AFTER INSERT ON source_events REFERENCING NEW TABLE AS archive_new FOR EACH STATEMENT EXECUTE FUNCTION capture_memory_legacy_archive_sources();
  CREATE TRIGGER legacy_archive_capture_update AFTER UPDATE ON source_events REFERENCING OLD TABLE AS archive_old NEW TABLE AS archive_new FOR EACH STATEMENT EXECUTE FUNCTION capture_memory_legacy_archive_sources();
  CREATE TRIGGER legacy_archive_capture_delete AFTER DELETE ON source_events REFERENCING OLD TABLE AS archive_old FOR EACH STATEMENT EXECUTE FUNCTION capture_memory_legacy_archive_sources()`,
]} as const
