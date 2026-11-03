import type pg from 'pg'

export async function initMessageQueueSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS session_message_queues (
    session_id VARCHAR(64) PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE ON UPDATE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS message_queue_owner ON session_message_queues(user_id);`)
}
