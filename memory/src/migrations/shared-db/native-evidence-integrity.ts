// The evidence key space is shared by archived originals and Team semantic
// records. Keep the installation-scoped existence check and delete propagation
// of the previous foreign keys across these typed parents.
export const NATIVE_EVIDENCE_INTEGRITY=[
 `CREATE OR REPLACE FUNCTION memory.memory_retention_reference_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,memory,shared AS $$
 DECLARE v JSONB:=to_jsonb(NEW);i UUID:=(v->>'installation_id')::uuid;k UUID;a UUID;h RECORD;BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||i,0));
  IF EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts r WHERE r.installation_id=i AND r.episode_id=(v->>'episode_id')::uuid)
   THEN RAISE EXCEPTION 'source_body_reclaimed';END IF;
  a=(v->>'artifact_id')::uuid;
  IF a IS NOT NULL THEN
   SELECT r.source_event_id INTO k FROM shared.memory_retained_artifact_refs r
    WHERE r.installation_id=i AND r.artifact_id=a FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'source_artifact_unavailable' USING ERRCODE='23503';END IF;
  END IF;
  FOR k IN SELECT DISTINCT id FROM unnest(ARRAY[k,(v->>'source_event_id')::uuid]) id WHERE id IS NOT NULL ORDER BY id LOOP
   PERFORM 1 FROM shared.memory_archive_records r WHERE r.installation_id=i AND r.source_event_id=k FOR SHARE NOWAIT;
   IF NOT FOUND THEN
    PERFORM 1 FROM shared.memory_team_history_inputs r WHERE r.installation_id=i AND r.kind='source' AND r.id=k::text AND r.native_ref IS NOT NULL FOR SHARE NOWAIT;
    IF NOT FOUND THEN
     PERFORM 1 FROM memory.memory_team_semantic_groups g WHERE g.installation_id=i AND g.semantic_ref_id=k FOR SHARE NOWAIT;
     IF NOT FOUND THEN RAISE EXCEPTION 'source_reference_missing' USING ERRCODE='23503';END IF;
    END IF;
   END IF;
   SELECT * INTO STRICT h FROM shared.memory_native_evidence_handle(i,k,NULL);
   IF h.body_reclaimed_at IS NOT NULL OR h.retention_denied THEN RAISE EXCEPTION 'source_body_reclaimed';END IF;
  END LOOP;
  IF a IS NOT NULL THEN
   SELECT * INTO STRICT h FROM shared.memory_native_evidence_handle(i,NULL,a);
   IF h.body_reclaimed_at IS NOT NULL OR h.retention_denied THEN RAISE EXCEPTION 'source_body_reclaimed';END IF;
  END IF;
  RETURN NEW;
 END $$`,
 `CREATE OR REPLACE FUNCTION memory.memory_record_evidence_source_sessions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared,memory AS $$ BEGIN
  DELETE FROM memory.memory_evidence_source_sessions WHERE installation_id=NEW.installation_id AND evidence_id=NEW.evidence_id;
  IF NEW.source_event_id IS NOT NULL OR NEW.artifact_id IS NOT NULL THEN
   INSERT INTO memory.memory_evidence_source_sessions SELECT DISTINCT NEW.installation_id,NEW.evidence_id,h.session_id
    FROM (SELECT v.* FROM shared.memory_native_evidence_handle(NEW.installation_id,NEW.source_event_id,NULL) v
     UNION ALL SELECT v.* FROM shared.memory_native_evidence_handle(NEW.installation_id,NULL,NEW.artifact_id) v
     UNION ALL SELECT v.* FROM shared.memory_retained_artifact_refs a
      CROSS JOIN LATERAL shared.memory_native_evidence_handle(a.installation_id,a.source_event_id,NULL) v
      WHERE a.installation_id=NEW.installation_id AND a.artifact_id=NEW.artifact_id) h WHERE h.session_id IS NOT NULL;
  END IF;RETURN NULL;
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.cascade_native_evidence_delete() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared,memory AS $$ DECLARE k UUID;BEGIN
  IF TG_TABLE_NAME='memory_retained_artifact_refs' THEN
   DELETE FROM memory.knowledge_evidence WHERE installation_id=OLD.installation_id AND artifact_id=OLD.artifact_id;
   DELETE FROM memory.memory_skill_archive_sources WHERE installation_id=OLD.installation_id AND artifact_id=OLD.artifact_id;
   RETURN NULL;
  ELSIF TG_TABLE_NAME='memory_team_history_inputs' THEN
   IF OLD.kind<>'source' OR OLD.native_ref IS NULL THEN RETURN NULL;END IF;
   k=OLD.id::uuid;
  ELSIF TG_TABLE_NAME='memory_team_semantic_groups' THEN k=OLD.semantic_ref_id;
  ELSE k=OLD.source_event_id;END IF;
  DELETE FROM shared.memory_retained_artifact_refs WHERE installation_id=OLD.installation_id AND source_event_id=k;
  DELETE FROM memory.knowledge_evidence WHERE installation_id=OLD.installation_id AND source_event_id=k;
  DELETE FROM memory.memory_skill_archive_sources WHERE installation_id=OLD.installation_id AND source_event_id=k;
  RETURN NULL;
 END $$`,
 ...['shared.memory_retained_artifact_refs','shared.memory_team_history_inputs','shared.memory_archive_records','memory.memory_team_semantic_groups'].map(table=>`
  DROP TRIGGER IF EXISTS cascade_native_evidence_delete ON ${table};
  CREATE CONSTRAINT TRIGGER cascade_native_evidence_delete AFTER DELETE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.cascade_native_evidence_delete()`),
 `REVOKE ALL ON FUNCTION shared.cascade_native_evidence_delete(),memory.memory_retention_reference_guard(),
 memory.memory_record_evidence_source_sessions() FROM PUBLIC`,
 // During a staged upgrade, trial rows can still be explicitly purged. Keep
 // cascade behavior for a former parent that has no surviving native identity.
 `CREATE OR REPLACE FUNCTION shared.delete_unadopted_evidence() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared,memory AS $$ BEGIN
  IF TG_TABLE_NAME='source_artifacts' THEN
   IF EXISTS(SELECT 1 FROM shared.memory_retained_artifact_refs WHERE installation_id=OLD.installation_id AND artifact_id=OLD.artifact_id) THEN RETURN NULL;END IF;
   DELETE FROM memory.knowledge_evidence WHERE installation_id=OLD.installation_id AND artifact_id=OLD.artifact_id;
   DELETE FROM memory.memory_skill_archive_sources WHERE installation_id=OLD.installation_id AND artifact_id=OLD.artifact_id;
  ELSE
   IF EXISTS(SELECT 1 FROM shared.memory_archive_records WHERE installation_id=OLD.installation_id AND source_event_id=OLD.source_event_id)
    OR EXISTS(SELECT 1 FROM shared.memory_team_history_inputs WHERE installation_id=OLD.installation_id AND kind='source' AND id=OLD.source_event_id::text AND native_ref IS NOT NULL)
    OR EXISTS(SELECT 1 FROM memory.memory_team_semantic_groups WHERE installation_id=OLD.installation_id AND semantic_ref_id=OLD.source_event_id)
   THEN RETURN NULL;END IF;
   DELETE FROM memory.knowledge_evidence WHERE installation_id=OLD.installation_id AND source_event_id=OLD.source_event_id;
   DELETE FROM memory.memory_skill_archive_sources WHERE installation_id=OLD.installation_id AND source_event_id=OLD.source_event_id;
  END IF;
  RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.delete_unadopted_evidence() FROM PUBLIC`,
 ...['source_events','source_artifacts'].map(table=>`DO $$ BEGIN IF to_regclass('memory.${table}') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS delete_unadopted_evidence ON memory.${table};
  CREATE TRIGGER delete_unadopted_evidence AFTER DELETE ON memory.${table} FOR EACH ROW EXECUTE FUNCTION shared.delete_unadopted_evidence();
 END IF; END $$`),
 `ALTER TABLE memory.knowledge_evidence DROP CONSTRAINT IF EXISTS knowledge_evidence_installation_id_source_event_id_fkey,
   DROP CONSTRAINT IF EXISTS knowledge_evidence_installation_id_artifact_id_fkey;
  ALTER TABLE memory.memory_skill_archive_sources DROP CONSTRAINT IF EXISTS memory_skill_archive_sources_installation_id_source_event__fkey,
   DROP CONSTRAINT IF EXISTS memory_skill_archive_sources_installation_id_artifact_id_fkey`,
] as const
