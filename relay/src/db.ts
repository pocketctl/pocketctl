import pg from 'pg';
import { createHash } from 'crypto';
import type { SupportedLanguage } from './config/language.js';
import { initDurableIngressSchema } from './schema/durable-ingress.js';
import { countReplayLogicalItems, findCompleteReplayBoundary, hasOpenReplayStreams } from './replay-page.js';
const { Pool } = pg;

export interface DBConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeoutMillis?: number;
}

export interface PoolOptions {
  name?: string;
  max?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

export function createPool(config: DBConfig, options: PoolOptions = {}): pg.Pool {
  const requested = options.connectionTimeoutMillis ?? config.connectionTimeoutMillis
    ?? Number.parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10);
  const connectionTimeoutMillis = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(60_000, Math.trunc(requested)))
    : 5_000;
  return new Pool({
    ...config,
    connectionTimeoutMillis,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.name === undefined ? {} : { application_name: `pocketctl-relay-${options.name}` }),
    ...(options.statementTimeoutMillis === undefined ? {} : { statement_timeout: options.statementTimeoutMillis }),
  });
}

export async function initDB(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daemons (
      id SERIAL PRIMARY KEY,
      daemon_id VARCHAR(64) UNIQUE NOT NULL,
      hostname VARCHAR(255),
      agents JSONB DEFAULT '[]',
      status VARCHAR(32) DEFAULT 'offline',
      last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) UNIQUE NOT NULL,
      daemon_id VARCHAR(64) REFERENCES daemons(daemon_id),
      agent_type VARCHAR(64),
      cwd TEXT,
      title TEXT,
      source VARCHAR(16) DEFAULT 'daemon',
      status VARCHAR(32) DEFAULT 'running',
      control_mode VARCHAR(32),
      capabilities JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_daemon ON sessions(daemon_id);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
  `);
  // Migration: add event_hash for deduplication
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS event_hash VARCHAR(32)`);
  // Durable post-insert effect ledger. The marker lives on the event row so
  // event insertion and `pending` creation are one atomic SQL statement.
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS effect_status VARCHAR(16) NOT NULL DEFAULT 'none'`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS effect_step INT NOT NULL DEFAULT 0`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(session_id, event_hash)`);
  // Migration: add title and source columns to existing sessions table
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'daemon'`);
  // OpenCode's runtime agent (build/plan/...) is independent from agent_type.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_agent VARCHAR(128)`);
  // Managed OpenCode control is an explicit daemon claim. Keep control_mode
  // nullable so historical rows remain safely distinguishable from managed.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS control_mode VARCHAR(32)`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS capabilities JSONB`);
  // Migration: add last_activity_at and exit_reason columns
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(32)`);
  // Migration: add subagent_count column
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS subagent_count INT DEFAULT 0`);

  // Subagent relation: parent linkage on sessions + dedicated subagents table.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id VARCHAR(64)`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_subagent BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS root_session_id VARCHAR(64)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subagents (
      parent_session_id VARCHAR(64) NOT NULL,
      agent_id VARCHAR(64) NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'claude_subagent',
      tool_use_id VARCHAR(64),
      agent_type VARCHAR(40),
      title VARCHAR(120),
      status VARCHAR(20) DEFAULT 'running',
      token_in BIGINT DEFAULT 0,
      token_out BIGINT DEFAULT 0,
      token_cache BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (parent_session_id, agent_id)
    )
  `);

  // P1a: subagents 补 cache_create 列（与 sessions.tok_cache_create 对齐，修复 cache_create 丢失）
  await pool.query(`ALTER TABLE subagents ADD COLUMN IF NOT EXISTS token_cache_create BIGINT DEFAULT 0`);
  // subagent_usage 幂等去重表。早期版本用 (daemon_id, seq) 主键去重，但 seq 是 daemon 进程内的
  // 自增计数器，incarnation 切换后 reset 从 0 开始，旧代码在 router 里整表 DELETE 这张表来避让，
  // 反而让从 offset 0 重放的累计 usage 全部重新累加 → subagents.token_* 滚到 10^16。
  // 现改为内容指纹 (daemon_id, usage_hash) 去重，与 events.event_hash 同构：同一份 per-turn usage
  // 无论被重放多少遍（relay 重启 / daemon incarnation 切换 / tailer 从 offset 0 重读 child JSONL）
  // 都只计入一次。usage_hash = md5(parent_session_id:agent_id:in:out:cache_read:cache_create) 前 16 位。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subagent_usage_seen (
      daemon_id   TEXT NOT NULL,
      usage_hash  CHAR(16) NOT NULL,
      seq         BIGINT,
      agent_id    TEXT,
      seen_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (daemon_id, usage_hash)
    )
  `);
  // 在线表迁移：为旧表补列，并把 PK 从 (daemon_id, seq) 换成 (daemon_id, usage_hash)。
  // 注意顺序：必须先 DROP 旧 PK(含 seq)，再 ALTER seq DROP NOT NULL（PG13 不允许
  // 对主键列 DROP NOT NULL，42P16 错误）。
  await pool.query(`ALTER TABLE subagent_usage_seen ADD COLUMN IF NOT EXISTS usage_hash CHAR(16)`);
  await pool.query(`ALTER TABLE subagent_usage_seen ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subagent_usage_seen_pkey'
          AND conrelid = 'subagent_usage_seen'::regclass
          AND pg_get_constraintdef(oid) LIKE '%daemon_id, seq%'
      ) THEN
        ALTER TABLE subagent_usage_seen DROP CONSTRAINT subagent_usage_seen_pkey;
        ALTER TABLE subagent_usage_seen ADD PRIMARY KEY (daemon_id, usage_hash);
        ALTER TABLE subagent_usage_seen ALTER COLUMN seq DROP NOT NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'subagent_usage_seen PK migrate skipped: %', SQLERRM;
    END $$`);

  // Phase 2: users table for authentication
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Durable request-level push-effect grant. Agent event identity remains
  // event_id-based, while approval/question notifications retain the legacy
  // request_id dedup contract across Worker restarts. The winning event FK
  // bounds this table to the existing event retention/deletion lifecycle.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_push_effect (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, request_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_outbox (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email_type VARCHAR(32) NOT NULL CONSTRAINT email_outbox_email_type_check CHECK (email_type = 'welcome'),
      recipient_email VARCHAR(255) NOT NULL,
      locale VARCHAR(2) NOT NULL CHECK (locale IN ('zh', 'en')),
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent')),
      attempt_count INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      message_id VARCHAR(255),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, email_type)
    );
    CREATE INDEX IF NOT EXISTS idx_email_outbox_due
      ON email_outbox (status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_email_outbox_processing_locked
      ON email_outbox (locked_at) WHERE status = 'processing';
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'email_outbox_email_type_check'
          AND conrelid = 'email_outbox'::regclass
      ) THEN
        ALTER TABLE email_outbox
          ADD CONSTRAINT email_outbox_email_type_check CHECK (email_type = 'welcome');
      END IF;
    END $$
  `);
  // Phase 2: add user_id to sessions and daemons
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INT`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS user_id INT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);

  // Short-lived, transactionally allocated quota slots. These close the race
  // where two clients on different hosts create or revive a session at once.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quota_reservations (
      id UUID PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource VARCHAR(32) NOT NULL,
      operation VARCHAR(16) NOT NULL,
      daemon_id VARCHAR(64),
      session_id VARCHAR(64),
      request_id VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, request_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_quota_reservations_active
    ON quota_reservations (user_id, resource, expires_at)
  `);

  // Phase 3: devices table for push notifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_token VARCHAR(512) NOT NULL,
      platform VARCHAR(16) DEFAULT 'ios',
      device_name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, device_token)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)`);

  // Phase 3: add phone column to users for SMS auth
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`);

  // Daemon alias column
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS alias VARCHAR(64)`);

  // User plan and whitelist for daemon limit control
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(16) DEFAULT 'free'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whitelist BOOLEAN DEFAULT false`);

  // Session pin (pinned to top)
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(user_id, pinned) WHERE pinned = true`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_daemon_user_keyset
    ON sessions (
      user_id,
      daemon_id,
      (COALESCE(is_subagent, false)),
      (CASE WHEN pinned THEN 1 ELSE 0 END) DESC,
      (COALESCE(pinned_at, '1970-01-01T00:00:00Z'::timestamptz)) DESC,
      (COALESCE(last_activity_at, updated_at)) DESC,
      session_id DESC
    )
    WHERE session_id NOT LIKE 'pending-%'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_subagents_parent_created
    ON subagents(parent_session_id, created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_session_agent_id_desc
    ON events (session_id, ((payload->>'agent_id')), id DESC)
    WHERE payload ? 'agent_id'
  `);

  // C2: Token cost tracking — per-session cumulative cost (USD) from result events
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION DEFAULT 0`);

  // Token usage tracking (model-agnostic raw token counts; replaces the USD cost estimate
  // which was inaccurate across different models). Stores per-session cumulative totals
  // broken down by token type so the UI can show total + composition breakdown.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_tokens BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tok_input BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tok_output BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tok_cache_read BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tok_cache_create BIGINT DEFAULT 0`);

  // sessions.model — resolved model for the session (from session_created). Drives
  // model-dimension aggregation (donut / top-model) on the token dashboard.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model VARCHAR(64)`);

  // token_daily_stats — immutable per-day/per-model rollup. Powers the token
  // dashboard's time-series/model/host aggregates without scanning events, and
  // survives session deletion (deleteSession compensates into this table first).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_daily_stats (
      user_id INT NOT NULL,
      daemon_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      model VARCHAR(64) NOT NULL,
      input BIGINT NOT NULL DEFAULT 0,
      output BIGINT NOT NULL DEFAULT 0,
      cache_read BIGINT NOT NULL DEFAULT 0,
      cache_create BIGINT NOT NULL DEFAULT 0,
      requests INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, daemon_id, date, model)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_daily_stats_user_date ON token_daily_stats(user_id, date)`);

  // Report push dedup: tracks which daily/weekly report has been pushed to each
  // user, so the hourly report job is idempotent across relay restarts. The
  // PRIMARY KEY (user_id, report_type, period_key) makes the insert-and-push
  // pattern atomic: ON CONFLICT DO NOTHING returns rowCount 0 → already sent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_sent (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_type VARCHAR(8) NOT NULL,
      period_key CHAR(8) NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, report_type, period_key)
    )
  `);

  // Session delete tombstone table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_sessions (
      session_id VARCHAR(64) PRIMARY KEY,
      deleted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // iOS waitlist table for landing page signups
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ios_waitlist (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ios_waitlist_email ON ios_waitlist(email)`);

  // OAuth Device Flow: token revocation table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti VARCHAR(64) PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id),
      revoked_at TIMESTAMPTZ DEFAULT NOW(),
      reason VARCHAR(32) NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id)`);

  // OAuth Device Flow: audit log table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      action VARCHAR(32) NOT NULL,
      details JSONB DEFAULT '{}',
      ip VARCHAR(45),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`);

  // Daemon enhancements: token binding and machine tracking
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS active_token_jti VARCHAR(64)`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS machine_id VARCHAR(64)`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS arch VARCHAR(32)`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS version VARCHAR(32)`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS started_at BIGINT`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS registration_id VARCHAR(64)`);

  // User daemon limit control
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS max_daemons INT DEFAULT 1`);

  await initDurableIngressSchema(pool);
}

export async function upsertDaemon(pool: pg.Pool, daemonId: string, hostname: string, agents: any[], arch?: string, version?: string, startedAt?: number): Promise<void> {
  await pool.query(
    `INSERT INTO daemons (daemon_id, hostname, agents, status, last_heartbeat, arch, version, started_at)
     VALUES ($1, $2, $3, 'online', NOW(), $4, $5, $6)
     ON CONFLICT (daemon_id) DO UPDATE SET
       hostname = $2, agents = $3, status = 'online', last_heartbeat = NOW(),
       arch = COALESCE($4, daemons.arch), version = COALESCE($5, daemons.version), started_at = COALESCE($6, daemons.started_at)`,
    [daemonId, hostname, JSON.stringify(agents), arch || null, version || null, startedAt || null]
  );
}

export interface DaemonRegistrationActivation {
  daemonId: string;
  userId: number | null;
  hostname: string;
  agents: any[];
  arch?: string;
  version?: string;
  startedAt?: number;
  tokenJti?: string;
  machineId?: string;
  registrationId: string;
}

export interface DaemonRegistrationSnapshot {
  hostname: string | null;
  agents: any;
  status: string | null;
  last_heartbeat: Date | string | null;
  arch: string | null;
  version: string | null;
  started_at: number | null;
  active_token_jti: string | null;
  machine_id: string | null;
  last_login_at: Date | string | null;
  registration_id: string | null;
}

export type DaemonRegistrationRestoreResult =
  | { status: 'confirmed_restored' }
  | { status: 'stale_successor' }
  | { status: 'sql_failure'; error: unknown };

/** Activation lost the shared token-revocation fence to a committed revoke. */
export class TokenRevokedDuringActivationError extends Error {
  constructor() {
    super('token revoked during daemon activation');
    this.name = 'TokenRevokedDuringActivationError';
  }
}

// PostgreSQL evaluates hashtext on the database server, so every relay uses the
// same key. Hash collisions only add harmless serialization; they cannot admit
// a revoked token. The namespace keeps these locks separate from other users of
// two-key advisory locks in the application.
const TOKEN_REVOCATION_LOCK_NAMESPACE = 1885566060;
const SESSION_MATERIALIZATION_LOCK_NAMESPACE = 1885566061;

