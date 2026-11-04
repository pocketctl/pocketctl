import {DATA_RETENTION_MIGRATION} from './migration.js'
/** Body state is explicit before any physical reclamation is enabled. */
export const LIFECYCLE_RETENTION_MIGRATION={version:80,statements:[
 `ALTER TABLE memory_source_retention_receipts ALTER COLUMN episode_id DROP NOT NULL`,
 `ALTER TABLE memory_claim_lifecycle
  ADD COLUMN value_assessment TEXT NOT NULL DEFAULT 'unknown' CHECK(value_assessment IN('unknown','low','retain')),
  ADD COLUMN observation_started_at TIMESTAMPTZ, ADD COLUMN last_delivered_at TIMESTAMPTZ,
  ADD COLUMN last_confirmed_use_at TIMESTAMPTZ`,
 `ALTER TABLE knowledge_versions ADD COLUMN body_state TEXT NOT NULL DEFAULT 'present' CHECK(body_state IN('present','reclaimed')),
  ADD COLUMN body_hash TEXT CHECK(body_hash IS NULL OR body_hash~'^[a-f0-9]{64}$'), ADD COLUMN body_reclaimed_at TIMESTAMPTZ,
  ADD CONSTRAINT knowledge_versions_reclaimed_body CHECK(body_state='present' OR (body_hash IS NOT NULL AND body_reclaimed_at IS NOT NULL AND statement='[content reclaimed]' AND structured_content='{}'::jsonb))`,
 `CREATE TABLE memory_version_retention_protections (
  installation_id UUID NOT NULL,version_id UUID NOT NULL,reason TEXT NOT NULL CHECK(reason IN('dependency','rollback','user')),
  expires_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id,version_id,reason),
  FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE)`,
 `CREATE TABLE memory_lifecycle_maintenance_receipts (
  installation_id UUID NOT NULL,claim_id UUID NOT NULL,version_id UUID,
  action TEXT NOT NULL CHECK(action IN('cool','reactivate','reclaim_history','reclaim_body')),
  lifecycle_revision BIGINT NOT NULL,body_bytes BIGINT NOT NULL DEFAULT 0 CHECK(body_bytes>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(installation_id,claim_id,action,lifecycle_revision),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE)`,
 `CREATE TRIGGER memory_lifecycle_consumption_insert_delete AFTER INSERT OR DELETE ON memory_claim_lifecycle
  FOR EACH ROW EXECUTE FUNCTION memory_bump_consumption_generation()`,
 `CREATE TRIGGER memory_lifecycle_consumption_update AFTER UPDATE OF storage_tier,body_state,protection ON memory_claim_lifecycle
  FOR EACH ROW WHEN(OLD.storage_tier IS DISTINCT FROM NEW.storage_tier OR OLD.body_state IS DISTINCT FROM NEW.body_state OR OLD.protection IS DISTINCT FROM NEW.protection)
  EXECUTE FUNCTION memory_bump_consumption_generation()`,
 `CREATE TRIGGER memory_version_body_consumption_update AFTER UPDATE OF body_state ON knowledge_versions
  FOR EACH ROW WHEN(OLD.body_state IS DISTINCT FROM NEW.body_state) EXECUTE FUNCTION memory_bump_consumption_generation()`,
 `CREATE FUNCTION memory_version_body_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.body_state='reclaimed' AND (NEW.body_state<>OLD.body_state OR NEW.statement<>OLD.statement OR NEW.structured_content<>OLD.structured_content OR NEW.body_hash IS DISTINCT FROM OLD.body_hash OR NEW.body_reclaimed_at IS DISTINCT FROM OLD.body_reclaimed_at)
  THEN RAISE EXCEPTION 'version_body_reclaimed'; END IF;
  IF OLD.body_state='present' AND NEW.body_state='reclaimed' AND NEW.body_hash<>encode(sha256(convert_to(jsonb_build_object('statement',OLD.statement,'structured_content',OLD.structured_content)::text,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'version_body_hash_mismatch'; END IF; RETURN NEW; END $$`,
 `CREATE TRIGGER memory_version_body_guard BEFORE UPDATE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION memory_version_body_guard()`,
 `CREATE FUNCTION memory_logical_delete_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=OLD.installation_id) THEN RETURN OLD; END IF;
  INSERT INTO memory_logical_tombstones(installation_id,logical_key)
   SELECT installation_id,logical_key FROM memory_logical_claims WHERE installation_id=OLD.installation_id AND claim_id=OLD.claim_id
   ON CONFLICT DO NOTHING; RETURN OLD; END $$`,
 `CREATE TRIGGER memory_logical_delete_fence BEFORE DELETE ON knowledge_claims FOR EACH ROW EXECUTE FUNCTION memory_logical_delete_fence()`,
 `CREATE FUNCTION memory_logical_replay_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM memory_logical_tombstones WHERE installation_id=NEW.installation_id AND logical_key=NEW.logical_key)
  THEN RAISE EXCEPTION 'logical_identity_deleted'; END IF; RETURN NEW; END $$`,
 `CREATE TRIGGER memory_logical_replay_guard BEFORE INSERT OR UPDATE ON memory_logical_claims FOR EACH ROW EXECUTE FUNCTION memory_logical_replay_guard()`,
 `CREATE TRIGGER memory_retention_reference_guard BEFORE INSERT OR UPDATE ON memory_task_bundle_sources
  FOR EACH ROW EXECUTE FUNCTION memory_retention_reference_guard()`,
 `CREATE FUNCTION memory_task_body_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.body_state='reclaimed' AND (NEW.body_state<>OLD.body_state OR NEW.source_digest<>OLD.source_digest OR NEW.revision<>OLD.revision OR NEW.state<>OLD.state OR NEW.topic_descriptor IS DISTINCT FROM OLD.topic_descriptor OR NEW.spans IS DISTINCT FROM OLD.spans)
  THEN RAISE EXCEPTION 'task_body_reclaimed'; END IF;RETURN NEW;END $$`,
 `CREATE TRIGGER memory_task_body_guard BEFORE UPDATE ON memory_task_bundles FOR EACH ROW EXECUTE FUNCTION memory_task_body_guard()`,
 `CREATE FUNCTION memory_task_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.result IS NOT NULL AND EXISTS(SELECT 1 FROM memory_task_bundles WHERE installation_id=NEW.installation_id AND bundle_id=NEW.bundle_id AND body_state='reclaimed')
  THEN RAISE EXCEPTION 'task_body_reclaimed';END IF;RETURN NEW;END $$`,
 `CREATE TRIGGER memory_task_result_guard BEFORE INSERT OR UPDATE OF result ON memory_curation_runs FOR EACH ROW EXECUTE FUNCTION memory_task_result_guard()`,
 // Restore replay must redact an old backup while semantic writers remain on
 // hold. Permit only the exact irreversible body removal, never admission.
 DATA_RETENTION_MIGRATION.statements.find(sql=>sql.startsWith('CREATE OR REPLACE FUNCTION memory_governance_fence_writer'))!
  .replace('IF old_record=new_record THEN RETURN NEW; END IF;',`IF old_record=new_record THEN RETURN NEW; END IF;
   IF TG_TABLE_NAME='knowledge_versions' AND old_record->>'body_state'='present' AND new_record->>'body_state'='reclaimed'
    AND new_record->>'statement'='[content reclaimed]' AND new_record->'structured_content'='{}'::jsonb
    AND new_record->>'body_reclaimed_at' IS NOT NULL
    AND new_record->>'body_hash'=encode(sha256(convert_to(jsonb_build_object('statement',old_record->'statement','structured_content',old_record->'structured_content')::text,'UTF8')),'hex')
    AND(old_record-ARRAY['statement','structured_content','body_state','body_hash','body_reclaimed_at'])=(new_record-ARRAY['statement','structured_content','body_state','body_hash','body_reclaimed_at'])
    THEN RETURN NEW; END IF;`)
  .replace("AND r.episode_id=(new_record->>'episode_id')::uuid)",`AND (r.episode_id=(new_record->>'episode_id')::uuid OR EXISTS(
   SELECT 1 FROM memory_task_bundle_sources bs JOIN source_events se USING(installation_id,source_event_id)
    WHERE bs.installation_id=r.installation_id AND bs.bundle_id=(new_record->>'bundle_id')::uuid AND se.turn_id=r.turn_id
     AND NOT EXISTS(SELECT 1 FROM memory_task_bundle_sources members JOIN source_events source USING(installation_id,source_event_id)
      WHERE members.installation_id=bs.installation_id AND members.bundle_id=bs.bundle_id AND source.body_reclaimed_at IS NULL))))`),
]}
