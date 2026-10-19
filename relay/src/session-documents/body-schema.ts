import type pg from 'pg'

/** Additive preparation. content_bytes retains NOT NULL until the full cold
 * publish gate, as with events. Logical version identities stay immutable. */
export async function initSessionDocumentBodySchema(db: Pick<pg.Pool,'query'>): Promise<void> {
  await db.query(`
    ALTER TABLE session_document_versions ADD COLUMN IF NOT EXISTS body_storage TEXT NOT NULL DEFAULT 'hot';
    ALTER TABLE session_document_versions ADD COLUMN IF NOT EXISTS body_manifest_id UUID;
    ALTER TABLE session_document_versions ADD COLUMN IF NOT EXISTS body_chunk_ordinal INT;
    -- FK checks and object GC query references without a body_storage predicate.
    CREATE INDEX IF NOT EXISTS idx_document_archive_body_reference ON session_document_versions(body_manifest_id,body_chunk_ordinal)
      WHERE body_manifest_id IS NOT NULL;
    ALTER TABLE session_document_versions ADD COLUMN IF NOT EXISTS body_activity_epoch BIGINT;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='session_document_versions'::regclass AND conname='document_body_location') THEN
        ALTER TABLE session_document_versions ADD CONSTRAINT document_body_location CHECK(
          (body_storage='hot' AND content_bytes IS NOT NULL AND body_manifest_id IS NULL AND body_chunk_ordinal IS NULL AND body_activity_epoch IS NULL)
          OR (body_storage='cold' AND content_bytes IS NULL AND body_manifest_id IS NOT NULL AND body_chunk_ordinal IS NOT NULL AND body_chunk_ordinal>=0 AND body_activity_epoch IS NOT NULL AND body_activity_epoch>=0));
        ALTER TABLE session_document_versions ADD CONSTRAINT document_body_manifest_binding
          FOREIGN KEY(body_manifest_id,user_id,session_id,body_activity_epoch)
          REFERENCES session_archive_manifests(manifest_id,user_id,session_id,activity_epoch);
        ALTER TABLE session_document_versions ADD CONSTRAINT document_body_chunk_binding
          FOREIGN KEY(body_manifest_id,body_chunk_ordinal) REFERENCES session_archive_chunks(manifest_id,ordinal);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_body_chunk_unique ON session_document_versions(body_manifest_id,body_chunk_ordinal) WHERE body_storage='cold';

    CREATE OR REPLACE FUNCTION prevent_session_document_version_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF (to_jsonb(NEW)-ARRAY['content_bytes','body_storage','body_manifest_id','body_chunk_ordinal','body_activity_epoch'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['content_bytes','body_storage','body_manifest_id','body_chunk_ordinal','body_activity_epoch']) THEN
        RAISE EXCEPTION 'session document versions are immutable';
      END IF;
      IF OLD.body_storage='hot' AND NEW.body_storage='cold' AND NEW.content_bytes IS NULL
        AND EXISTS(SELECT 1 FROM session_archive_manifests m WHERE m.manifest_id=NEW.body_manifest_id AND m.state='published'
          AND m.user_id=NEW.user_id AND m.session_id=NEW.session_id AND m.activity_epoch=NEW.body_activity_epoch
          AND NOT EXISTS(SELECT 1 FROM session_archive_object_deletions q JOIN session_archive_chunks c ON c.object_key=q.object_key
            WHERE c.manifest_id=m.manifest_id AND c.ordinal=NEW.body_chunk_ordinal AND q.storage_namespace=m.storage_namespace)) THEN RETURN NEW; END IF;
      IF OLD.body_storage='cold' AND NEW.body_storage='hot' AND NEW.content_bytes IS NOT NULL
        AND octet_length(NEW.content_bytes)=NEW.byte_size AND encode(sha256(NEW.content_bytes),'hex')=NEW.sha256 THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'session document versions are immutable';
    END $$;

    CREATE OR REPLACE FUNCTION enqueue_pruned_document_body() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.body_storage='cold' THEN
        INSERT INTO session_archive_object_deletions(storage_namespace,object_key,user_id,session_id,state)
        SELECT COALESCE(m.storage_namespace,'legacy-unknown'),c.object_key,OLD.user_id,OLD.session_id,
          CASE WHEN m.storage_namespace IS NULL THEN 'blocked' ELSE 'pending' END
        FROM session_archive_chunks c JOIN session_archive_manifests m USING(manifest_id)
        WHERE c.manifest_id=OLD.body_manifest_id AND c.ordinal=OLD.body_chunk_ordinal
          AND NOT EXISTS(SELECT 1 FROM events e WHERE e.body_manifest_id=c.manifest_id AND e.body_chunk_ordinal=c.ordinal)
          AND NOT EXISTS(SELECT 1 FROM session_document_versions v WHERE v.body_manifest_id=c.manifest_id AND v.body_chunk_ordinal=c.ordinal AND v.version_id<>OLD.version_id)
        ON CONFLICT(storage_namespace,object_key) DO NOTHING;
      END IF;
      RETURN OLD;
    END $$;
    DROP TRIGGER IF EXISTS queue_pruned_document_body ON session_document_versions;
    CREATE TRIGGER queue_pruned_document_body BEFORE DELETE ON session_document_versions FOR EACH ROW EXECUTE FUNCTION enqueue_pruned_document_body();
    DROP TRIGGER IF EXISTS queue_rewarmed_document_body ON session_document_versions;
    CREATE TRIGGER queue_rewarmed_document_body AFTER UPDATE OF body_storage ON session_document_versions
      FOR EACH ROW WHEN (OLD.body_storage='cold' AND NEW.body_storage='hot') EXECUTE FUNCTION enqueue_pruned_document_body();
  `)
}