async function lockTokenRevocationFence(client: pg.PoolClient, jti: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock($1, hashtext($2))`,
    [TOKEN_REVOCATION_LOCK_NAMESPACE, jti],
  );
}

async function lockSessionMaterializationFence(
  client: Pick<pg.PoolClient, 'query'>,
  sessionId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock($1, hashtext($2))`,
    [SESSION_MATERIALIZATION_LOCK_NAMESPACE, sessionId],
  );
}

/** Serialize durable materialization with explicit deletion for one session. */
export async function withSessionMaterializationFence<T>(
  pool: pg.Pool,
  sessionId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  // Lightweight unit fakes intentionally expose query only.
  if (typeof pool.connect !== 'function') return work(pool as unknown as pg.PoolClient)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockSessionMaterializationFence(client, sessionId)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Commit all mutable connection identity in one generation transaction. */
export async function activateDaemonRegistration(
  pool: pg.Pool,
  input: DaemonRegistrationActivation,
): Promise<DaemonRegistrationSnapshot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // This is the authoritative revocation check. It shares a transaction lock
    // with every revokeToken write, closing the cross-relay SELECT/activation
    // window. It must precede every daemon read or mutation in this transaction.
    if (input.tokenJti) {
      await lockTokenRevocationFence(client, input.tokenJti);
      const revoked = await client.query(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [input.tokenJti]);
      if ((revoked.rowCount ?? 0) > 0) throw new TokenRevokedDuringActivationError();
    }
    const previous = await client.query(
      `SELECT hostname, agents, status, last_heartbeat, arch, version, started_at,
              active_token_jti, machine_id, last_login_at, registration_id
       FROM daemons WHERE daemon_id = $1 FOR UPDATE`,
      [input.daemonId],
    );
    const activated = await client.query(
      `INSERT INTO daemons
         (daemon_id, user_id, hostname, agents, status, last_heartbeat, arch, version, started_at,
          active_token_jti, machine_id, last_login_at, registration_id)
       VALUES ($1, $2, $3, $4, 'online', NOW(), $5, $6, $7, $8::varchar, $9,
               CASE WHEN $8::varchar IS NULL THEN NULL ELSE NOW() END, $10)
       ON CONFLICT (daemon_id) DO UPDATE SET
         user_id = COALESCE(daemons.user_id, EXCLUDED.user_id),
         hostname = EXCLUDED.hostname, agents = EXCLUDED.agents, status = 'online', last_heartbeat = NOW(),
         arch = COALESCE(EXCLUDED.arch, daemons.arch), version = COALESCE(EXCLUDED.version, daemons.version),
         started_at = EXCLUDED.started_at,
         active_token_jti = COALESCE(EXCLUDED.active_token_jti, daemons.active_token_jti),
         machine_id = COALESCE(EXCLUDED.machine_id, daemons.machine_id),
         last_login_at = CASE WHEN EXCLUDED.active_token_jti IS NULL THEN daemons.last_login_at ELSE NOW() END,
         registration_id = EXCLUDED.registration_id
       WHERE EXCLUDED.user_id IS NULL OR daemons.user_id IS NULL OR daemons.user_id = EXCLUDED.user_id
       RETURNING daemon_id`,
      [input.daemonId, input.userId, input.hostname, JSON.stringify(input.agents), input.arch || null,
       input.version || null, input.startedAt ?? null, input.tokenJti || null, input.machineId || null, input.registrationId],
    );
    if (!activated.rows[0] && activated.rowCount === 0) throw new Error(`daemon owner changed during activation: ${input.daemonId}`);
    await client.query('COMMIT');
    return previous.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Restore a failed activation only while its exact generation is still current. */
export async function restoreDaemonRegistration(
  pool: pg.Pool,
  daemonId: string,
  registrationId: string,
  snapshot: DaemonRegistrationSnapshot | null,
): Promise<DaemonRegistrationRestoreResult> {
  try {
    const result = !snapshot
      ? await pool.query(`DELETE FROM daemons WHERE daemon_id = $1 AND registration_id = $2`, [daemonId, registrationId])
      : await pool.query(
        `UPDATE daemons SET
           hostname = $3, agents = $4, status = $5, last_heartbeat = $6, arch = $7, version = $8,
           started_at = $9, active_token_jti = $10, machine_id = $11, last_login_at = $12, registration_id = $13
         WHERE daemon_id = $1 AND registration_id = $2`,
        [daemonId, registrationId, snapshot.hostname, snapshot.agents, snapshot.status, snapshot.last_heartbeat,
         snapshot.arch, snapshot.version, snapshot.started_at, snapshot.active_token_jti, snapshot.machine_id,
         snapshot.last_login_at, snapshot.registration_id],
      );
    return (result.rowCount ?? 0) > 0
      ? { status: 'confirmed_restored' }
      : { status: 'stale_successor' };
  } catch (error) {
    return { status: 'sql_failure', error };
  }
}

export async function setDaemonOffline(pool: pg.Pool, daemonId: string, registrationId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE daemons SET status = 'offline' WHERE daemon_id = $1 AND registration_id = $2`,
    [daemonId, registrationId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Generation-bound offline CAS with a PostgreSQL-enforced deadline.
 * statement_timeout cancels the query on the server, allowing the transaction
 * to roll back and the checked-out client to be released instead of merely
 * abandoning a still-running query in application code.
 */
export async function setDaemonOfflineWithTimeout(
  pool: pg.Pool,
  daemonId: string,
  registrationId: string,
  timeoutMs: number,
): Promise<boolean> {
  const safeTimeoutMs = Math.max(1, Math.min(2_147_483_647, Math.trunc(timeoutMs) || 1));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(safeTimeoutMs)]);
    const result = await client.query(
      `UPDATE daemons SET status = 'offline' WHERE daemon_id = $1 AND registration_id = $2`,
      [daemonId, registrationId],
    );
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setDaemonReconnecting(pool: pg.Pool, daemonId: string): Promise<void> {
  await pool.query(`UPDATE daemons SET status = 'reconnecting' WHERE daemon_id = $1`, [daemonId]);
}

/** Delete a daemon (unregister from account). Sessions are preserved with daemon_id nulled. */
export async function deleteDaemon(pool: pg.Pool, userId: number, daemonId: string): Promise<boolean> {
  const check = await pool.query(`SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2`, [daemonId, userId]);
  if ((check.rowCount ?? 0) === 0) return false;
  await pool.query(`UPDATE sessions SET daemon_id = NULL WHERE daemon_id = $1`, [daemonId]);
  await pool.query(`DELETE FROM daemons WHERE daemon_id = $1`, [daemonId]);
  return true;
}

export async function upsertDaemonAlias(pool: pg.Pool, userId: number, daemonId: string, alias: string | null): Promise<string | null> {
  // Verify daemon belongs to user
  const check = await pool.query(`SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2`, [daemonId, userId]);
  if ((check.rowCount ?? 0) === 0) return undefined as any; // not found or not owned
  const normalizedAlias = alias && alias.trim() ? alias.trim().slice(0, 64) : null;
  await pool.query(`UPDATE daemons SET alias = $1 WHERE daemon_id = $2`, [normalizedAlias, daemonId]);
  return normalizedAlias;
}

export async function getDaemonAlias(pool: pg.Pool, daemonId: string): Promise<string | null> {
  const result = await pool.query(`SELECT alias FROM daemons WHERE daemon_id = $1`, [daemonId]);
  return result.rows[0]?.alias ?? null;
}

// getDaemonOwner returns the persisted owner (daemons.user_id) of a daemon, or
// null if the daemon isn't bound to any user. Used by registerDaemon to recover
// the owner when a reconnecting daemon's token doesn't carry a userId.
export async function getDaemonOwner(pool: pg.Pool, daemonId: string): Promise<number | null> {
  const result = await pool.query(`SELECT user_id FROM daemons WHERE daemon_id = $1`, [daemonId]);
  return result.rows[0]?.user_id ?? null;
}

export async function updateHeartbeat(pool: pg.Pool, daemonId: string): Promise<void> {
  await pool.query(`UPDATE daemons SET last_heartbeat = NOW() WHERE daemon_id = $1`, [daemonId]);
}

function eventHashInput(sessionId: string, eventType: string, payload: any): string {
  const stableEventId = typeof payload?.event_id === 'string' ? payload.event_id : '';
  if (stableEventId) return `${sessionId}:${eventType}:event:${stableEventId}`;
  const stableRequestId = typeof payload?.request_id === 'string' ? payload.request_id : '';
  if (stableRequestId) return `${sessionId}:${eventType}:request:${stableRequestId}`;
  // Only discard transport seq when a stable business identity exists. Events
  // such as user_text may legitimately repeat with identical content, so their
  // seq remains part of the fallback fingerprint.
  return `${sessionId}:${eventType}:${JSON.stringify(payload)}`;
}

export async function insertEvent(pool: pg.Pool, sessionId: string, eventType: string, payload: any): Promise<number> {
  const payloadStr = JSON.stringify(payload);
  const hashInput = eventHashInput(sessionId, eventType, payload);
  const hash = createHash('md5').update(hashInput).digest('hex').slice(0, 16);
  const result = await pool.query(
    `INSERT INTO events (session_id, event_type, payload, event_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, event_hash) DO NOTHING
     RETURNING id`,
    [sessionId, eventType, payloadStr, hash]
  );
  if (result.rows.length > 0) {
    pool.query(`UPDATE sessions SET last_activity_at = NOW(), updated_at = NOW() WHERE session_id = $1`, [sessionId]).catch(console.error);
    return result.rows[0].id;
  }
  return 0; // deduplicated
}

/**
 * Persist a daemon event with bounded retries. The relay forwards events to
 * clients immediately, but the DB write was previously fire-and-forget
 * (`insertEvent(...).catch(console.error)`) — a transient DB blip (e.g. a
 * Postgres restart during deploy) silently dropped the row, so the event
 * vanished on the next replay. Retrying across short backoffs rides out those
 * blips. Resolves with the inserted row id (0 if deduped) on durable success;
 * REJECTS after exhausting all attempts, so callers that gate a delivery ack on
 * persistence can withhold the ack and let the daemon replay the event later.
 */
export async function persistEvent(pool: pg.Pool, sessionId: string, eventType: string, payload: any, attempts = 5): Promise<number> {
  let delay = 100;
  for (let i = 0; i < attempts; i++) {
    try {
      return await insertEvent(pool, sessionId, eventType, payload);
    } catch (e) {
      if (i === attempts - 1) throw e; // exhausted → reject (caller withholds ack)
      await new Promise((r) => setTimeout(r, delay));
      delay *= 3; // 100 → 300 → 900 → 2700ms (~4s total budget)
    }
  }
  /* unreachable */ return 0;
}

export interface PersistedEventEffect {
  rowID: number;
  inserted: boolean;
  completed: boolean;
  nextStep: number;
}

/**
 * Persist an event together with a durable pending-effect marker. Conflict
 * replay returns the existing marker, allowing an unfinished effect to resume
 * while a completed event remains a pure dedup/ack.
 */
export async function persistEventWithEffect(
  pool: pg.Pool,
  sessionId: string,
  eventType: string,
  payload: any,
  attempts = 5,
): Promise<PersistedEventEffect> {
  const payloadStr = JSON.stringify(payload);
  const hashInput = eventHashInput(sessionId, eventType, payload);
  const hash = createHash('md5').update(hashInput).digest('hex').slice(0, 16);
  let delay = 100;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await pool.query(
        `INSERT INTO events (session_id, event_type, payload, event_hash, effect_status, effect_step)
         VALUES ($1, $2, $3, $4, 'pending', 0)
         ON CONFLICT (session_id, event_hash) DO UPDATE SET event_hash = EXCLUDED.event_hash
         RETURNING id, (xmax = 0) AS inserted, effect_status, effect_step`,
        [sessionId, eventType, payloadStr, hash],
      );
      const row = result.rows[0];
      if (!row) throw new Error('event ledger row unavailable');
      const inserted = row.inserted === undefined || row.inserted === true || row.inserted === 't';
      if (inserted) {
        pool.query(`UPDATE sessions SET last_activity_at = NOW(), updated_at = NOW() WHERE session_id = $1`, [sessionId]).catch(console.error);
      }
      return {
        rowID: Number(row.id),
        inserted,
        // `none` marks rows created before/without durable effects and must not
        // replay historical side effects after this migration.
        completed: row.effect_status === 'completed' || row.effect_status === 'none',
        nextStep: Number(row.effect_step) || 0,
      };
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 3;
    }
  }
  throw new Error('unreachable');
}

export async function advanceEventEffectStep(pool: pg.Pool, eventID: number, nextStep: number): Promise<void> {
  await pool.query(
    `UPDATE events SET effect_step = GREATEST(effect_step, $2) WHERE id = $1 AND effect_status = 'pending'`,
    [eventID, nextStep],
  );
}

export async function completeEventEffect(pool: pg.Pool, eventID: number): Promise<void> {
  await pool.query(`UPDATE events SET effect_status = 'completed' WHERE id = $1`, [eventID]);
}

/**
 * Atomically grant one approval/question push effect per durable owner/request.
 * Callers hold the materialization transaction: a failed external push rolls
 * this insert back, so a fresh Worker can retry rather than being suppressed.
 */
export async function claimRequestPushEffect(
  pool: pg.Pool,
  userId: number,
  requestId: string,
  eventId: number,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO request_push_effect (user_id, request_id, event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, request_id) DO NOTHING
     RETURNING event_id`,
    [userId, requestId, eventId],
  )
  return (result.rowCount ?? 0) === 1
}

