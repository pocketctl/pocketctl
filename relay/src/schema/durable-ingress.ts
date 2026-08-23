import type pg from 'pg'

export async function initDurableIngressSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_inbox (
      inbox_id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      daemon_id VARCHAR(64) NOT NULL,
      daemon_generation BIGINT NOT NULL,
      seq BIGINT NOT NULL,
      dedup_key TEXT NOT NULL,
      session_id VARCHAR(128),
      event_type VARCHAR(64) NOT NULL,
      priority_class SMALLINT NOT NULL CHECK (priority_class BETWEEN 0 AND 3),
      schema_version INT NOT NULL DEFAULT 1,
      occurred_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL,
      materialization_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      status SMALLINT NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
      attempts INT NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      completed_at TIMESTAMPTZ,
      materialized_event_id BIGINT REFERENCES events(id),
      last_error TEXT
    );

    ALTER TABLE event_inbox
    ADD COLUMN IF NOT EXISTS materialization_context JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_inbox_dedup
    ON event_inbox ((COALESCE(user_id, 0)), dedup_key);

    CREATE INDEX IF NOT EXISTS idx_event_inbox_pending_claim
    ON event_inbox (priority_class, available_at, inbox_id)
    WHERE status = 0;

    CREATE INDEX IF NOT EXISTS idx_event_inbox_stream_unresolved
    ON event_inbox (daemon_id, daemon_generation, seq, inbox_id)
    WHERE status IN (0, 1);

    CREATE INDEX IF NOT EXISTS idx_event_inbox_completed_cleanup
    ON event_inbox (completed_at, inbox_id)
    WHERE status = 2;

    CREATE TABLE IF NOT EXISTS event_inbox_receipt (
      receipt_id BIGSERIAL PRIMARY KEY,
      inbox_id BIGINT REFERENCES event_inbox(inbox_id) ON DELETE CASCADE,
      daemon_id VARCHAR(64) NOT NULL,
      daemon_generation BIGINT NOT NULL,
      seq BIGINT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (daemon_id, daemon_generation, seq)
    );

    ALTER TABLE event_inbox_receipt
    ALTER COLUMN inbox_id DROP NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_event_inbox_receipt_daemon_seq
    ON event_inbox_receipt (daemon_id, daemon_generation, seq);

    CREATE TABLE IF NOT EXISTS daemon_ack_checkpoint (
      daemon_id VARCHAR(64) NOT NULL,
      daemon_generation BIGINT NOT NULL,
      ack_seq BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (daemon_id, daemon_generation)
    );

    CREATE TABLE IF NOT EXISTS realtime_outbox (
      outbox_id BIGSERIAL PRIMARY KEY,
      inbox_id BIGINT NOT NULL REFERENCES event_inbox(inbox_id) ON DELETE CASCADE,
      delivery_key TEXT NOT NULL,
      event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(128),
      event_type VARCHAR(64) NOT NULL,
      audience VARCHAR(16) NOT NULL,
      request_id TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      UNIQUE (inbox_id, delivery_key)
    );

    ALTER TABLE realtime_outbox
    ALTER COLUMN event_id DROP NOT NULL;

    ALTER TABLE realtime_outbox
    ALTER COLUMN audience TYPE VARCHAR(32);

    CREATE INDEX IF NOT EXISTS idx_realtime_outbox_undelivered
    ON realtime_outbox (created_at, outbox_id)
    WHERE delivered_at IS NULL;
  `)
}
