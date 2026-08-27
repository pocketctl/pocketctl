import type pg from 'pg'

/**
 * ADR-0003 extension platform schema. Every statement is idempotent so the
 * same DDL runs on fresh databases and in-place upgrades. The schema is
 * created in every RELAY_EXTENSIONS mode — flipping the flag must never
 * require a schema deployment window.
 *
 * `extension_source_outbox.owner_user_id` and `extension_feed.owner_user_id`
 * deliberately have NO foreign key: account deletion creates purge requests
 * that must survive the user row, and session/event retention must never
 * dangle. Account deletion cleans these rows explicitly in its own
 * transaction (Task 8). `extension_purge_requests` likewise carries no FK so
 * providers can still ack after the account is gone.
 */
export function initExtensionSchema(pool: Pick<pg.Pool, 'query'>): Promise<unknown> {
  return pool.query(`
    CREATE TABLE IF NOT EXISTS extension_providers (
      provider_id       TEXT PRIMARY KEY,
      manifest_version  INT NOT NULL CHECK (manifest_version > 0),
      manifest          JSONB NOT NULL,
      trust_level       TEXT NOT NULL DEFAULT 'first_party' CHECK (trust_level IN ('first_party')),
      status            TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS extension_installations (
      installation_id   UUID PRIMARY KEY,
      provider_id       TEXT NOT NULL REFERENCES extension_providers(provider_id),
      owner_user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_type        VARCHAR(16) NOT NULL DEFAULT 'user',
      status            TEXT NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'revoking', 'revoked')),
      granted_scopes    TEXT[] NOT NULL,
      subscriptions     TEXT[] NOT NULL,
      enabled_services  TEXT[] NOT NULL,
      event_filter      JSONB NOT NULL DEFAULT '{}',
      start_policy      TEXT NOT NULL CHECK (start_policy IN ('from_now', 'retained_history')),
      start_feed_id     BIGINT NOT NULL DEFAULT 0,
      config_version    BIGINT NOT NULL DEFAULT 1,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_installations_live_owner_provider
      ON extension_installations (owner_user_id, provider_id)
      WHERE status IN ('pending', 'active', 'paused', 'revoking');

    ALTER TABLE extension_installations
      DROP CONSTRAINT IF EXISTS extension_installations_owner_user_id_provider_id_key;

    CREATE TABLE IF NOT EXISTS extension_source_outbox (
      source_seq        BIGSERIAL PRIMARY KEY,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      owner_user_id     INT NOT NULL,
      session_id        VARCHAR(64),
      event_type        VARCHAR(64) NOT NULL,
      occurred_at       TIMESTAMPTZ,
      payload           JSONB NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_kind, source_id)
    );

    CREATE TABLE IF NOT EXISTS extension_feed (
      feed_id           BIGSERIAL PRIMARY KEY,
      owner_user_id     INT NOT NULL,
      topic             TEXT NOT NULL,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      session_id        VARCHAR(64),
      turn_id           TEXT,
      envelope_version  INT NOT NULL DEFAULT 1,
      occurred_at       TIMESTAMPTZ,
      payload           JSONB NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_kind, source_id, topic, envelope_version)
    );

    CREATE INDEX IF NOT EXISTS idx_extension_feed_owner_id_feed_id
      ON extension_feed (owner_user_id, feed_id);
    CREATE INDEX IF NOT EXISTS idx_extension_feed_owner_topic_feed_id
      ON extension_feed (owner_user_id, topic, feed_id);
    CREATE INDEX IF NOT EXISTS idx_extension_feed_session_id_feed_id
      ON extension_feed (session_id, feed_id);
    CREATE INDEX IF NOT EXISTS idx_extension_feed_created_at_feed_id
      ON extension_feed (created_at, feed_id);

    CREATE INDEX IF NOT EXISTS idx_extension_source_outbox_session_id
      ON extension_source_outbox (session_id);

    CREATE TABLE IF NOT EXISTS extension_checkpoints (
      installation_id   UUID PRIMARY KEY REFERENCES extension_installations(installation_id) ON DELETE CASCADE,
      ack_feed_id       BIGINT NOT NULL DEFAULT 0,
      lease_epoch       BIGINT NOT NULL DEFAULT 0,
      lease_token_hash  BYTEA,
      lease_expires_at  TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE extension_checkpoints ADD COLUMN IF NOT EXISTS snapshot_required_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS extension_provider_credentials (
      credential_id      UUID PRIMARY KEY,
      provider_id        TEXT NOT NULL REFERENCES extension_providers(provider_id),
      client_id          TEXT NOT NULL,
      secret_digest      TEXT NOT NULL,
      secret_fingerprint CHAR(16) NOT NULL,
      status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      expires_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at         TIMESTAMPTZ,
      UNIQUE (provider_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS extension_provider_status (
      installation_id    UUID PRIMARY KEY REFERENCES extension_installations(installation_id) ON DELETE CASCADE,
      provider_version   TEXT NOT NULL,
      state              TEXT NOT NULL CHECK (state IN ('ready', 'syncing', 'degraded', 'error')),
      last_feed_id       BIGINT,
      feed_lag_seconds   BIGINT,
      pending_jobs       BIGINT,
      failed_jobs_24h    BIGINT,
      last_extract_at    TIMESTAMPTZ,
      last_error_code    TEXT,
      reported_at        TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS extension_provider_usage_facts (
      installation_id    UUID NOT NULL REFERENCES extension_installations(installation_id) ON DELETE CASCADE,
      usage_id           TEXT NOT NULL,
      operation          TEXT NOT NULL,
      model              TEXT,
      input_tokens       BIGINT NOT NULL DEFAULT 0,
      output_tokens      BIGINT NOT NULL DEFAULT 0,
      embedding_tokens   BIGINT NOT NULL DEFAULT 0,
      cached_tokens      BIGINT NOT NULL DEFAULT 0,
      cost_micros        BIGINT NOT NULL DEFAULT 0,
      occurred_at        TIMESTAMPTZ NOT NULL,
      received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (installation_id, usage_id)
    );

    CREATE TABLE IF NOT EXISTS extension_purge_requests (
      request_id         UUID PRIMARY KEY,
      provider_id        TEXT NOT NULL,
      installation_id    UUID NOT NULL,
      reason             TEXT NOT NULL CHECK (reason IN ('uninstall', 'account_deleted', 'admin_revoke')),
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acked', 'expired')),
      requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acked_at           TIMESTAMPTZ,
      provider_receipt   TEXT,
      expires_at         TIMESTAMPTZ NOT NULL,
      UNIQUE (provider_id, installation_id, reason)
    );
  `)
}