export async function getEventEffectState(
  pool: pg.Pool,
  eventID: number,
): Promise<{ completed: boolean; nextStep: number } | null> {
  const result = await pool.query(
    `SELECT effect_status, effect_step FROM events WHERE id = $1`,
    [eventID],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    completed: row.effect_status === 'completed' || row.effect_status === 'none',
    nextStep: Number(row.effect_step) || 0,
  };
}

/** Atomically checkpoint and apply the only non-idempotent generic DB effect. */
export async function incrementSessionTokensForEvent(
  pool: pg.Pool,
  eventID: number,
  nextStep: number,
  sessionId: string,
  u: TokenUsageDelta,
): Promise<void> {
  const inp = Math.max(0, u.input_tokens || 0);
  const out = Math.max(0, u.output_tokens || 0);
  const cr = Math.max(0, u.cache_read_tokens || 0);
  const cc = Math.max(0, u.cache_create_tokens || 0);
  const total = inp + out + cr + cc;
  const result = await pool.query(
    `WITH session_target AS (
       SELECT session_id FROM sessions WHERE session_id = $8 FOR UPDATE
     ), checkpoint AS (
       UPDATE events SET effect_step = $2
       WHERE id = $1 AND effect_status = 'pending' AND effect_step < $2
         AND EXISTS (SELECT 1 FROM session_target)
       RETURNING 1
     ), session_update AS (
       UPDATE sessions SET
       total_tokens = COALESCE(total_tokens, 0) + $3,
       tok_input = COALESCE(tok_input, 0) + $4,
       tok_output = COALESCE(tok_output, 0) + $5,
       tok_cache_read = COALESCE(tok_cache_read, 0) + $6,
       tok_cache_create = COALESCE(tok_cache_create, 0) + $7,
       updated_at = NOW()
       WHERE session_id = $8 AND EXISTS (SELECT 1 FROM checkpoint)
       RETURNING 1
     )
     SELECT
       EXISTS (SELECT 1 FROM session_target) AS session_exists,
       EXISTS (SELECT 1 FROM checkpoint) AS claimed,
       EXISTS (SELECT 1 FROM session_update) AS applied`,
    [eventID, nextStep, total, inp, out, cr, cc, sessionId],
  );
  const outcome = result.rows[0];
  if (!outcome?.session_exists) throw new Error(`session missing for token effect: ${sessionId}`);
  if (outcome.claimed && !outcome.applied) throw new Error(`token effect checkpoint was not applied: ${sessionId}`);
}

export async function getEventsAfter(pool: pg.Pool, sessionId: string, lastSeq: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at FROM events WHERE session_id = $1 AND id > $2 ORDER BY id ASC`,
    [sessionId, lastSeq]
  );
  return result.rows;
}

// session-history-pagination: backward queries (recent N / cursor-before N).
// Returns rows in id DESC order (newest first); client reverses for rendering.
export async function getRecentEvents(pool: pg.Pool, sessionId: string, limit: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at FROM events WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows;
}

export async function getEventsBefore(pool: pg.Pool, sessionId: string, cursor: number, limit: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at FROM events WHERE session_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
    [sessionId, cursor, limit]
  );
  return result.rows;
}

export async function getLatestAgentPlan(pool: pg.Pool, sessionId: string): Promise<any | undefined> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at
     FROM events
     WHERE session_id = $1 AND event_type = 'agent_plan'
     ORDER BY
       CASE
         WHEN jsonb_typeof(payload->'revision') = 'number'
          AND (payload->>'revision') ~ '^[1-9][0-9]*$'
         THEN (payload->>'revision')::numeric
         ELSE NULL
       END DESC NULLS LAST,
       id DESC
     LIMIT 1`,
    [sessionId],
  );
  return result.rows[0];
}

export interface CompleteBackwardReplayPage {
  events: any[];
  oldestId: number;
  logicalCount: number;
  hasMore: boolean;
}

interface ReplayFilter {
  where: string;
  params: any[];
}

function completeReplayFilter(sessionId: string, beforeId: number | undefined, agentId?: string): ReplayFilter {
  const params: any[] = [sessionId];
  const clauses = ['session_id = $1'];
  if (agentId) {
    params.push(agentId);
    clauses.push(`payload->>'agent_id' = $${params.length}`);
  }
  if (beforeId !== undefined && beforeId > 0) {
    params.push(beforeId);
    clauses.push(`id < $${params.length}`);
  }
  return { where: clauses.join(' AND '), params };
}

async function scanBackwardReplayEvents(
  pool: pg.Pool,
  sessionId: string,
  beforeId: number | undefined,
  limit: number,
  agentId?: string,
): Promise<any[]> {
  const filter = completeReplayFilter(sessionId, beforeId, agentId);
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at
     FROM events
     WHERE ${filter.where}
     ORDER BY id DESC LIMIT $${filter.params.length + 1}`,
    [...filter.params, limit],
  );
  return result.rows;
}

async function hasOlderReplayEvent(
  pool: pg.Pool,
  sessionId: string,
  oldestId: number,
  agentId?: string,
): Promise<boolean> {
  const filter = completeReplayFilter(sessionId, oldestId, agentId);
  const result = await pool.query(
    `SELECT 1 FROM events WHERE ${filter.where} LIMIT 1`,
    filter.params,
  );
  return result.rows.length > 0;
}

/**
 * Builds one backward page that never begins in the middle of a chunked
 * content stream. The database is scanned newest-first for efficient cursor
 * pagination, then the selected contiguous interval is returned oldest-first.
 */
export async function getCompleteBackwardReplayPage(
  pool: pg.Pool,
  sessionId: string,
  beforeId: number | undefined,
  logicalLimit: number,
  agentId?: string,
): Promise<CompleteBackwardReplayPage> {
  const limit = Math.max(1, Math.trunc(logicalLimit));
  const scanLimit = Math.max(100, limit * 2);
  const rowsDesc: any[] = [];
  let scanCursor = beforeId;

  while (true) {
    const rows = await scanBackwardReplayEvents(pool, sessionId, scanCursor, scanLimit, agentId);
    if (rows.length === 0) break;
    rowsDesc.push(...rows);

    const boundary = findCompleteReplayBoundary(rowsDesc, limit);
    if (boundary) {
      const selectedDesc = rowsDesc.slice(0, boundary.endIndex + 1);
      const events = [...selectedDesc].reverse();
      const oldestId = events[0].id;
      return {
        events,
        oldestId,
        logicalCount: boundary.logicalCount,
        hasMore: await hasOlderReplayEvent(pool, sessionId, oldestId, agentId),
      };
    }

    scanCursor = rows[rows.length - 1].id;
    if (rows.length < scanLimit) break;
  }

  if (rowsDesc.length === 0) {
    return { events: [], oldestId: beforeId ?? 0, logicalCount: 0, hasMore: false };
  }

  const events = [...rowsDesc].reverse();
  const oldestId = events[0].id;
  if (hasOpenReplayStreams(rowsDesc)) {
    console.warn('[history-replay] reached oldest event before stream boundary', {
      sessionId,
      agentId,
      oldestId,
    });
  }
  return {
    events,
    oldestId,
    logicalCount: countReplayLogicalItems(rowsDesc),
    hasMore: await hasOlderReplayEvent(pool, sessionId, oldestId, agentId),
  };
}

export async function getSessionStatus(pool: pg.Pool, sessionId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT status FROM sessions WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0]?.status ?? null;
}

export async function getSessionRuntime(pool: pg.Pool, sessionId: string): Promise<{ status: string | null; turnStartedAt: string | null; lastActivityAt: string | null }> {
  const result = await pool.query(
    `SELECT status, turn_started_at, last_activity_at FROM sessions WHERE session_id = $1`,
    [sessionId]
  );
  const row = result.rows[0];
  return {
    status: row?.status ?? null,
    turnStartedAt: row?.turn_started_at ? new Date(row.turn_started_at).toISOString() : null,
    lastActivityAt: row?.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
  };
}

export async function getRecentSubagentEvents(pool: pg.Pool, sessionId: string, agentId: string, limit: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at
     FROM events
     WHERE session_id = $1 AND payload->>'agent_id' = $2
     ORDER BY id DESC LIMIT $3`,
    [sessionId, agentId, limit]
  );
  return result.rows;
}

export async function getSubagentEventsBefore(pool: pg.Pool, sessionId: string, agentId: string, cursor: number, limit: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at
     FROM events
     WHERE session_id = $1 AND payload->>'agent_id' = $2 AND id < $3
     ORDER BY id DESC LIMIT $4`,
    [sessionId, agentId, cursor, limit]
  );
  return result.rows;
}

export interface SessionListPage {
  sessions: any[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface SessionListCursor {
  pinned: number;
  pinnedAt: string;
  activityAt: string;
  sessionId: string;
}

// 内部：带 children 聚合的列表（listSessions / listSessionsByUser 共用）
export async function listSessionsWithChildren(pool: pg.Pool, whereUser?: number): Promise<any[]> {
  const baseParams: any[] = [];
  const userClause = whereUser !== undefined ? 'AND s.user_id = $1' : '';
  if (whereUser !== undefined) baseParams.push(whereUser);
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.active_agent, s.cwd, s.title, s.source, s.status,
            s.control_mode, s.capabilities,
            s.created_at, s.updated_at, s.last_activity_at, s.turn_started_at, s.exit_reason, s.subagent_count, s.pinned,
            s.model, s.parent_session_id, s.is_subagent, s.root_session_id,
            s.total_tokens, s.tok_input, s.tok_output, s.tok_cache_read, s.tok_cache_create,
            d.status AS daemon_status, d.hostname AS hostname, d.alias AS daemon_alias
     FROM sessions s
     LEFT JOIN daemons d ON s.daemon_id = d.daemon_id
     WHERE s.session_id NOT LIKE 'pending-%'
       AND COALESCE(s.is_subagent, false) = false ${userClause}
     ORDER BY s.pinned DESC, s.pinned_at DESC NULLS LAST, COALESCE(s.last_activity_at, s.updated_at) DESC`,
    baseParams
  );
  // 一次查全部 subagents，按 parent 分组（避免 N+1）
  const subs = await pool.query(
    `SELECT parent_session_id, agent_id, kind, agent_type, title, status, token_in, token_out, token_cache, token_cache_create
     FROM subagents ORDER BY created_at ASC`
  );
  const { byParent, sumChildren } = groupSubagentsByParent(subs.rows);
  return result.rows.map((row: any) => serializeSessionRow(row, byParent, sumChildren));
}

function groupSubagentsByParent(rows: any[]): { byParent: Map<string, any[]>; sumChildren: Map<string, number> } {
  const byParent = new Map<string, any[]>();
  const sumChildren = new Map<string, number>();
  for (const r of rows) {
    // node-postgres returns BIGINT as strings. Normalize at the API boundary so
    // clients cannot accidentally concatenate token fields with JavaScript `+`.
    const tokenIn = Number(r.token_in || 0);
    const tokenOut = Number(r.token_out || 0);
    const tokenCache = Number(r.token_cache || 0);
    const tokenCacheCreate = Number(r.token_cache_create || 0);
    if (!byParent.has(r.parent_session_id)) byParent.set(r.parent_session_id, []);
    byParent.get(r.parent_session_id)!.push({
      agentId: r.agent_id, kind: r.kind, agentType: r.agent_type, title: r.title,
      status: r.status, tokenIn, tokenOut, tokenCache, tokenCacheCreate,
    });
    // 累加该 child 的四列 token 之和到其 parent 桶，用于把子用量并入 totalTokens。
    const childSum = tokenIn + tokenOut + tokenCache + tokenCacheCreate;
    sumChildren.set(r.parent_session_id, (sumChildren.get(r.parent_session_id) ?? 0) + childSum);
  }
  return { byParent, sumChildren };
}

function serializeSessionRow(row: any, byParent: Map<string, any[]>, sumChildren?: Map<string, number>): any {
  const childSum = sumChildren?.get(row.session_id) ?? 0;
  const children = byParent.get(row.session_id) || [];
  return {
    ...row,
    control_mode: row.control_mode ?? (row.agent_type === 'opencode' ? 'legacy_read_only' : null),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    // totalTokens = 父会话自身用量 + Σ所有子智能体用量（让 UI 标注的「含子智能体」名副其实；
    // 父明细 tok_input/output/cache_* 不并子项，保留 breakdown 展开）。
    totalTokens: parseInt(row.total_tokens ?? 0, 10) + childSum,
    tokInput: parseInt(row.tok_input ?? 0, 10),
    tokOutput: parseInt(row.tok_output ?? 0, 10),
    tokCacheRead: parseInt(row.tok_cache_read ?? 0, 10),
    tokCacheCreate: parseInt(row.tok_cache_create ?? 0, 10),
    total_tokens: undefined, tok_input: undefined, tok_output: undefined, tok_cache_read: undefined, tok_cache_create: undefined,
    sort_pinned: undefined, sort_pinned_at: undefined, sort_activity_at: undefined,
    daemon_online: row.daemon_status === 'online',
    daemon_alias: row.daemon_alias ?? null,
    daemon_status: undefined,
    subagent_count: children.length,
    children,
  };
}

