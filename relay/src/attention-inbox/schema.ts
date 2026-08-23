import type pg from 'pg'

export async function initAttentionInboxSchema(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attention_items (
      item_id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      daemon_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      request_id TEXT NOT NULL,
      provider VARCHAR(32) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      state VARCHAR(32) NOT NULL,
      risk_level VARCHAR(16) NOT NULL DEFAULT 'high',
      classification_incomplete BOOLEAN NOT NULL DEFAULT TRUE,
      risk_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
      resolution_event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
      source_event_type VARCHAR(64) NOT NULL,
      source_event_key TEXT,
      revision BIGINT NOT NULL DEFAULT 1,
      seen_at TIMESTAMPTZ,
      snoozed_until TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ,
      submission_deadline_at TIMESTAMPTZ,
      submission_key UUID,
      resolved_at TIMESTAMPTZ,
      handled_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      resolution JSONB,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (provider IN ('codex', 'opencode', 'claude-code')),
      CHECK (kind IN ('approval', 'question')),
      CHECK (state IN ('open', 'snoozed', 'submitting', 'result_unknown', 'resolved', 'expired')),
      CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
      UNIQUE (user_id, daemon_id, session_id, request_id, kind)
    );

    ALTER TABLE attention_items ADD COLUMN IF NOT EXISTS risk_reasons
      JSONB NOT NULL DEFAULT '[]'::jsonb;

    CREATE INDEX IF NOT EXISTS idx_attention_items_user_state_order
      ON attention_items (user_id, state, updated_at DESC, item_id DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_items_user_daemon_state
      ON attention_items (user_id, daemon_id, state, updated_at DESC, item_id DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_items_snooze_due
      ON attention_items (snoozed_until, item_id) WHERE state = 'snoozed';
    CREATE INDEX IF NOT EXISTS idx_attention_items_submission_due
      ON attention_items (submission_deadline_at, item_id) WHERE state = 'submitting';
    CREATE INDEX IF NOT EXISTS idx_attention_items_expiry_due
      ON attention_items (expires_at, item_id)
      WHERE state IN ('open', 'snoozed', 'result_unknown');

    CREATE TABLE IF NOT EXISTS attention_recovery_items (
      recovery_id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      daemon_id VARCHAR(64) NOT NULL,
      registration_generation VARCHAR(64) NOT NULL,
      state VARCHAR(32) NOT NULL DEFAULT 'open',
      reason_code VARCHAR(32) NOT NULL DEFAULT 'daemon_offline',
      daemon_display_name TEXT NOT NULL DEFAULT '',
      last_seen_at TIMESTAMPTZ NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1,
      seen_at TIMESTAMPTZ,
      snoozed_until TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      handled_at TIMESTAMPTZ,
      resolution JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (state IN ('open', 'snoozed', 'resolved')),
      CHECK (reason_code = 'daemon_offline'),
      UNIQUE (user_id, daemon_id, registration_generation)
    );

    CREATE INDEX IF NOT EXISTS idx_attention_recovery_user_state_order
      ON attention_recovery_items (user_id, state, updated_at DESC, recovery_id DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_recovery_user_daemon_state
      ON attention_recovery_items (user_id, daemon_id, state, updated_at DESC, recovery_id DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_recovery_snooze_due
      ON attention_recovery_items (snoozed_until, recovery_id) WHERE state = 'snoozed';

    CREATE TABLE IF NOT EXISTS attention_action_receipts (
      receipt_id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id UUID NOT NULL REFERENCES attention_items(item_id) ON DELETE CASCADE,
      idempotency_key UUID NOT NULL,
      action_id VARCHAR(32) NOT NULL,
      request_hash TEXT NOT NULL,
      status VARCHAR(32) NOT NULL,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, item_id, idempotency_key),
      CHECK (status IN ('accepted', 'rejected', 'resolved_elsewhere', 'result_unknown'))
    );

    CREATE TABLE IF NOT EXISTS attention_projection_cursor (
      projector_name TEXT PRIMARY KEY,
      last_event_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO attention_projection_cursor (projector_name, last_event_id)
    SELECT 'attention-inbox-v1', COALESCE(MAX(id), 0) FROM events
    ON CONFLICT (projector_name) DO NOTHING;
  `)
}