/**
 * Startup gate for shadow/enabled: verify the tables and the load-bearing
 * columns/indexes exist before the projector or provider APIs go live.
 */
export async function assertExtensionSchema(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(`
    SELECT
      to_regclass('extension_providers') IS NOT NULL
      AND to_regclass('extension_installations') IS NOT NULL
      AND to_regclass('extension_source_outbox') IS NOT NULL
      AND to_regclass('extension_feed') IS NOT NULL
      AND to_regclass('extension_checkpoints') IS NOT NULL
      AND to_regclass('extension_provider_credentials') IS NOT NULL
      AND to_regclass('extension_provider_status') IS NOT NULL
      AND to_regclass('extension_provider_usage_facts') IS NOT NULL
      AND to_regclass('extension_purge_requests') IS NOT NULL
      AND to_regclass('idx_extension_installations_live_owner_provider') IS NOT NULL
      AND to_regclass('idx_extension_feed_owner_id_feed_id') IS NOT NULL
      AND to_regclass('idx_extension_feed_owner_topic_feed_id') IS NOT NULL
      AND to_regclass('idx_extension_feed_session_id_feed_id') IS NOT NULL
      AND to_regclass('idx_extension_feed_created_at_feed_id') IS NOT NULL
      AND to_regclass('idx_extension_source_outbox_session_id') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'extension_installations'
          AND column_name = 'start_feed_id'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'extension_checkpoints'
          AND column_name = 'lease_token_hash'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'extension_checkpoints'
          AND column_name = 'snapshot_required_at'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'extension_installations'
          AND column_name = 'start_feed_id'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'extension_feed'
          AND column_name = 'envelope_version'
      ) AS ready
  `)
  if (result.rows[0]?.ready !== true) throw new Error('extension schema not ready')
}
