import type pg from 'pg'

export async function initSessionDocumentSchema(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_session_unique
      ON sessions (user_id, session_id);

    CREATE TABLE IF NOT EXISTS session_documents (
      document_id VARCHAR(128) PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      document_format VARCHAR(16) NOT NULL,
      latest_version_id VARCHAR(128),
      last_source_turn_id VARCHAR(128) NOT NULL,
      last_source_event_id VARCHAR(256) NOT NULL,
      state VARCHAR(32) NOT NULL,
      reason_code VARCHAR(32),
      captured_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (user_id, session_id)
        REFERENCES sessions(user_id, session_id) ON DELETE CASCADE,
      UNIQUE (user_id, session_id, document_id),
      CHECK (char_length(display_name) BETWEEN 1 AND 255),
      CHECK (position('/' in display_name) = 0 AND position('\\' in display_name) = 0),
      CHECK (document_format IN ('markdown', 'html')),
      CHECK (state IN ('pending', 'available', 'unavailable')),
      CHECK (reason_code IS NULL OR reason_code IN (
        'too_large', 'invalid_encoding', 'path_outside_root', 'unsupported',
        'read_failed', 'session_quota', 'user_quota', 'integrity_failed',
        'protocol_invalid'
      ))
    );

    ALTER TABLE session_documents ADD COLUMN IF NOT EXISTS owner_retired BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_session_documents_session_latest
      ON session_documents (user_id, session_id, updated_at DESC, document_id);
    CREATE INDEX IF NOT EXISTS idx_session_documents_user_storage
      ON session_documents (user_id, document_id);

    CREATE TABLE IF NOT EXISTS session_document_versions (
      version_id VARCHAR(128) PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL,
      document_id VARCHAR(128) NOT NULL,
      source_turn_id VARCHAR(128) NOT NULL,
      source_event_id VARCHAR(256) NOT NULL,
      byte_size INT NOT NULL CHECK (byte_size >= 0),
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      captured_at TIMESTAMPTZ NOT NULL,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      content_bytes BYTEA NOT NULL,
      FOREIGN KEY (user_id, session_id, document_id)
        REFERENCES session_documents(user_id, session_id, document_id) ON DELETE CASCADE,
      UNIQUE (document_id, version_id),
      UNIQUE (document_id, sha256),
      CHECK (octet_length(content_bytes) = byte_size)
    );

    CREATE INDEX IF NOT EXISTS idx_session_document_versions_prune
      ON session_document_versions (document_id, committed_at ASC, version_id ASC);
    CREATE INDEX IF NOT EXISTS idx_session_document_versions_session_bytes
      ON session_document_versions (user_id, session_id, byte_size);
    CREATE INDEX IF NOT EXISTS idx_session_document_versions_user_bytes
      ON session_document_versions (user_id, byte_size);

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'session_documents_latest_version_fkey'
          AND conrelid = 'session_documents'::regclass
      ) THEN
        ALTER TABLE session_documents
          ADD CONSTRAINT session_documents_latest_version_fkey
          FOREIGN KEY (document_id, latest_version_id)
          REFERENCES session_document_versions(document_id, version_id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS session_document_uploads (
      version_id VARCHAR(128) PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL,
      document_id VARCHAR(128) NOT NULL,
      daemon_id VARCHAR(64) NOT NULL,
      daemon_generation BIGINT NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      document_format VARCHAR(16) NOT NULL,
      source_turn_id VARCHAR(128) NOT NULL,
      source_event_id VARCHAR(256) NOT NULL,
      total_bytes INT NOT NULL CHECK (total_bytes >= 0),
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      chunk_count INT NOT NULL CHECK (chunk_count >= 0),
      state VARCHAR(16) NOT NULL DEFAULT 'pending',
      reason_code VARCHAR(32),
      captured_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (user_id, session_id, document_id)
        REFERENCES session_documents(user_id, session_id, document_id) ON DELETE CASCADE,
      CHECK (document_format IN ('markdown', 'html')),
      CHECK (state IN ('pending', 'failed'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_document_uploads_expiry
      ON session_document_uploads (expires_at, version_id);
    CREATE INDEX IF NOT EXISTS idx_session_document_uploads_session
      ON session_document_uploads (user_id, session_id, document_id);

    CREATE TABLE IF NOT EXISTS session_document_upload_chunks (
      version_id VARCHAR(128) NOT NULL
        REFERENCES session_document_uploads(version_id) ON DELETE CASCADE,
      chunk_index INT NOT NULL CHECK (chunk_index >= 0),
      byte_offset INT NOT NULL CHECK (byte_offset >= 0),
      byte_size INT NOT NULL CHECK (byte_size > 0),
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      content_bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (version_id, chunk_index),
      UNIQUE (version_id, byte_offset),
      CHECK (octet_length(content_bytes) = byte_size)
    );

    CREATE INDEX IF NOT EXISTS idx_session_document_upload_chunks_range
      ON session_document_upload_chunks (version_id, byte_offset, byte_size);

    -- A Session transfer changes current authority, never the original document
    -- owner. Cascade only its route key; child composite keys retain that owner.
    DO $$ DECLARE c RECORD;BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE contype='f'
        AND conrelid='session_documents'::regclass AND confrelid='sessions'::regclass LOOP
        EXECUTE format('ALTER TABLE session_documents DROP CONSTRAINT %I',c.conname);
      END LOOP;
      ALTER TABLE session_documents ADD CONSTRAINT session_documents_route_fkey
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON UPDATE CASCADE ON DELETE CASCADE;
      FOR c IN SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE contype='f' AND conrelid IN('session_document_versions'::regclass,'session_document_uploads'::regclass)
         AND confrelid='session_documents'::regclass AND confupdtype<>'c' LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.relation,c.conname);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON UPDATE CASCADE',c.relation,c.conname,c.definition);
      END LOOP;
    END $$;

    CREATE OR REPLACE FUNCTION preserve_session_document_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF TG_TABLE_NAME='session_documents' AND (to_jsonb(NEW)->>'owner_retired')::boolean THEN RAISE EXCEPTION 'document owner retirement is server-owned';END IF;
        IF TG_TABLE_NAME<>'session_documents' AND NOT EXISTS(SELECT 1 FROM session_documents d WHERE d.document_id=NEW.document_id
          AND d.user_id=NEW.user_id AND d.session_id=NEW.session_id AND NOT d.owner_retired)
          THEN RAISE EXCEPTION 'document original owner retired';END IF;
        IF NOT EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=NEW.session_id AND s.user_id=NEW.user_id)
          THEN RAISE EXCEPTION 'document current owner required';END IF;
      ELSE
        IF TG_TABLE_NAME='session_documents' THEN
          IF OLD.owner_retired AND NOT NEW.owner_retired OR NEW.owner_retired IS DISTINCT FROM OLD.owner_retired AND pg_trigger_depth()<2
            THEN RAISE EXCEPTION 'document owner retirement is server-owned and permanent';END IF;
          IF OLD.owner_retired AND NEW.session_id=OLD.session_id AND NEW IS DISTINCT FROM OLD
            THEN RAISE EXCEPTION 'retired document is immutable';END IF;
        END IF;
        IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.document_id IS DISTINCT FROM OLD.document_id
          THEN RAISE EXCEPTION 'session document owner identity is immutable';END IF;
        IF NEW.session_id IS DISTINCT FROM OLD.session_id AND ((to_jsonb(NEW)-'session_id') IS DISTINCT FROM(to_jsonb(OLD)-'session_id') OR NOT EXISTS(
          SELECT 1 FROM session_aliases a JOIN sessions s ON s.session_id=a.next_session_id
           WHERE a.old_session_id=OLD.session_id AND a.next_session_id=NEW.session_id
            AND a.owner_user_id=s.user_id AND NOT a.blocked))
          THEN RAISE EXCEPTION 'unproved document route move';END IF;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS session_document_owner ON session_documents;
    CREATE TRIGGER session_document_owner BEFORE INSERT OR UPDATE ON session_documents
      FOR EACH ROW EXECUTE FUNCTION preserve_session_document_owner();
    DROP TRIGGER IF EXISTS session_document_upload_owner ON session_document_uploads;
    CREATE TRIGGER session_document_upload_owner BEFORE INSERT OR UPDATE ON session_document_uploads
      FOR EACH ROW EXECUTE FUNCTION preserve_session_document_owner();

    DROP TRIGGER IF EXISTS session_document_version_owner ON session_document_versions;
    CREATE TRIGGER session_document_version_owner BEFORE INSERT ON session_document_versions
      FOR EACH ROW EXECUTE FUNCTION preserve_session_document_owner();

    CREATE OR REPLACE FUNCTION prevent_session_document_version_update()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'session document versions are immutable';
    END $$;
    DROP TRIGGER IF EXISTS prevent_session_document_version_update
      ON session_document_versions;
    CREATE TRIGGER prevent_session_document_version_update
      BEFORE UPDATE ON session_document_versions
      FOR EACH ROW EXECUTE FUNCTION prevent_session_document_version_update();
  `)
}

export async function assertSessionDocumentSchema(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(`
    SELECT
      to_regclass('session_documents') IS NOT NULL
      AND to_regclass('session_document_versions') IS NOT NULL
      AND to_regclass('session_document_uploads') IS NOT NULL
      AND to_regclass('session_document_upload_chunks') IS NOT NULL
      AND to_regclass('idx_session_documents_session_latest') IS NOT NULL
      AND to_regclass('idx_session_document_uploads_expiry') IS NOT NULL
      AS ready
  `)
  if (result.rows[0]?.ready !== true) throw new Error('session document schema not ready')
}
