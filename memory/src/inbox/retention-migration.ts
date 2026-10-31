/** No historical ACK is inferred from receipt/projection timestamps. The
 * first successful post-upgrade Relay ACK establishes the durable watermark. */
export const INBOX_RETENTION_MIGRATION = {
  version: 70,
  statements: [
    `CREATE TABLE memory_inbox_checkpoints (
      installation_id UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      last_ack_feed_id BIGINT NOT NULL DEFAULT 0 CHECK(last_ack_feed_id >= 0),
      gc_feed_id BIGINT NOT NULL DEFAULT 0 CHECK(gc_feed_id >= 0 AND gc_feed_id <= last_ack_feed_id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE memory_feed_inbox ADD COLUMN body_reclaimed_at TIMESTAMPTZ`,
    `ALTER TABLE memory_feed_inbox ADD CONSTRAINT memory_inbox_reclaimed_body_empty
      CHECK(body_reclaimed_at IS NULL OR (data = '{}'::jsonb AND classification = '{}'::jsonb))`,
    `CREATE INDEX idx_memory_inbox_body_retention
      ON memory_feed_inbox(installation_id, projected_at, feed_id)
      WHERE projection_state='projected' AND body_reclaimed_at IS NULL`,
  ],
} as const
