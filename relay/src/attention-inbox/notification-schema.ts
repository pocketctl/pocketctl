import type pg from 'pg'

export async function initAttentionNotificationSchema(
  db: Pick<pg.Pool, 'query'>,
): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attention_notifications (
      notification_id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'system' CHECK (kind='system'),
      topic TEXT NOT NULL DEFAULT 'session_lifecycle' CHECK (topic='session_lifecycle'),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE(notification_id,user_id)
    );
    ALTER TABLE attention_notifications ADD COLUMN IF NOT EXISTS maintenance_day DATE;
    ALTER TABLE attention_notifications ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE attention_notifications ADD COLUMN IF NOT EXISTS maintenance_summary JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_notifications_daily
      ON attention_notifications(user_id,maintenance_day) WHERE maintenance_day IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_attention_notifications_user_order
      ON attention_notifications(user_id,created_at DESC,notification_id DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_notifications_expiry ON attention_notifications(expires_at);
    CREATE TABLE IF NOT EXISTS attention_notification_subjects (
      subject_id UUID PRIMARY KEY,
      notification_id UUID NOT NULL,
      user_id INT NOT NULL,
      operation_id UUID NOT NULL UNIQUE REFERENCES session_lifecycle_results(operation_id) ON DELETE CASCADE,
      session_id VARCHAR(128) NOT NULL,
      daemon_id VARCHAR(64) NOT NULL,
      title_snapshot VARCHAR(512) NOT NULL,
      daemon_name_snapshot VARCHAR(255) NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('archive','cool','resume','purge')),
      state TEXT NOT NULL CHECK (state IN ('running','succeeded','partial','failed','cancelled')),
      activity_at TIMESTAMPTZ NOT NULL,
      executed_at TIMESTAMPTZ,
      effective_purge_at TIMESTAMPTZ,
      reason_code VARCHAR(64) NOT NULL,
      FOREIGN KEY(notification_id,user_id) REFERENCES attention_notifications(notification_id,user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notification_subjects_page
      ON attention_notification_subjects(notification_id,subject_id);
    CREATE INDEX IF NOT EXISTS idx_notification_subjects_scope
      ON attention_notification_subjects(notification_id,daemon_id,subject_id);
    CREATE TABLE IF NOT EXISTS notification_delivery_outbox (
      delivery_id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_id UUID NOT NULL,
      revision BIGINT NOT NULL CHECK (revision>0),
      operation TEXT NOT NULL CHECK (operation IN ('changed','removed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      UNIQUE(notification_id,revision,operation)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_delivery_pending
      ON notification_delivery_outbox(delivery_id) WHERE delivered_at IS NULL;
  `)
}