export async function listSessions(pool: pg.Pool): Promise<any[]> {
  return listSessionsWithChildren(pool);
}

function decodeSessionListCursor(cursor?: string | null): SessionListCursor | null {
  if (!cursor || cursor === '0') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      (parsed.pinned === 0 || parsed.pinned === 1) &&
      typeof parsed.pinnedAt === 'string' &&
      typeof parsed.activityAt === 'string' &&
      typeof parsed.sessionId === 'string'
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function encodeSessionListCursor(row: any): string {
  const cursor: SessionListCursor = {
    pinned: Number(row.sort_pinned ?? 0),
    pinnedAt: new Date(row.sort_pinned_at).toISOString(),
    activityAt: new Date(row.sort_activity_at).toISOString(),
    sessionId: row.session_id,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Page top-level sessions for one daemon using a keyset cursor. */
export async function listSessionsPageByDaemon(pool: pg.Pool, opts: {
  userId?: number;
  daemonId: string;
  limit: number;
  cursor?: string | null;
}): Promise<SessionListPage> {
  const limit = Math.max(1, Math.min(opts.limit, 100));
  const cursor = decodeSessionListCursor(opts.cursor);
  const params: any[] = [opts.daemonId, limit + 1];
  const userClause = opts.userId !== undefined ? `AND s.user_id = $${params.length + 1}` : '';
  if (opts.userId !== undefined) params.push(opts.userId);
  let cursorClause = '';
  if (cursor) {
    const start = params.length + 1;
    params.push(cursor.pinned, cursor.pinnedAt, cursor.activityAt, cursor.sessionId);
    cursorClause = `
       AND (
         (CASE WHEN s.pinned THEN 1 ELSE 0 END),
         COALESCE(s.pinned_at, '1970-01-01T00:00:00Z'::timestamptz),
         COALESCE(s.last_activity_at, s.updated_at),
         s.session_id
       ) < ($${start}, $${start + 1}::timestamptz, $${start + 2}::timestamptz, $${start + 3})`;
  }

  const queryStartedAt = Date.now();
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.active_agent, s.cwd, s.title, s.source, s.status,
            s.control_mode, s.capabilities,
            s.created_at, s.updated_at, s.last_activity_at, s.exit_reason, s.subagent_count, s.pinned,
            s.model, s.parent_session_id, s.is_subagent, s.root_session_id,
            s.total_tokens, s.tok_input, s.tok_output, s.tok_cache_read, s.tok_cache_create,
            d.status AS daemon_status, d.hostname AS hostname, d.alias AS daemon_alias,
            CASE WHEN s.pinned THEN 1 ELSE 0 END AS sort_pinned,
            COALESCE(s.pinned_at, '1970-01-01T00:00:00Z'::timestamptz) AS sort_pinned_at,
            COALESCE(s.last_activity_at, s.updated_at) AS sort_activity_at
     FROM sessions s
     LEFT JOIN daemons d ON s.daemon_id = d.daemon_id
     WHERE s.session_id NOT LIKE 'pending-%'
       AND s.daemon_id = $1
       AND COALESCE(s.is_subagent, false) = false
       ${userClause}
       ${cursorClause}
     ORDER BY CASE WHEN s.pinned THEN 1 ELSE 0 END DESC,
              COALESCE(s.pinned_at, '1970-01-01T00:00:00Z'::timestamptz) DESC,
              COALESCE(s.last_activity_at, s.updated_at) DESC,
              s.session_id DESC
     LIMIT $2`,
    params
  );
  if (process.env.SESSION_LIST_DEBUG === '1') {
    console.log('[session_list] page query', {
      daemonId: opts.daemonId,
      limit,
      cursor: !!cursor,
      rows: result.rows.length,
      elapsedMs: Date.now() - queryStartedAt,
    });
  }

  const pageRows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const parentIds = pageRows.map((row: any) => row.session_id);
  let byParent = new Map<string, any[]>();
  let sumChildren = new Map<string, number>();
  if (parentIds.length > 0) {
    const childrenStartedAt = Date.now();
    const subs = await pool.query(
      `SELECT parent_session_id, agent_id, kind, agent_type, title, status, token_in, token_out, token_cache, token_cache_create
       FROM subagents WHERE parent_session_id = ANY($1) ORDER BY created_at ASC`,
      [parentIds]
    );
    if (process.env.SESSION_LIST_DEBUG === '1') {
      console.log('[session_list] children query', {
        daemonId: opts.daemonId,
        parents: parentIds.length,
        rows: subs.rows.length,
        elapsedMs: Date.now() - childrenStartedAt,
      });
    }
    ({ byParent, sumChildren } = groupSubagentsByParent(subs.rows));
  }

  return {
    sessions: pageRows.map((row: any) => serializeSessionRow(row, byParent, sumChildren)),
    hasMore,
    nextCursor: hasMore ? encodeSessionListCursor(pageRows[pageRows.length - 1]) : null,
  };
}

/** 取一个会话的 token 拆分 —— parent.totalTokens = 父会话自身用量 + Σ各子代理用量；
 *  parent.tokInput/Output/CacheRead/CacheCreate 仅父会话自身明细（不并子项，供 breakdown 展开）；
 *  children 为各子代理明细。未知 session 返回 null。 */
export async function getSessionTokenBreakdown(pool: pg.Pool, userId: number, sessionId: string): Promise<{
  parent: { totalTokens: number; tokInput: number; tokOutput: number; tokCacheRead: number; tokCacheCreate: number };
  children: Array<{ agentId: string; agentType: string; title: string; tokenIn: number; tokenOut: number; tokenCache: number; tokenCacheCreate: number }>;
} | null> {
  const sess = await pool.query(
    `SELECT total_tokens, tok_input, tok_output, tok_cache_read, tok_cache_create
     FROM sessions WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  if ((sess.rowCount ?? 0) === 0) return null;
  const r = sess.rows[0];
  const children = await listSubagentsByParent(pool, sessionId);
  // totalTokens 含子代理：Σ各 child 的四列之和。
  const childSum = children.reduce((acc: number, c: any) =>
    acc + Number(c.tokenIn || 0) + Number(c.tokenOut || 0)
      + Number(c.tokenCache || 0) + Number(c.tokenCacheCreate || 0), 0);
  return {
    parent: {
      totalTokens: parseInt(r.total_tokens ?? 0, 10) + childSum,
      tokInput: parseInt(r.tok_input ?? 0, 10),
      tokOutput: parseInt(r.tok_output ?? 0, 10),
      tokCacheRead: parseInt(r.tok_cache_read ?? 0, 10),
      tokCacheCreate: parseInt(r.tok_cache_create ?? 0, 10),
    },
    children,
  };
}

export async function upsertSession(pool: pg.Pool, sessionId: string, daemonId: string, agentType: string, cwd: string, status: string, title?: string, source?: string, exitReason?: string, userId?: number, model?: string, controlMode?: string, capabilities?: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, title, source, status, exit_reason, user_id, model, control_mode, capabilities, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       daemon_id = $2,
       status = $7,
       agent_type = COALESCE(NULLIF($3, ''), sessions.agent_type),
       cwd = COALESCE(NULLIF($4, ''), sessions.cwd),
       title = COALESCE($5, sessions.title),
       source = CASE
         WHEN sessions.source = 'daemon' AND $6 = 'terminal' THEN sessions.source
         ELSE COALESCE($6, sessions.source)
       END,
       exit_reason = COALESCE($8, sessions.exit_reason),
       user_id = CASE WHEN $9 IS NOT NULL THEN $9 ELSE sessions.user_id END,
       model = COALESCE($10, sessions.model),
       control_mode = COALESCE($11, sessions.control_mode),
       capabilities = COALESCE($12::jsonb, sessions.capabilities),
       updated_at = NOW()`,
    [sessionId, daemonId, agentType, cwd, title || null, source || 'daemon', status, exitReason || null, userId || null, model || null, controlMode || null, capabilities ? JSON.stringify(capabilities) : null]
  );
}

export async function updateSessionControl(pool: pg.Pool, sessionId: string, controlMode: string, capabilities: string[]): Promise<void> {
  await pool.query(
    `UPDATE sessions SET control_mode = $1, capabilities = $2::jsonb, updated_at = NOW() WHERE session_id = $3`,
    [controlMode, JSON.stringify(capabilities), sessionId],
  );
}

export async function ensureDaemonSessionIdentity(pool: pg.Pool, sessionId: string, daemonId: string, userId?: number): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, source, status, user_id, created_at, updated_at)
     VALUES ($1, $2, '', '', 'daemon', 'running', $3, NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       daemon_id = $2,
       source = 'daemon',
       user_id = CASE WHEN $3 IS NOT NULL THEN $3 ELSE sessions.user_id END,
       updated_at = NOW()`,
    [sessionId, daemonId, userId || null]
  );
}

/** Increment subagent_count for a session. */
export async function incrementSubagentCount(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET subagent_count = subagent_count + 1, updated_at = NOW() WHERE session_id = $1`,
    [sessionId]
  );
}

/** Upsert a subagent row keyed by (parent_session_id, agent_id). */
export async function upsertSubagent(pool: pg.Pool, parentSessionId: string, agentId: string, kind: string, toolUseId?: string, agentType?: string, title?: string): Promise<void> {
  await pool.query(
    `INSERT INTO subagents (parent_session_id, agent_id, kind, tool_use_id, agent_type, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (parent_session_id, agent_id) DO UPDATE SET
       kind = $3,
       tool_use_id = COALESCE($4, subagents.tool_use_id),
       agent_type = COALESCE($5, subagents.agent_type),
       title = COALESCE($6, subagents.title),
       updated_at = NOW()`,
    [parentSessionId, agentId, kind, toolUseId || null, agentType || null, title || null]
  );
}

export interface SubagentRelation {
  parentSessionId: string;
  agentId: string;
  rootSessionId: string;
  kind: string;
  toolUseId?: string;
  agentType?: string;
  title?: string;
}

/** Reconcile one child relation and any legacy top-level session row.
 * Token totals are rebuilt from rollout subagent_usage events; copying the
 * legacy session snapshot here would double-count the first history replay. */
export async function reconcileSubagent(pool: pg.Pool, relation: SubagentRelation): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO subagents (parent_session_id, agent_id, kind, tool_use_id, agent_type, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (parent_session_id, agent_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         tool_use_id = COALESCE(EXCLUDED.tool_use_id, subagents.tool_use_id),
         agent_type = COALESCE(EXCLUDED.agent_type, subagents.agent_type),
         title = COALESCE(EXCLUDED.title, subagents.title),
         updated_at = NOW()`,
      [relation.parentSessionId, relation.agentId, relation.kind,
        relation.toolUseId ?? null, relation.agentType ?? null, relation.title ?? null]
    );
    await client.query(
      `UPDATE sessions
       SET is_subagent = true, parent_session_id = $1, root_session_id = $2, updated_at = NOW()
       WHERE session_id = $3`,
      [relation.parentSessionId, relation.rootSessionId, relation.agentId]
    );
    if (relation.kind === 'codex_subagent') {
      // Remove only pre-event_id Codex history written by older daemons. New
      // stable events are protected even if they arrive while this transaction
      // is running; Claude history is outside this migration.
      await client.query(
        `DELETE FROM events
         WHERE session_id = $1
           AND payload->>'agent_id' = $2
           AND COALESCE(payload->>'event_id', '') = ''`,
        [relation.parentSessionId, relation.agentId]
      );
    }
    await client.query(
      `UPDATE sessions SET subagent_count = (
         SELECT COUNT(*)::int FROM subagents WHERE parent_session_id = $1
       ), updated_at = NOW()
       WHERE session_id = $1`,
      [relation.parentSessionId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Accumulate token usage into a subagent row. Uses INSERT ON CONFLICT so it
 *  is idempotent and self-creates the row if subagent_usage arrives before
 *  subagent_discovered (out-of-order or discovery dropped on backpressure).
 *  P1a: 补 cache_create 列（修复此前被丢弃的 cache_create_tokens）。 */
export async function addSubagentUsage(pool: pg.Pool, parentSessionId: string, agentId: string, inputTokens: number, outputTokens: number, cacheRead: number, cacheCreate: number): Promise<void> {
  await pool.query(
    `INSERT INTO subagents (parent_session_id, agent_id, token_in, token_out, token_cache, token_cache_create, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (parent_session_id, agent_id) DO UPDATE SET
       token_in = subagents.token_in + $3,
       token_out = subagents.token_out + $4,
       token_cache = subagents.token_cache + $5,
       token_cache_create = subagents.token_cache_create + $6,
       updated_at = NOW()`,
    [parentSessionId, agentId, inputTokens, outputTokens, cacheRead, cacheCreate]
  );
}

export interface SubagentUsageRecord {
  daemonId: string;
  seq?: number;
  eventId: string;
  parentSessionId: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
}

/** Durably deduplicate and accumulate one child usage record in one transaction. */
export async function recordSubagentUsageInTransaction(
  client: Pick<pg.PoolClient, 'query'>,
  usage: SubagentUsageRecord,
): Promise<boolean> {
  const hashInput = usage.eventId
    ? `${usage.parentSessionId}:${usage.agentId}:event:${usage.eventId}`
    : `${usage.parentSessionId}:${usage.agentId}:${usage.inputTokens}:${usage.outputTokens}:${usage.cacheRead}:${usage.cacheCreate}`;
  const usageHash = createHash('md5')
    .update(hashInput)
    .digest('hex').slice(0, 16);
  const seen = await client.query(
    `INSERT INTO subagent_usage_seen (daemon_id, usage_hash, seq, agent_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING usage_hash`,
    [usage.daemonId, usageHash, usage.seq ?? null, usage.agentId]
  );
  if ((seen.rowCount ?? 0) === 0) {
    return false;
  }
  await client.query(
    `INSERT INTO subagents (parent_session_id, agent_id, token_in, token_out, token_cache, token_cache_create, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (parent_session_id, agent_id) DO UPDATE SET
       token_in = subagents.token_in + $3,
       token_out = subagents.token_out + $4,
       token_cache = subagents.token_cache + $5,
       token_cache_create = subagents.token_cache_create + $6,
       updated_at = NOW()`,
    [usage.parentSessionId, usage.agentId, usage.inputTokens, usage.outputTokens, usage.cacheRead, usage.cacheCreate]
  );
  return true;
}

export async function recordSubagentUsage(pool: pg.Pool, usage: SubagentUsageRecord): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applied = await recordSubagentUsageInTransaction(client, usage);
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** List subagents for one parent session (camelCased for clients). */
export async function listSubagentsByParent(pool: pg.Pool, parentSessionId: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT agent_id, kind, agent_type, title, status, token_in, token_out, token_cache, token_cache_create
     FROM subagents WHERE parent_session_id = $1 ORDER BY created_at ASC`,
    [parentSessionId]
  );
  return result.rows.map((r: any) => ({
    agentId: r.agent_id, kind: r.kind, agentType: r.agent_type, title: r.title,
    status: r.status, tokenIn: r.token_in, tokenOut: r.token_out,
    tokenCache: r.token_cache, tokenCacheCreate: r.token_cache_create,
  }));
}

/** Mark sessions as completed if their daemon has been offline for > 5 minutes. */
export async function cleanStaleSessions(pool: pg.Pool): Promise<void> {
  await pool.query(`
    UPDATE sessions SET status = 'completed', updated_at = NOW()
    WHERE status IN ('running', 'busy', 'retry')
      AND daemon_id NOT IN (SELECT daemon_id FROM daemons WHERE status = 'online' AND last_heartbeat > NOW() - INTERVAL '5 minutes')
  `);
  // Also purge ghost pending-* sessions older than 10 minutes
  await pool.query(`
    DELETE FROM sessions
    WHERE session_id LIKE 'pending-%'
      AND created_at < NOW() - INTERVAL '10 minutes'
  `);
}

/**
 * Reconcile a daemon's sessions against the live set it reports on (re)connect.
 * Any session this daemon owns that is still 'running'/'busy'/'retry' in the DB but NOT
 * in `activeSessionIds` is a zombie: its agent process ended without a terminal
 * session_status (daemon restart / machine sleep / crash mid-turn), so the row
 * is frozen "executing" forever — cleanStaleSessions can't help while the daemon
 * is online. Close them. An empty `activeSessionIds` (daemon has no live sessions)
 * correctly closes all of this daemon's lingering executing rows.
 * Returns the closed session IDs so the caller can notify clients.
 */
export async function reconcileDaemonSessions(
  pool: pg.Pool,
  daemonId: string,
  activeSessionIds: string[],
  registrationId: string,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `SELECT registration_id FROM daemons
       WHERE daemon_id = $1 AND registration_id = $2
       FOR UPDATE`,
      [daemonId, registrationId],
    );
    if (!claim.rows[0]) {
      await client.query('COMMIT');
      return [];
    }
    const res = await client.query(
      `UPDATE sessions SET status = 'completed', updated_at = NOW()
       WHERE daemon_id = $1
         AND status IN ('running', 'busy', 'retry')
         AND session_id NOT LIKE 'pending-%'
         AND session_id <> ALL($2::text[])
       RETURNING session_id`,
      [daemonId, activeSessionIds],
    );
    await client.query('COMMIT');
    return res.rows.map(r => r.session_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// --- Phase 2: User management ---

export interface User {
  id: number;
  email: string;
  phone?: string | null;
  display_name?: string | null;
  plan?: string;
  created_at?: Date | string;
}

export interface WelcomeEmailJob {
  id: string;
  userId: number;
  recipientEmail: string;
  locale: SupportedLanguage;
  attemptCount: number;
}

export async function createUserWithWelcomeEmail(
  pool: pg.Pool,
  email: string,
  passwordHash: string,
  displayName: string | undefined,
  locale: SupportedLanguage,
): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<User>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, phone, display_name, plan, created_at`,
      [normalizedEmail, passwordHash, displayName || null],
    );
    const user = result.rows[0];
    await client.query(
      `INSERT INTO email_outbox (user_id, email_type, recipient_email, locale)
       VALUES ($1, 'welcome', $2, $3)
       ON CONFLICT (user_id, email_type) DO NOTHING`,
      [user.id, normalizedEmail, locale],
    );
    await client.query('COMMIT');
    return user;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the transaction failure; rollback is best-effort on a broken connection.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function claimWelcomeEmails(
  pool: pg.Pool,
  limit: number,
  leaseCutoff: Date,
): Promise<WelcomeEmailJob[]> {
  const result = await pool.query(
    `WITH claimable AS (
       SELECT id
       FROM email_outbox
       WHERE email_type = 'welcome'
         AND (
           (status = 'pending' AND next_attempt_at <= NOW())
           OR (status = 'processing' AND locked_at < $2)
         )
       ORDER BY next_attempt_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE email_outbox AS outbox
     SET status = 'processing',
         attempt_count = outbox.attempt_count + 1,
         locked_at = NOW(),
         updated_at = NOW()
     FROM claimable
     WHERE outbox.id = claimable.id
     RETURNING outbox.id,
               outbox.user_id AS "userId",
               outbox.recipient_email AS "recipientEmail",
               outbox.locale,
               outbox.attempt_count AS "attemptCount"`,
    [limit, leaseCutoff],
  );
  return result.rows;
}

export async function markWelcomeEmailSent(
  pool: pg.Pool,
  id: string,
  attemptCount: number,
  messageId: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_outbox
     SET status = 'sent', message_id = $3, sent_at = NOW(), locked_at = NULL,
         last_error = NULL, updated_at = NOW()
     WHERE id = $1 AND attempt_count = $2 AND status = 'processing'`,
    [id, attemptCount, messageId],
  );
}

export async function rescheduleWelcomeEmail(
  pool: pg.Pool,
  id: string,
  attemptCount: number,
  nextAttemptAt: Date,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_outbox
     SET status = 'pending', next_attempt_at = $3, last_error = $4,
         locked_at = NULL, updated_at = NOW()
     WHERE id = $1 AND attempt_count = $2 AND status = 'processing'`,
    [id, attemptCount, nextAttemptAt, error.slice(0, 1000)],
  );
}

export async function createUser(pool: pg.Pool, email: string, passwordHash: string, displayName?: string): Promise<any> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, phone, display_name, plan, created_at`,
    [email, passwordHash, displayName || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(pool: pg.Pool, email: string): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, phone, password_hash, display_name, plan, created_at FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

export async function getUserById(pool: pg.Pool, id: number): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, phone, display_name, plan, created_at FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** Return whether an authenticated user id still belongs to a live account. */
export async function userExists(pool: pg.Pool, userId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1) AS exists`,
    [userId],
  );
  return result.rows[0]?.exists === true;
}

/**
 * Permanently remove one account and every directly associated record.
 *
 * Several legacy tables predate user foreign keys, so deletion cannot rely on
 * ON DELETE CASCADE alone. Capture the owned session/daemon ids while holding
 * the user-row lock, then remove their dependent rows in the same transaction.
 */
export async function deleteUserAccount(pool: pg.Pool, userId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if ((user.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return false;
    }

    const sessions = await client.query(
      `SELECT session_id FROM sessions WHERE user_id = $1`,
      [userId],
    );
    const daemons = await client.query(
      `SELECT daemon_id FROM daemons WHERE user_id = $1`,
      [userId],
    );
    const sessionIds = sessions.rows.map((row: any) => row.session_id as string);
    const daemonIds = daemons.rows.map((row: any) => row.daemon_id as string);

    await client.query(
      `DELETE FROM realtime_outbox
       WHERE inbox_id IN (SELECT inbox_id FROM event_inbox WHERE user_id = $1)`,
      [userId],
    );
    await client.query(`DELETE FROM event_inbox WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM events WHERE session_id = ANY($1::varchar[])`, [sessionIds]);
    await client.query(`DELETE FROM subagents WHERE parent_session_id = ANY($1::varchar[])`, [sessionIds]);
    await client.query(`DELETE FROM subagent_usage_seen WHERE daemon_id = ANY($1::text[])`, [daemonIds]);
    await client.query(`DELETE FROM deleted_sessions WHERE session_id = ANY($1::varchar[])`, [sessionIds]);
    await client.query(`DELETE FROM token_daily_stats WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM audit_log WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM revoked_tokens WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM daemons WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the deletion failure; rollback is best-effort on a broken connection.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Update user's display name */
export async function updateDisplayName(pool: pg.Pool, userId: number, displayName: string): Promise<void> {
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [displayName, userId]);
}

/** Update user's email (bind email) */
export async function updateEmail(pool: pg.Pool, userId: number, email: string): Promise<void> {
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, userId]);
}

/** Get user's plan and whitelist status for daemon limit control */
export async function getUserPlanAndWhitelist(pool: pg.Pool, userId: number): Promise<{ plan: string; whitelist: boolean }> {
  const result = await pool.query(
    `SELECT plan, whitelist FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return { plan: 'free', whitelist: false };
  }
  return {
    plan: result.rows[0].plan || 'free',
    whitelist: result.rows[0].whitelist || false,
  };
}

/** Get user profile including subscription plan */
export async function getUserProfile(pool: pg.Pool, userId: number): Promise<{ id: number; email: string; phone: string | null; display_name: string | null; plan: string } | null> {
  const result = await pool.query(
    `SELECT id, email, phone, display_name, plan FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    phone: row.phone ?? null,
    display_name: row.display_name ?? null,
    plan: row.plan || 'free',
  };
}

export async function bindDaemonToUser(pool: pg.Pool, daemonId: string, userId: number): Promise<void> {
  await pool.query(`UPDATE daemons SET user_id = $1 WHERE daemon_id = $2`, [userId, daemonId]);
}

export async function listSessionsByUser(pool: pg.Pool, userId: number): Promise<any[]> {
  return listSessionsWithChildren(pool, userId);
}

// --- Session deletion ---

export async function deleteSession(pool: pg.Pool, sessionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSessionMaterializationFence(client, sessionId);
    // Compensate: roll this session's TODAY usage into token_daily_stats before
    // deleting events. Past days are already captured in stats by cron/backfill
    // (independent of events, so deleting them is safe); only today (not yet rolled
    // up) needs compensation — otherwise deleting the session shrinks today's total.
    await client.query(`
      INSERT INTO token_daily_stats (user_id, daemon_id, date, model, input, output, cache_read, cache_create, requests)
      SELECT s.user_id, s.daemon_id, CURRENT_DATE,
             COALESCE(s.model, 'unknown'),
             SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0)),
             SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)),
             COUNT(*)
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = $1 AND e.event_type = 'agent_text' AND e.payload ? 'usage'
        AND date_trunc('day', e.created_at) = CURRENT_DATE
        AND s.user_id IS NOT NULL AND s.daemon_id IS NOT NULL
      GROUP BY s.user_id, s.daemon_id, COALESCE(s.model, 'unknown')
      ON CONFLICT (user_id, daemon_id, date, model) DO UPDATE SET
        input = token_daily_stats.input + EXCLUDED.input,
        output = token_daily_stats.output + EXCLUDED.output,
        cache_read = token_daily_stats.cache_read + EXCLUDED.cache_read,
        cache_create = token_daily_stats.cache_create + EXCLUDED.cache_create,
        requests = token_daily_stats.requests + EXCLUDED.requests
    `, [sessionId]);
    await client.query(
      `DELETE FROM realtime_outbox
       WHERE inbox_id IN (SELECT inbox_id FROM event_inbox WHERE session_id = $1)`,
      [sessionId],
    );
    await client.query(`DELETE FROM event_inbox WHERE session_id = $1`, [sessionId]);
    await client.query(`DELETE FROM events WHERE session_id = $1`, [sessionId]);
    await client.query(`DELETE FROM sessions WHERE session_id = $1`, [sessionId]);
    await client.query(
      `INSERT INTO deleted_sessions (session_id) VALUES ($1) ON CONFLICT (session_id) DO UPDATE SET deleted_at = NOW()`,
      [sessionId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function isSessionDeleted(pool: pg.Pool, sessionId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM deleted_sessions WHERE session_id = $1`, [sessionId]);
  return result.rows.length > 0;
}

