// Format 0 stores the complete document. Format 1 is available only to the
// personal canonical writer after the existing source admission/commit fence.
export const compactSnapshotShapeSql = (row: string) => `${row}origin='canonical' AND ${row}source_kind='relay_event' AND ${row}mapping_state='verified'
  AND ${row}adapter_version='canonical-ref-v1' AND ${row}hash_version='canonical-json-sha256-v1'
  AND ${row}content_hash=${row}payload_hash AND ${row}payload IS NULL AND ${row}body_reclaimed_at IS NULL
  AND ${row}canonical_session_key=${row}session_id AND left(${row}session_id,5)<>'team_'
  AND jsonb_typeof(${row}source_provenance)='object' AND ${row}source_provenance->>'state'='known'
  AND NOT (${row}source_provenance ?| ARRAY['team','accepted_delivery'])
  AND jsonb_typeof(${row}classification->'memory_source')='object'
  AND ${row}classification#>'{memory_source,version}'='1'::jsonb
  AND ${row}classification#>>'{memory_source,session_id}'=${row}session_id
  AND ${row}classification#>>'{memory_source,turn_id}'=${row}turn_id
  AND ${row}classification#>>'{memory_source,sequence}'=${row}source_sequence::text`

export const SNAPSHOT_PROVENANCE_MIGRATION = {version:104, statements:[
  `ALTER TABLE source_events ADD COLUMN snapshot_format smallint NOT NULL DEFAULT 0,
   ADD CONSTRAINT source_events_snapshot_format CHECK(snapshot_format=0 OR
   (snapshot_format=1 AND COALESCE((${compactSnapshotShapeSql('')} AND NOT (source_provenance ? 'memory')),false))) NOT VALID`,
  // Existing rows have the constant default. The NOT VALID check already
  // enforces new writes and can be validated separately under a lighter lock.
  `CREATE FUNCTION memory_pack_snapshot_provenance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
   BEGIN
    IF TG_OP='INSERT' THEN
     -- A retention receipt can arrive after page preparation. The preceding
     -- retention trigger reclaimed this row. Restore its full snapshot.
     NEW.source_provenance=NEW.source_provenance || jsonb_build_object('memory',NEW.classification->'memory_source');
     NEW.snapshot_format=0;
     RETURN NEW;
    ELSIF OLD.snapshot_format=1 THEN
      -- Classification can be cleared or reclassified. Preserve the original
      -- logical proof unless the caller explicitly supplies a replacement.
      IF NEW.source_provenance IS NOT DISTINCT FROM OLD.source_provenance THEN
       NEW.source_provenance=OLD.source_provenance || jsonb_build_object('memory',OLD.classification->'memory_source');
      END IF;
    END IF;
    IF NEW.snapshot_format=1 THEN
     IF (${compactSnapshotShapeSql('NEW.')})
       AND NEW.source_provenance->'memory'=NEW.classification->'memory_source' THEN
      NEW.source_provenance=NEW.source_provenance-'memory';
     ELSE
      NEW.snapshot_format=0;
     END IF;
    END IF;
    RETURN NEW;
   END $$`,
  `CREATE TRIGGER memory_snapshot_pack_insert BEFORE INSERT ON source_events
   FOR EACH ROW WHEN (NEW.snapshot_format=1 AND NEW.body_reclaimed_at IS NOT NULL) EXECUTE FUNCTION memory_pack_snapshot_provenance()`,
  // Run after memory_retention_source_guard, including when it sets
  // body_reclaimed_at as a side effect of an otherwise unrelated UPDATE.
  `CREATE TRIGGER memory_snapshot_pack_update BEFORE UPDATE ON source_events
   FOR EACH ROW WHEN (OLD.snapshot_format IS DISTINCT FROM NEW.snapshot_format OR
    (OLD.snapshot_format=1 AND (NEW.body_reclaimed_at IS NOT NULL OR NEW.mapping_state IS DISTINCT FROM OLD.mapping_state
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.source_sequence IS DISTINCT FROM OLD.source_sequence OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.source_provenance IS DISTINCT FROM OLD.source_provenance
     OR NEW.classification IS DISTINCT FROM OLD.classification)))
   EXECUTE FUNCTION memory_pack_snapshot_provenance()`,
]} as const
