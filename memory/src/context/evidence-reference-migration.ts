export const EVIDENCE_REFERENCE_MIGRATION={version:58,statements:[
 `ALTER TABLE memory_context_pack_evidence ADD COLUMN evidence_version_id UUID,ADD COLUMN excerpt_hash BYTEA,ADD COLUMN source_hash TEXT,ADD COLUMN source_version UUID,
   ADD CONSTRAINT memory_pack_evidence_snapshot CHECK(
     (evidence_version_id IS NULL AND excerpt_hash IS NULL AND source_hash IS NULL AND source_version IS NULL)
     OR(evidence_version_id IS NOT NULL AND source_version IS NOT NULL AND excerpt_hash IS NOT NULL AND octet_length(excerpt_hash)=32
       AND(source_hash IS NULL OR source_hash~'^[a-f0-9]{64}$'))),
   ADD CONSTRAINT memory_pack_evidence_version FOREIGN KEY(installation_id,evidence_version_id)
     REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE`,
 `CREATE TABLE memory_context_evidence_reads(
   receipt_id UUID PRIMARY KEY,installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
   pack_id UUID NOT NULL REFERENCES memory_context_packs(pack_id) ON DELETE CASCADE,
   source_installation_id UUID NOT NULL,evidence_id UUID NOT NULL,version_id UUID NOT NULL,
   excerpt_hash BYTEA NOT NULL CHECK(octet_length(excerpt_hash)=32),source_hash TEXT,
   page INTEGER NOT NULL CHECK(page BETWEEN 0 AND 3),max_chars INTEGER NOT NULL CHECK(max_chars BETWEEN 1 AND 4000),
   consumption_generation BIGINT NOT NULL CHECK(consumption_generation>0),actor_membership_id UUID,
   created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
 `CREATE INDEX memory_context_evidence_reads_scope ON memory_context_evidence_reads(installation_id,created_at)`,
 `CREATE TRIGGER knowledge_evidence_consumption_insert_delete AFTER INSERT OR DELETE ON knowledge_evidence
   FOR EACH ROW EXECUTE FUNCTION memory_bump_consumption_generation()`,
 `CREATE TRIGGER knowledge_evidence_consumption_update AFTER UPDATE OF version_id,excerpt,excerpt_hash,source_event_id,artifact_id,capsule_id ON knowledge_evidence
   FOR EACH ROW WHEN(OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.excerpt IS DISTINCT FROM NEW.excerpt
     OR OLD.excerpt_hash IS DISTINCT FROM NEW.excerpt_hash OR OLD.source_event_id IS DISTINCT FROM NEW.source_event_id
     OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id OR OLD.capsule_id IS DISTINCT FROM NEW.capsule_id)
   EXECUTE FUNCTION memory_bump_consumption_generation()`
]}
