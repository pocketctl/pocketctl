import type pg from 'pg';

export async function initSessionOrganizationSchema(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_organization_cutover (
      key TEXT PRIMARY KEY,
      enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO session_organization_cutover(key) VALUES ('terminal-new-v1') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS session_projects (
      id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(36) NOT NULL,
      sort_position BIGINT NOT NULL,
      order_mode VARCHAR(16) NOT NULL DEFAULT 'activity' CHECK (order_mode IN ('activity','manual')),
      revision BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_projects_name ON session_projects(user_id, lower(name));
    CREATE INDEX IF NOT EXISTS idx_session_projects_order ON session_projects(user_id, sort_position, id);
    CREATE TABLE IF NOT EXISTS session_organization_settings (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      project_order_revision BIGINT NOT NULL DEFAULT 0,
      ungrouped_order_mode VARCHAR(16) NOT NULL DEFAULT 'activity' CHECK (ungrouped_order_mode IN ('activity','manual')),
      ungrouped_revision BIGINT NOT NULL DEFAULT 0
    );
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id UUID;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS manual_rank BIGINT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS membership_changed_at TIMESTAMPTZ;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_badge_pending BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_badge_seen_at TIMESTAMPTZ;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS organization_revision BIGINT NOT NULL DEFAULT 0;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_project_requires_owner') THEN
        ALTER TABLE sessions ADD CONSTRAINT sessions_project_requires_owner CHECK (project_id IS NULL OR user_id IS NOT NULL);
      END IF;
    END $$;
    ALTER TABLE quota_reservations ADD COLUMN IF NOT EXISTS project_id UUID;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_project_owner_fk') THEN
        ALTER TABLE sessions ADD CONSTRAINT sessions_project_owner_fk
          FOREIGN KEY (project_id, user_id) REFERENCES session_projects(id, user_id) ON DELETE SET NULL (project_id);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_sessions_organization_bucket
      ON sessions(user_id, project_id, daemon_id, pinned DESC, manual_rank, session_id)
      WHERE archived_at IS NULL AND COALESCE(is_subagent, false) = false;
    CREATE INDEX IF NOT EXISTS idx_sessions_organization_archive
      ON sessions(user_id, archived_at DESC, session_id DESC)
      WHERE archived_at IS NOT NULL AND COALESCE(is_subagent, false) = false;
  `);
}
