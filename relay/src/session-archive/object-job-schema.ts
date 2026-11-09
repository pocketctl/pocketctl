import type pg from 'pg'

/** No owner FK: cleanup must survive account, daemon and manifest deletion. */
export async function initArchiveObjectJobSchema(db: Pick<pg.Pool,'query'>): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS session_archive_object_deletions (
    storage_namespace TEXT NOT NULL,
    object_key TEXT NOT NULL,
    user_id INT NOT NULL,
    session_id VARCHAR(128) NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','deleted','blocked')),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    attempt INT NOT NULL DEFAULT 0 CHECK(attempt>=0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error_code VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY(storage_namespace,object_key),
    CHECK(length(object_key)<=512),
    CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
       OR (state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
  );
  ALTER TABLE session_archive_object_deletions ADD COLUMN IF NOT EXISTS deletion_subject_session_id VARCHAR(128);
  CREATE INDEX IF NOT EXISTS idx_archive_object_deletion_subject ON session_archive_object_deletions(deletion_subject_session_id,state);
  CREATE INDEX IF NOT EXISTS idx_archive_object_deletion_claim ON session_archive_object_deletions(next_attempt_at,created_at)
    WHERE state IN ('pending','running');
  CREATE OR REPLACE FUNCTION enqueue_deleted_archive_manifest() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO session_archive_object_deletions(storage_namespace,object_key,user_id,session_id,state,deletion_subject_session_id)
    SELECT COALESCE(OLD.storage_namespace,'legacy-unknown'),c.object_key,OLD.user_id,OLD.session_id,
      CASE WHEN OLD.storage_namespace IS NULL THEN 'blocked' ELSE 'pending' END,
      COALESCE((SELECT d.session_id FROM session_lifecycle_deletions d WHERE d.user_id=OLD.user_id AND OLD.session_id=ANY(public.native_session_alias_set(ARRAY[d.session_id])) ORDER BY d.database_deleted_at DESC LIMIT 1),OLD.session_id)
    FROM session_archive_chunks c WHERE c.manifest_id=OLD.manifest_id
    ON CONFLICT(storage_namespace,object_key) DO UPDATE SET deletion_subject_session_id=EXCLUDED.deletion_subject_session_id;
    RETURN OLD;
  END $$;
  DROP TRIGGER IF EXISTS queue_deleted_archive_manifest ON session_archive_manifests;
  CREATE TRIGGER queue_deleted_archive_manifest BEFORE DELETE ON session_archive_manifests
    FOR EACH ROW EXECUTE FUNCTION enqueue_deleted_archive_manifest();`)
}
