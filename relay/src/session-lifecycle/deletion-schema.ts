import type pg from 'pg'

export async function initLifecycleDeletionSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS session_lifecycle_deletions (
    session_id VARCHAR(128) PRIMARY KEY,user_id INT,daemon_id VARCHAR(64),operation_id UUID,
    database_deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),objects_completed_at TIMESTAMPTZ,extensions_completed_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_lifecycle_deletions_user_page ON session_lifecycle_deletions(user_id,session_id);
  CREATE TABLE IF NOT EXISTS extension_session_deletions (
    request_id UUID PRIMARY KEY,provider_id TEXT NOT NULL,installation_id UUID NOT NULL,session_id VARCHAR(128) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acked')),requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acked_at TIMESTAMPTZ,provider_receipt VARCHAR(512),UNIQUE(installation_id,session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_extension_session_deletion_pending ON extension_session_deletions(provider_id,requested_at,request_id) WHERE status='pending';
  CREATE OR REPLACE FUNCTION journal_session_deletion() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO deleted_sessions(session_id) VALUES(OLD.session_id) ON CONFLICT DO NOTHING;
    INSERT INTO session_lifecycle_deletions(session_id,user_id,daemon_id) VALUES(OLD.session_id,OLD.user_id,OLD.daemon_id) ON CONFLICT DO NOTHING;
    IF OLD.user_id IS NOT NULL THEN
      PERFORM pg_notify('pocketctl_attention',json_build_object('entity','lifecycle','user_id',OLD.user_id,'item_id',OLD.session_id,'revision',1,'operation','removed')::text);
    END IF;
    INSERT INTO extension_session_deletions(request_id,provider_id,installation_id,session_id)
      SELECT gen_random_uuid(),provider_id,installation_id,OLD.session_id FROM extension_installations
      WHERE owner_user_id=OLD.user_id AND owner_scope_kind='personal' AND status IN ('pending','active','paused','revoking')
        AND 'session:deletion:read'=ANY(granted_scopes)
      ON CONFLICT(installation_id,session_id) DO NOTHING;
    RETURN OLD;
  END $$;
  DROP TRIGGER IF EXISTS session_deletion_journal ON sessions;
  CREATE TRIGGER session_deletion_journal BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION journal_session_deletion();
  ALTER TABLE session_archive_object_deletions ALTER COLUMN next_attempt_at SET DEFAULT (NOW()+interval '10 minutes');`)
}
