/** Per database consumer identity survives installation deletion and worker
 * restarts. Receipts detect altered redeliveries before any Relay ACK. */
export const DELIVERY_WITHDRAWAL_STREAM_MIGRATION = { version: 69, statements: [
  `CREATE TABLE memory_delivery_withdrawal_checkpoint (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    consumer_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    last_sequence BIGINT NOT NULL DEFAULT 0,last_ack_sequence BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`,
  `INSERT INTO memory_delivery_withdrawal_checkpoint(singleton) VALUES(TRUE)`,
  `CREATE TABLE memory_delivery_withdrawal_receipts (
    sequence BIGINT PRIMARY KEY,payload_hash BYTEA NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`,
] } as const