/**
 * Resolve the owning daemon_id for a session from the DB. Used as a fallback
 * when the in-memory sessionToDaemon map misses (relay restart, daemon
 * reconnect with stale entries, …). Returns null for unknown / deleted sessions.
 */
export async function getSessionDaemonId(pool: pg.Pool, sessionId: string): Promise<string | null> {
  const result = await pool.query(`SELECT daemon_id FROM sessions WHERE session_id = $1`, [sessionId]);
  if ((result.rowCount ?? 0) === 0) return null;
  return result.rows[0].daemon_id ?? null;
}

// --- Title generation ---

/** Check if a session still has a default-generated title (Terminal Session-*) */
export async function hasDefaultTitle(pool: pg.Pool, sessionId: string): Promise<boolean> {
  const result = await pool.query(
    // NULL 也算默认: terminal session 的默认标题因时序竞争可能未写入 (session_discovered
    // 不带 title → INSERT NULL)。若不把 NULL 当默认，这类 session 会被判为「已有自定义标题」
    // 而永久跳过 AI 生成 (2fec2498 案例)。
    `SELECT 1 FROM sessions WHERE session_id = $1 AND (title LIKE 'Terminal Session-%' OR title IS NULL)`,
    [sessionId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Update session title only if it still has the default pattern. Returns true if updated. */
export async function updateTitleIfDefault(pool: pg.Pool, sessionId: string, newTitle: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions SET title = $1, updated_at = NOW() WHERE session_id = $2 AND (title LIKE 'Terminal Session-%' OR title IS NULL)`,
    [newTitle, sessionId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** A subagent row's title is "default" when NULL (subagents table has no default value). */
export async function hasDefaultSubagentTitle(pool: pg.Pool, parentSessionId: string, agentId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM subagents WHERE parent_session_id = $1 AND agent_id = $2 AND title IS NULL`,
    [parentSessionId, agentId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Update a subagent's title only if still default (NULL). Returns true if a row was updated. */
export async function updateSubagentTitleIfDefault(pool: pg.Pool, parentSessionId: string, agentId: string, newTitle: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE subagents SET title = $1, updated_at = NOW() WHERE parent_session_id = $2 AND agent_id = $3 AND title IS NULL`,
    [newTitle, parentSessionId, agentId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Unconditionally update session title (user rename), with ownership check. Returns true if updated. */
export async function updateSessionTitle(pool: pg.Pool, userId: number, sessionId: string, title: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions SET title = $1, updated_at = NOW() WHERE session_id = $2 AND user_id = $3 AND session_id NOT LIKE 'pending-%'`,
    [title, sessionId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Set session pinned state, with ownership check. Returns true if updated. */
export async function setSessionPin(pool: pg.Pool, userId: number, sessionId: string, pinned: boolean): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions SET pinned = $1, pinned_at = CASE WHEN $1 THEN NOW() ELSE NULL END, updated_at = NOW()
     WHERE session_id = $2 AND user_id = $3 AND session_id NOT LIKE 'pending-%'`,
    [pinned, sessionId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Check if a session belongs to the given user. */
export async function isSessionOwnedByUser(pool: pg.Pool, userId: number, sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM sessions WHERE session_id = $1 AND user_id = $2 AND session_id NOT LIKE 'pending-%'`,
    [sessionId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Get all events for a session (for export). */
export async function getSessionAllEvents(pool: pg.Pool, sessionId: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, session_id, event_type, payload, created_at FROM events WHERE session_id = $1 ORDER BY id ASC`,
    [sessionId]
  );
  return result.rows;
}


/// Clean up tombstones older than 30 days
export async function cleanStaleTombstones(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`DELETE FROM deleted_sessions WHERE deleted_at < NOW() - INTERVAL '30 days'`);
  return result.rowCount ?? 0;
}

// --- Phase 3: Device management for push notifications ---

export async function registerDevice(pool: pg.Pool, userId: number, deviceToken: string, platform: string, deviceName?: string): Promise<void> {
  await pool.query(
    `INSERT INTO devices (user_id, device_token, platform, device_name, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, device_token) DO UPDATE SET last_seen_at = NOW(), device_name = COALESCE($4, devices.device_name)`,
    [userId, deviceToken, platform, deviceName || null]
  );
}

export async function removeDevice(pool: pg.Pool, userId: number, deviceToken: string): Promise<boolean> {
  // Scope the delete to the caller's own devices — without the user_id predicate
  // any authenticated user could delete another user's push device (DoS: victim
  // stops receiving offline/session-complete pushes).
  const r = await pool.query(`DELETE FROM devices WHERE device_token = $1 AND user_id = $2`, [deviceToken, userId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * System-internal removal of a device token reported invalid by APNs (410/400).
 * Not user-scoped on purpose: the token is dead at the provider, so the owner is
 * irrelevant and not available at the call site. Never reachable from a client
 * request — only the push pipeline calls this.
 */
export async function removeInvalidDeviceToken(pool: pg.Pool, deviceToken: string): Promise<void> {
  await pool.query(`DELETE FROM devices WHERE device_token = $1`, [deviceToken]);
}

export async function getDevicesByUser(pool: pg.Pool, userId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT id, user_id, device_token, platform, device_name, created_at, last_seen_at FROM devices WHERE user_id = $1`,
    [userId]
  );
  return result.rows;
}

// --- iOS Waitlist ---

export async function addToIOSWaitlist(pool: pg.Pool, email: string): Promise<{ inserted: boolean; message: string }> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail.includes('@')) {
    return { inserted: false, message: '无效的邮箱地址' };
  }
  try {
    await pool.query(
      `INSERT INTO ios_waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [normalizedEmail]
    );
    return { inserted: true, message: '已加入等候列表' };
  } catch {
    return { inserted: false, message: '提交失败，请稍后再试' };
  }
}

// --- Token Revocation ---

/** Check if a token's jti has been revoked. */
export async function isTokenRevoked(pool: pg.Pool, jti: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [jti]);
  return (result.rowCount ?? 0) > 0;
}

/** Revocation lookup with a PostgreSQL-enforced deadline and owned client. */
export async function isTokenRevokedWithTimeout(
  pool: pg.Pool,
  jti: string,
  timeoutMs: number,
): Promise<boolean> {
  const safeTimeoutMs = Math.max(1, Math.min(2_147_483_647, Math.trunc(timeoutMs) || 1));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(safeTimeoutMs)]);
    const result = await client.query(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [jti]);
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Revoke a token by jti. */
export async function revokeToken(pool: pg.Pool, jti: string, userId: number, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockTokenRevocationFence(client, jti);
    await client.query(
      `INSERT INTO revoked_tokens (jti, user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [jti, userId, reason]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Decide what to do when a refresh request reuses an already-rotated jti.
 *
 * Tolerance policy (supports one account running multiple daemons): do NOT
 * permanently breach. A daemon that failed to persist its last refreshed token
 * (e.g. SaveAuth I/O error) will reuse the previous one — that's a stale-local
 * token, not theft. Breaching on the first reuse permanently locks the daemon
 * out (3×4001 → authRejectStopThreshold → park), which is how a whole account
 * can silently lose a host. Instead: record an audit entry so reuse stays
 * observable for real theft detection, and let the refresh proceed (issue a new
 * token) so the daemon self-heals on its next refresh.
 *
 * Returns true to block the refresh (genuine breach — reserved for future
 * multi-IP reuse heuristics), false to tolerate and continue.
 */
export async function handleRefreshReuse(pool: pg.Pool, userId: number, jti: string): Promise<boolean> {
  await insertAuditLog(pool, userId, 'refresh_reuse_tolerated', {
    jti,
    message: 'refresh token reuse tolerated — daemon likely has a stale local token; issuing a new token so it can self-heal',
  });
  return false;
}

/**
 * Revoke the access token currently bound to a daemon (force_kick / new_login
 * eviction). Looks up daemons.active_token_jti and revokes that specific jti, so
 * the kicked daemon can't reconnect with its old token while the user's other
 * sessions (web/iOS) stay valid.
 *
 * Replaces the previous `revokeToken(pool, '', userId, ...)` pattern, which
 * inserted an empty-jti row that `isTokenRevoked` (WHERE jti = $1) could never
 * match — making force_kick/new_login revocation a silent no-op.
 */
export async function revokeDaemonToken(pool: pg.Pool, daemonId: string, userId: number, reason: string): Promise<void> {
  const r = await pool.query(`SELECT active_token_jti FROM daemons WHERE daemon_id = $1`, [daemonId]);
  const jti = r.rows[0]?.active_token_jti as string | null | undefined;
  if (!jti) return; // legacy/api-key daemon with no bound token — nothing to revoke
  await revokeToken(pool, jti, userId, reason);
}

/** Revoke ALL tokens for a user (breach detection). */
export async function revokeAllUserTokens(pool: pg.Pool, userId: number, reason: string): Promise<void> {
  // We can't revoke tokens without their jti, but we can log the event.
  // The actual revocation happens when we roll the JWT_SECRET or when tokens naturally expire.
  // For now, we at minimum insert audit log entries for all known tokens.
  await pool.query(
    `INSERT INTO audit_log (user_id, action, details) VALUES ($1, 'revoke_all', $2)`,
    [userId, JSON.stringify({ reason })]
  );
}

/** Clean up expired entries from revoked_tokens.
 *  Access tokens expire in 24h → purge entries older than 25h.
 *  Refresh tokens expire in 7d → purge entries older than 8d. */
export async function cleanRevokedTokens(pool: pg.Pool): Promise<{ accessPurged: number; refreshPurged: number }> {
  const accessResult = await pool.query(
    `DELETE FROM revoked_tokens WHERE reason IN ('user_revoke', 'new_login', 'force_kick', 'logout', 'admin') AND revoked_at < NOW() - INTERVAL '25 hours'`
  );
  const refreshResult = await pool.query(
    `DELETE FROM revoked_tokens WHERE reason = 'rotation' AND revoked_at < NOW() - INTERVAL '8 days'`
  );
  return {
    accessPurged: accessResult.rowCount ?? 0,
    refreshPurged: refreshResult.rowCount ?? 0,
  };
}

// --- Audit Log ---

/** Insert an audit log entry. */
export async function insertAuditLog(
  pool: pg.Pool,
  userId: number | null,
  action: string,
  details: Record<string, any> = {},
  ip?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (user_id, action, details, ip) VALUES ($1, $2, $3, $4)`,
    [userId, action, JSON.stringify(details), ip || null]
  );
}

// --- Daemon Token Binding ---

/** Update the active token jti on a daemon row. */
export async function bindTokenToDaemon(pool: pg.Pool, daemonId: string, jti: string, machineId?: string): Promise<void> {
  await pool.query(
    `UPDATE daemons SET active_token_jti = $1, machine_id = COALESCE($2, machine_id), last_login_at = NOW() WHERE daemon_id = $3`,
    [jti, machineId || null, daemonId]
  );
}

// --- C2: Token cost tracking ---

/** Update an existing session's status/exit_reason — UPDATE-ONLY (never INSERT).
 *  session_status events must not materialise a session row: a session_id that
 *  was never announced via session_created/session_discovered is a ghost (e.g.
 *  Claude Code writes a transient ~/.claude/sessions/<pid>.json on --continue
 *  whose <id>.jsonl never appears, so the daemon's tailer never resolves and no
 *  session_discovered is ever emitted — only session_status). Upserting on those
 *  produced phantom rows with empty cwd/agent/title showing "status + time, no
 *  messages". Returns true if an existing row was updated. */
export async function updateSessionStatus(pool: pg.Pool, sessionId: string, daemonId: string, status: string, exitReason?: string, userId?: number, turnStartedAt?: string): Promise<boolean> {
  const res = await pool.query(
    `WITH input AS (
       SELECT $3::varchar AS status, $6::timestamptz AS turn_started_at
     )
     UPDATE sessions SET
       daemon_id = $2,
       status = input.status,
       exit_reason = COALESCE($4, sessions.exit_reason),
       user_id = COALESCE($5::int, sessions.user_id),
       turn_started_at = CASE
         WHEN input.status IN ('running', 'busy', 'retry', 'waiting', 'waiting_approval', 'waiting_question')
           THEN COALESCE(input.turn_started_at, sessions.turn_started_at, NOW())
         ELSE NULL
       END,
       updated_at = NOW()
     FROM input
     WHERE session_id = $1`,
    [sessionId, daemonId, status, exitReason || null, userId || null, turnStartedAt || null]
  );
  return (res.rowCount ?? 0) > 0;
}

export const SESSION_STATUS_SUPPRESSED_EFFECT_STEP = 1_000_000_000;

/**
 * Atomically records whether a session_status referred to a real session.
 * A missing-session decision is encoded in the event effect ledger so later
 * replay cannot start delivering the historical ghost after a session appears.
 */
export async function updateSessionStatusForEvent(
  pool: pg.Pool,
  eventID: number,
  nextStep: number,
  sessionId: string,
  daemonId: string,
  status: string,
  exitReason?: string,
  userId?: number,
  turnStartedAt?: string,
): Promise<{ sessionExists: boolean; suppressed: boolean }> {
  const result = await pool.query(
    `WITH input AS (
       SELECT $6::varchar AS status, $9::timestamptz AS turn_started_at
     ), session_status_decision AS (
       UPDATE sessions SET
         daemon_id = $5,
         status = input.status,
         exit_reason = COALESCE($7, sessions.exit_reason),
         user_id = COALESCE($8::int, sessions.user_id),
         turn_started_at = CASE
           WHEN input.status IN ('running', 'busy', 'retry', 'waiting', 'waiting_approval', 'waiting_question')
             THEN COALESCE(input.turn_started_at, sessions.turn_started_at, NOW())
           ELSE NULL
         END,
         updated_at = NOW()
       FROM input
       WHERE session_id = $4
       RETURNING 1
     ), ledger_decision AS (
       UPDATE events SET effect_step = CASE
         WHEN EXISTS (SELECT 1 FROM session_status_decision)
           THEN GREATEST(effect_step, $2)
         ELSE $3
       END
       WHERE id = $1 AND effect_status = 'pending'
       RETURNING effect_step
     )
     SELECT
       EXISTS (SELECT 1 FROM session_status_decision) AS session_exists,
       COALESCE((SELECT effect_step >= $3 FROM ledger_decision), false) AS suppressed`,
    [
      eventID,
      nextStep,
      SESSION_STATUS_SUPPRESSED_EFFECT_STEP,
      sessionId,
      daemonId,
      status,
      exitReason || null,
      userId || null,
      turnStartedAt || null,
    ],
  );
  const outcome = result.rows[0];
  if (!outcome) {
    const sessionExists = (result.rowCount ?? 0) > 0;
    return { sessionExists, suppressed: !sessionExists };
  }
  return {
    sessionExists: outcome?.session_exists === true || outcome?.session_exists === 't',
    suppressed: outcome?.suppressed === true || outcome?.suppressed === 't',
  };
}

/** Update session cumulative cost (called on session_status carrying cost_usd from result event). */
export async function updateSessionCost(pool: pg.Pool, sessionId: string, costUsd: number): Promise<void> {
  await pool.query(`UPDATE sessions SET cost_usd = $1, updated_at = NOW() WHERE session_id = $2`, [costUsd, sessionId]);
}

/** Update the session's resolved model (on a mid-session /model switch). Unlike
 *  upsertSession (which uses COALESCE and cannot overwrite), this writes unconditionally. */
export async function updateSessionModel(pool: pg.Pool, sessionId: string, model: string): Promise<void> {
  await pool.query(`UPDATE sessions SET model = $1, updated_at = NOW() WHERE session_id = $2`, [model, sessionId]);
}

/** Persist an OpenCode agent switch only after the daemon confirms it. */
export async function updateSessionActiveAgent(pool: pg.Pool, sessionId: string, activeAgent: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET active_agent = $1, updated_at = NOW() WHERE session_id = $2`,
    [activeAgent, sessionId],
  );
}

/** Increment session cost by a delta (for per-turn cost accumulation from assistant usage). */
export async function incrementSessionCost(pool: pg.Pool, sessionId: string, delta: number): Promise<void> {
  await pool.query(`UPDATE sessions SET cost_usd = COALESCE(cost_usd, 0) + $1, updated_at = NOW() WHERE session_id = $2`, [delta, sessionId]);
}

/** Token usage breakdown carried by agent_text events (matches daemon ContextUsage JSON tags). */
export interface TokenUsageDelta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_create_tokens?: number;
}

/** Accumulate per-turn token usage into sessions (total + per-type columns).
 *  Model-agnostic raw token counts — no pricing assumptions. */
export async function incrementSessionTokens(pool: pg.Pool, sessionId: string, u: TokenUsageDelta): Promise<void> {
  const inp = Math.max(0, u.input_tokens || 0);
  const out = Math.max(0, u.output_tokens || 0);
  const cr = Math.max(0, u.cache_read_tokens || 0);
  const cc = Math.max(0, u.cache_create_tokens || 0);
  const total = inp + out + cr + cc;
  if (total <= 0) return;
  await pool.query(
    `UPDATE sessions SET
       total_tokens = COALESCE(total_tokens, 0) + $1,
       tok_input = COALESCE(tok_input, 0) + $2,
       tok_output = COALESCE(tok_output, 0) + $3,
       tok_cache_read = COALESCE(tok_cache_read, 0) + $4,
       tok_cache_create = COALESCE(tok_cache_create, 0) + $5,
       updated_at = NOW()
     WHERE session_id = $6`,
    [total, inp, out, cr, cc, sessionId]
  );
}

/** Backfill sessions token columns from agent_text usage events.
 *  Sums input/output/cache_read/cache_create per session into the token columns.
 *  Model-agnostic (raw token counts). Runs once on relay startup. */
export async function backfillSessionTokens(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`
    WITH agg AS (
      SELECT session_id,
             SUM(COALESCE((payload->'usage'->>'input_tokens')::bigint, 0)) AS inp,
             SUM(COALESCE((payload->'usage'->>'output_tokens')::bigint, 0)) AS outp,
             SUM(COALESCE((payload->'usage'->>'cache_read_tokens')::bigint, 0)) AS cr,
             SUM(COALESCE((payload->'usage'->>'cache_create_tokens')::bigint, 0)) AS cc
      FROM events
      WHERE event_type = 'agent_text' AND payload ? 'usage'
      GROUP BY session_id
    )
    UPDATE sessions SET
      total_tokens = agg.inp + agg.outp + agg.cr + agg.cc,
      tok_input = agg.inp,
      tok_output = agg.outp,
      tok_cache_read = agg.cr,
      tok_cache_create = agg.cc,
      updated_at = NOW()
    FROM agg WHERE sessions.session_id = agg.session_id
  `);
  return result.rowCount ?? 0;
}

/** Backfill sessions.model for sessions that have no model recorded. Sources,
 *  in priority order:
 *   1. session_created events (daemon-spawned sessions announce their model at create time)
 *   2. session_model_changed events (a mid-session /model switch — authoritative for the
 *      current model, and the ONLY signal for terminal sessions that never went through
 *      session_created, since session_discovered carries no model)
 *   3. agent_text events (last resort: the model id on the most recent assistant turn —
 *      covers terminal sessions whose model was never explicitly announced)
 *  Idempotent. Run on startup. */
export async function backfillSessionModel(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`
    WITH candidates AS (
      SELECT session_id, model,
             ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY CASE source
                          WHEN 'session_created'        THEN 1
                          WHEN 'session_model_changed'   THEN 2
                          WHEN 'agent_text'              THEN 3
                        END,
                        created_at DESC
             ) AS rn
      FROM (
        SELECT session_id, payload->>'model' AS model, event_type AS source, created_at
        FROM events
        WHERE event_type IN ('session_created', 'session_model_changed', 'agent_text')
          AND payload ? 'model' AND payload->>'model' <> ''
      ) e
    )
    UPDATE sessions s SET model = c.model
    FROM (SELECT session_id, model FROM candidates WHERE rn = 1) c
    WHERE s.session_id = c.session_id AND s.model IS NULL
  `);
  return result.rowCount ?? 0;
}

/** Backfill token_daily_stats from past-day events (idempotent: ON CONFLICT DO NOTHING,
 *  since past days are immutable — cron already captured them). Run after
 *  backfillSessionModel so sessions.model is populated. */
export async function backfillTokenDailyStats(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`
    INSERT INTO token_daily_stats (user_id, daemon_id, date, model, input, output, cache_read, cache_create, requests)
    SELECT s.user_id, s.daemon_id, date_trunc('day', e.created_at)::date,
           COALESCE(s.model, 'unknown'),
           SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0)),
           SUM(COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)),
           COUNT(*)
    FROM events e JOIN sessions s ON s.session_id = e.session_id
    WHERE e.event_type = 'agent_text' AND e.payload ? 'usage'
      AND e.created_at < date_trunc('day', NOW())
      AND s.user_id IS NOT NULL AND s.daemon_id IS NOT NULL
    GROUP BY s.user_id, s.daemon_id, date_trunc('day', e.created_at)::date, COALESCE(s.model, 'unknown')
    ON CONFLICT (user_id, daemon_id, date, model) DO NOTHING
  `);
  return result.rowCount ?? 0;
}

/** Aggregate one day's events into token_daily_stats (idempotent: DO NOTHING — a past
 *  day's events are immutable once rolled up). pg advisory lock serializes multi-instance
 *  relays so the same day isn't double-aggregated. */
export async function aggregateDayIntoStats(pool: pg.Pool, date: Date): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(98172634)');
    const result = await client.query(`
      INSERT INTO token_daily_stats (user_id, daemon_id, date, model, input, output, cache_read, cache_create, requests)
      SELECT s.user_id, s.daemon_id, $1::date,
             COALESCE(s.model, 'unknown'),
             SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0)),
             SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)),
             COUNT(*)
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type = 'agent_text' AND e.payload ? 'usage'
        AND date_trunc('day', e.created_at) = $1::date
        AND s.user_id IS NOT NULL AND s.daemon_id IS NOT NULL
      GROUP BY s.user_id, s.daemon_id, COALESCE(s.model, 'unknown')
      ON CONFLICT (user_id, daemon_id, date, model) DO NOTHING
    `, [date.toISOString().slice(0, 10)]);
    return result.rowCount ?? 0;
  } finally {
    await client.query('SELECT pg_advisory_unlock(98172634)');
    client.release();
  }
}

/** Delete events older than the retention window (default 90 days). token_daily_stats
 *  preserves their rolled-up totals, so the dashboard stays complete. */
export async function cleanStaleEvents(pool: pg.Pool, days = 90): Promise<number> {
  const result = await pool.query(
    `DELETE FROM events e
     WHERE e.created_at < NOW() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1
         FROM realtime_outbox o
         WHERE o.event_id = e.id
           AND o.delivered_at IS NULL
       )`,
    [days],
  );
  return result.rowCount ?? 0;
}

// ---- Token dashboard aggregation ----
// Query-time merge: past days from token_daily_stats + today from events
// (deleted sessions still contribute via same-day compensation rows in stats).

export async function getTokenDailySeries(pool: pg.Pool, userId: number, daemonId: string | null, days = 30): Promise<any[]> {
  const useD = !!daemonId && daemonId !== 'all';
  const params: any[] = [userId];
  if (useD) params.push(daemonId);
  params.push(days);
  const dStats = useD ? 'AND daemon_id = $2' : '';
  const dEvt = useD ? 'AND s.daemon_id = $2' : '';
  const dp = useD ? '$3' : '$2';
  const result = await pool.query(`
    SELECT date, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(requests) AS requests
    FROM (
      SELECT date, input, output, cache_read, requests FROM token_daily_stats
      WHERE user_id = $1 ${dStats} AND date >= CURRENT_DATE - (${dp}::int) AND date <= CURRENT_DATE
      UNION ALL
      SELECT date_trunc('day', e.created_at)::date,
             SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint,0)),
             SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint,0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint,0)),
             COUNT(*)
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type='agent_text' AND e.payload ? 'usage' AND s.user_id = $1 ${dEvt}
        AND date_trunc('day', e.created_at) = CURRENT_DATE
      GROUP BY 1
    ) t GROUP BY date ORDER BY date`, params);
  return result.rows.map((r: any) => ({ date: r.date, input: +r.input, output: +r.output, cache_read: +r.cache_read, requests: +r.requests }));
}

export async function getTokenByModel(pool: pg.Pool, userId: number, daemonId: string | null): Promise<any[]> {
  const useD = !!daemonId && daemonId !== 'all';
  const params: any[] = [userId];
  if (useD) params.push(daemonId);
  const dStats = useD ? 'AND daemon_id = $2' : '';
  const dEvt = useD ? 'AND s.daemon_id = $2' : '';
  const result = await pool.query(`
    SELECT model, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(requests) AS requests
    FROM (
      SELECT model, input, output, cache_read, requests FROM token_daily_stats WHERE user_id = $1 ${dStats}
      UNION ALL
      SELECT COALESCE(s.model,'unknown'),
             SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint,0)),
             SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint,0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint,0)),
             COUNT(*)
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type='agent_text' AND e.payload ? 'usage' AND s.user_id = $1 ${dEvt}
        AND date_trunc('day', e.created_at) = CURRENT_DATE
      GROUP BY 1
    ) t GROUP BY model ORDER BY SUM(input) DESC`, params);
  const rows = result.rows.map((r: any) => ({ model: r.model, input: +r.input, output: +r.output, cache_read: +r.cache_read, requests: +r.requests, total: (+r.input) + (+r.output) }));
  const tot = rows.reduce((s: number, r: any) => s + r.total, 0) || 1;
  rows.forEach((r: any) => { r.pct = +(r.total / tot * 100).toFixed(1); });
  return rows;
}

export async function getTokenByDaemon(pool: pg.Pool, userId: number): Promise<any[]> {
  const result = await pool.query(`
    SELECT daemon_id, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(requests) AS requests
    FROM (
      SELECT daemon_id, input, output, cache_read, requests FROM token_daily_stats WHERE user_id = $1
      UNION ALL
      SELECT s.daemon_id,
             SUM(COALESCE((e.payload->'usage'->>'input_tokens')::bigint,0)),
             SUM(COALESCE((e.payload->'usage'->>'output_tokens')::bigint,0)),
             SUM(COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint,0)),
             COUNT(*)
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type='agent_text' AND e.payload ? 'usage' AND s.user_id = $1
        AND date_trunc('day', e.created_at) = CURRENT_DATE
      GROUP BY 1
    ) t GROUP BY daemon_id`, [userId]);
  const ids = result.rows.map((r: any) => r.daemon_id);
  let nameMap: Record<string, any> = {};
  if (ids.length) {
    const nm = await pool.query(`SELECT daemon_id, hostname, alias FROM daemons WHERE daemon_id = ANY($1)`, [ids]);
    nameMap = Object.fromEntries(nm.rows.map((r: any) => [r.daemon_id, r]));
  }
  return result.rows.map((r: any) => ({ daemon_id: r.daemon_id, hostname: nameMap[r.daemon_id]?.hostname || '', alias: nameMap[r.daemon_id]?.alias || '', input: +r.input, output: +r.output, cache_read: +r.cache_read, requests: +r.requests, total: (+r.input) + (+r.output) }));
}

/** Per-session daily token trend (from events; only within the 90-day retention). */
export async function getSessionTokenTrend(pool: pg.Pool, sessionId: string, days = 30): Promise<any[]> {
  const result = await pool.query(`
    SELECT date_trunc('day', created_at)::date AS date,
           SUM(COALESCE((payload->'usage'->>'input_tokens')::bigint,0)) AS input,
           SUM(COALESCE((payload->'usage'->>'output_tokens')::bigint,0)) AS output,
           SUM(COALESCE((payload->'usage'->>'cache_read_tokens')::bigint,0)) AS cache_read,
           COUNT(*) AS requests
    FROM events
    WHERE session_id = $1 AND event_type='agent_text' AND payload ? 'usage'
      AND created_at >= NOW() - ($2 || ' days')::interval
    GROUP BY 1 ORDER BY 1`, [sessionId, days]);
  return result.rows.map((r: any) => ({ date: r.date, input: +r.input, output: +r.output, cache_read: +r.cache_read, requests: +r.requests }));
}

/** User-level token usage summary: cumulative total + today/week/month deltas.
 *  All deltas come from per-turn agent_text usage (input+output+cache_read+cache_create),
 *  so BOTH PTY/attach sessions and -p sessions are attributed correctly. Model-agnostic. */
export async function getTokenSummary(
  pool: pg.Pool,
  userId: number,
  daemonId: string | null = null,
): Promise<{ total: number; today: number; thisWeek: number; thisMonth: number }> {
  const useDaemon = !!daemonId && daemonId !== 'all';
  const params: any[] = [userId];
  if (useDaemon) {
    params.push(daemonId);
  }
  const daemonPredicate = useDaemon ? 'AND s.daemon_id = $2' : '';

  const result = await pool.query(`
    WITH turn_tokens AS (
      SELECT e.created_at,
             (COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)) AS delta
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type = 'agent_text' AND e.payload ? 'usage' AND s.user_id = $1 ${daemonPredicate}
    )
    SELECT
      COALESCE(SUM(delta), 0) AS total,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN delta ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', NOW()) THEN delta ELSE 0 END), 0) AS this_week,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN delta ELSE 0 END), 0) AS this_month
    FROM turn_tokens
  `, params);
  const r = result.rows[0] || {};
  return {
    total: parseInt(r.total ?? 0, 10),
    today: parseInt(r.today ?? 0, 10),
    thisWeek: parseInt(r.this_week ?? 0, 10),
    thisMonth: parseInt(r.this_month ?? 0, 10),
  };
}

function normalizeAgentType(raw: string | null | undefined): string {
  const lower = (raw ?? '').trim().toLowerCase();
  switch (lower) {
    case 'claude-code':
    case 'claude_code':
    case 'claudecode':
    case 'claude':
      return 'claude-code';
    case 'opencode':
    case 'open_code':
    case 'open-code':
      return 'opencode';
    default:
      return lower || 'unknown';
  }
}

/** Daemon-level token usage: cumulative total + today/month deltas + per-session breakdown
 *  with full token composition (input/output/cache_read/cache_create).
 *  Also returns per-agent aggregated usage, so clients can show agent-scoped
 *  numbers without recomputing from session lists.
 */
export async function getTokensByDaemon(pool: pg.Pool, userId: number, daemonId: string): Promise<{
  total: number; today: number; thisMonth: number;
  sessions: Array<{ session_id: string; title: string; total_tokens: number; tok_input: number; tok_output: number; tok_cache_read: number; tok_cache_create: number; model: string; agent_type: string; status: string; created_at: Date; children?: any[] }>;
  byAgent?: Array<{ agent_type: string; total: number; today: number; cache_read: number; cache_create: number }>;
} | null> {
  const own = await pool.query(`SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2`, [daemonId, userId]);
  if ((own.rowCount ?? 0) === 0) return null;

  const totals = await pool.query(`
    WITH turn_tokens AS (
      SELECT e.created_at,
             (COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)) AS delta
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type = 'agent_text' AND e.payload ? 'usage' AND s.user_id = $1 AND s.daemon_id = $2
    )
    SELECT
      COALESCE(SUM(delta), 0) AS total,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN delta ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN delta ELSE 0 END), 0) AS this_month
    FROM turn_tokens
  `, [userId, daemonId]);

  const sess = await pool.query(`
    SELECT session_id, COALESCE(title, '') AS title,
           COALESCE(total_tokens, 0) AS total_tokens,
           COALESCE(tok_input, 0) AS tok_input,
           COALESCE(tok_output, 0) AS tok_output,
           COALESCE(tok_cache_read, 0) AS tok_cache_read,
           COALESCE(tok_cache_create, 0) AS tok_cache_create,
           COALESCE(model, '') AS model,
           COALESCE(agent_type, '') AS agent_type,
           COALESCE(status, '') AS status,
           created_at, COALESCE(parent_session_id, '') AS parent_session_id
    FROM sessions
    WHERE user_id = $1 AND daemon_id = $2 AND session_id NOT LIKE 'pending-%'
    ORDER BY COALESCE(last_activity_at, updated_at) DESC
  `, [userId, daemonId]);

  const byAgentTotals = await pool.query(`
    SELECT COALESCE(agent_type, '') AS agent_type,
           COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
           COALESCE(SUM(COALESCE(tok_cache_read, 0)), 0) AS tok_cache_read,
           COALESCE(SUM(COALESCE(tok_cache_create, 0)), 0) AS tok_cache_create
    FROM sessions
    WHERE user_id = $1 AND daemon_id = $2 AND session_id NOT LIKE 'pending-%'
    GROUP BY COALESCE(agent_type, '')
  `, [userId, daemonId]);

  const byAgentToday = await pool.query(`
    SELECT COALESCE(s.agent_type, '') AS agent_type,
           COALESCE(SUM(
             COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0) +
             COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0) +
             COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0) +
             COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)
           ), 0) AS today
    FROM events e
    JOIN sessions s ON s.session_id = e.session_id
    WHERE e.event_type = 'agent_text' AND e.payload ? 'usage'
      AND s.user_id = $1 AND s.daemon_id = $2
    GROUP BY COALESCE(s.agent_type, '')
  `, [userId, daemonId]);

  const byAgentMap = new Map<string, { agent_type: string; total: number; today: number; cache_read: number; cache_create: number }>();
  for (const r of byAgentTotals.rows as any[]) {
    const key = normalizeAgentType(r.agent_type ?? '');
    const existing = byAgentMap.get(key);
    if (existing) {
      existing.total += parseInt(r.total_tokens ?? 0, 10);
      existing.cache_read += parseInt(r.tok_cache_read ?? 0, 10);
      existing.cache_create += parseInt(r.tok_cache_create ?? 0, 10);
    } else {
      byAgentMap.set(key, {
        agent_type: key,
        total: parseInt(r.total_tokens ?? 0, 10),
        today: 0,
        cache_read: parseInt(r.tok_cache_read ?? 0, 10),
        cache_create: parseInt(r.tok_cache_create ?? 0, 10),
      });
    }
  }
  for (const r of byAgentToday.rows as any[]) {
    const key = normalizeAgentType(r.agent_type ?? '');
    const existing = byAgentMap.get(key);
    if (existing) {
      existing.today += parseInt(r.today ?? 0, 10);
    } else {
      byAgentMap.set(key, {
        agent_type: key,
        total: 0,
        today: parseInt(r.today ?? 0, 10),
        cache_read: 0,
        cache_create: 0,
      });
    }
  }
  const byAgent = Array.from(byAgentMap.values()).sort((a, b) => b.total - a.total);

  const parentSessionIds = (sess.rows as any[])
    .filter((r) => r.parent_session_id === '')
    .map((r) => r.session_id);
  const subagentRows = parentSessionIds.length > 0
    ? await pool.query(
      `SELECT parent_session_id, agent_id, kind, agent_type, title, status,
              token_in, token_out, token_cache, token_cache_create
       FROM subagents
       WHERE parent_session_id = ANY($1::text[])
       ORDER BY created_at ASC`,
      [parentSessionIds],
    )
    : { rows: [] };
  const { byParent, sumChildren } = groupSubagentsByParent(subagentRows.rows);

  const t = totals.rows[0] || {};
  return {
    total: parseInt(t.total ?? 0, 10),
    today: parseInt(t.today ?? 0, 10),
    thisMonth: parseInt(t.this_month ?? 0, 10),
    sessions: (sess.rows as any[]).map((r) => ({
      session_id: r.session_id,
      title: r.title,
      total_tokens: parseInt(r.total_tokens ?? 0, 10) + (sumChildren.get(r.session_id) ?? 0),
      tok_input: parseInt(r.tok_input ?? 0, 10),
      tok_output: parseInt(r.tok_output ?? 0, 10),
      tok_cache_read: parseInt(r.tok_cache_read ?? 0, 10),
      tok_cache_create: parseInt(r.tok_cache_create ?? 0, 10),
      model: r.model,
      agent_type: r.agent_type,
      status: r.status,
      created_at: r.created_at,
      children: r.parent_session_id === '' ? (byParent.get(r.session_id) ?? []) : [],
    })),
    byAgent,
  };
}

/** Per-daemon session counts (active running/busy/retry + total) for a user. */
export async function getSessionCountsByUser(pool: pg.Pool, userId: number): Promise<Record<string, { active: number; total: number }>> {
  const result = await pool.query(`
    SELECT daemon_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('running','busy','retry'))::int AS active
    FROM sessions
    WHERE user_id = $1 AND daemon_id IS NOT NULL AND session_id NOT LIKE 'pending-%'
    GROUP BY daemon_id
  `, [userId]);
  const map: Record<string, { active: number; total: number }> = {};
  for (const row of result.rows) {
    map[row.daemon_id] = { active: row.active ?? 0, total: row.total ?? 0 };
  }
  return map;
}

// ---- Report push (daily/weekly token-usage digest, Pro-only) ----

/** List all user IDs eligible for Pro-only pushes (plan != 'free' OR whitelist).
 *  Used by the hourly report job to fan out to every Pro user. */
export async function listProUserIds(pool: pg.Pool): Promise<number[]> {
  const result = await pool.query(
    `SELECT id FROM users WHERE plan != 'free' OR whitelist = true`
  );
  return result.rows.map((r: any) => r.id);
}

/** A user's token totals for a single UTC day (input+output+cache_read+cache_create).
 *  Merges rolled token_daily_stats with today's live events (same pattern as
 *  getTokenDailySeries). Returns null if the user had no usage that day. */
export async function getUserDailyTokens(pool: pg.Pool, userId: number, dateStr: string): Promise<{ total: number; requests: number } | null> {
  // dateStr is 'YYYY-MM-DD' in UTC. token_daily_stats.date is a DATE column;
  // today's events are matched by date_trunc('day', created_at).
  const result = await pool.query(`
    SELECT
      COALESCE(SUM(input + output + cache_read + cache_create), 0) AS total,
      COALESCE(SUM(requests), 0) AS requests
    FROM (
      SELECT input, output, cache_read, cache_create, requests
      FROM token_daily_stats WHERE user_id = $1 AND date = $2::date
      UNION ALL
      SELECT
        COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0),
        COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0),
        COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0),
        COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0),
        1
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE s.user_id = $1
        AND e.event_type = 'agent_text' AND e.payload ? 'usage'
        AND date_trunc('day', e.created_at) = $2::date
    ) merged
  `, [userId, dateStr]);
  const total = Number(result.rows[0]?.total ?? 0);
  const requests = Number(result.rows[0]?.requests ?? 0);
  if (total === 0 && requests === 0) return null;
  return { total, requests };
}

/** A user's token totals for the 7-day window ending at the end of dateStr (inclusive).
 *  dateStr is the last day of the ISO week (Sunday). Reads token_daily_stats only —
 *  past days are fully rolled up, so no live-events merge needed for a weekly look-back. */
export async function getUserWeeklyTokens(pool: pg.Pool, userId: number, weekEndDateStr: string): Promise<{ total: number; requests: number } | null> {
  const result = await pool.query(`
    SELECT
      COALESCE(SUM(input + output + cache_read + cache_create), 0) AS total,
      COALESCE(SUM(requests), 0) AS requests
    FROM token_daily_stats
    WHERE user_id = $1 AND date > ($2::date - 7) AND date <= $2::date
  `, [userId, weekEndDateStr]);
  const total = Number(result.rows[0]?.total ?? 0);
  const requests = Number(result.rows[0]?.requests ?? 0);
  if (total === 0 && requests === 0) return null;
  return { total, requests };
}

/** Atomically record a report push. Returns true if this insert won (i.e. this is
 *  the first push for this user/type/period — caller should proceed to notifyUser).
 *  Returns false if a row already existed (already sent — skip, idempotent). */
export async function markReportSent(pool: pg.Pool, userId: number, reportType: 'daily' | 'weekly', periodKey: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO report_sent (user_id, report_type, period_key) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, report_type, period_key) DO NOTHING`,
    [userId, reportType, periodKey]
  );
  return (result.rowCount ?? 0) > 0;
}

export function parseDBUrl(url: string): DBConfig {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432'),
      database: parsed.pathname.slice(1),
      user: parsed.username,
      password: parsed.password,
    };
  } catch {
    return { host: 'localhost', port: 5432, database: 'pocketctl', user: 'postgres', password: '' };
  }
}
