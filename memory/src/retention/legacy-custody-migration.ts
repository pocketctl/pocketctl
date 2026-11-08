/** Ordinary Memory retention retires use/derived material. A reviewed
 * legacy_archive is canonical custody, so it is retained until a separate
 * explicit privacy deletion or canonical retirement, never by usage TTL. */
export const LEGACY_CUSTODY_RETENTION_MIGRATION={version:93,statements:[
 `CREATE OR REPLACE FUNCTION memory_retention_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE receipt memory_source_retention_receipts%ROWTYPE; key TEXT; previous_reclaimed TIMESTAMPTZ;
  BEGIN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||NEW.installation_id,0));
   IF TG_OP='UPDATE' THEN previous_reclaimed:=OLD.body_reclaimed_at;END IF;
   IF TG_TABLE_NAME='memory_snapshot_events' THEN
    key:=COALESCE(NULLIF(NEW.payload->>'turn_id',''),NULLIF(NEW.payload->>'source_turn_id',''));
   ELSE key:=NEW.turn_id;END IF;
   SELECT * INTO receipt FROM memory_source_retention_receipts WHERE installation_id=NEW.installation_id AND turn_id=key;
   -- Preserve only an already existing, unreclaimed canonical archive body.
   -- An INSERT/reclaimed row never gains a rehydration bypass. Explicit
   -- clearing/body reclamation and DELETE remain available to privacy purge.
   IF TG_TABLE_NAME='source_events' AND TG_OP='UPDATE' THEN
    -- Nest the row-type-specific expression: other guarded tables have no
    -- source_kind. Do not serialize the composite row or detoast its body.
    IF OLD.source_kind='legacy_archive' THEN
     IF FOUND OR EXISTS(SELECT 1 FROM memory_source_retention_receipts WHERE installation_id=OLD.installation_id AND session_id=OLD.session_id AND(OLD.turn_id IS NULL OR turn_id=OLD.turn_id)) THEN
      IF (NEW.installation_id,NEW.source_event_id,NEW.session_id,NEW.turn_id,NEW.source_kind,NEW.canonical_key,NEW.canonical_session_key,NEW.legacy_owner_user_id,
       NEW.origin,NEW.origin_position,NEW.event_type) IS DISTINCT FROM
       (OLD.installation_id,OLD.source_event_id,OLD.session_id,OLD.turn_id,OLD.source_kind,OLD.canonical_key,OLD.canonical_session_key,OLD.legacy_owner_user_id,
       OLD.origin,OLD.origin_position,OLD.event_type) THEN RAISE EXCEPTION 'retained_source_identity_changed';END IF;
      IF NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN RAISE EXCEPTION 'retained_source_hash_changed';END IF;
     END IF;
     IF NEW.source_kind='legacy_archive' AND OLD.body_reclaimed_at IS NULL AND NEW.body_reclaimed_at IS NULL THEN RETURN NEW;END IF;
    END IF;
   END IF;
   IF FOUND OR(TG_OP='UPDATE' AND OLD.body_reclaimed_at IS NOT NULL) THEN
    IF TG_TABLE_NAME='source_artifacts' THEN NEW.details:='{}'::jsonb;
    ELSE NEW.payload:=memory_retention_source_metadata(NEW.payload);END IF;
    NEW.body_reclaimed_at:=COALESCE(receipt.reclaimed_at,previous_reclaimed,clock_timestamp());
    IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'source_artifacts' THEN
     IF NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN RAISE EXCEPTION 'retained_source_hash_changed';END IF;
    END IF;
   END IF;
   RETURN NEW;
  END $$`,
]} as const
