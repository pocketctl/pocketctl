import pg from 'pg';
import { createHash } from 'crypto';
const { Pool } = pg;

export interface DBConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function createPool(config: DBConfig): pg.Pool {
  return new Pool(config);
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
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(session_id, event_hash)`);
  // Migration: add title and source columns to existing sessions table
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'daemon'`);
  // Migration: add last_activity_at and exit_reason columns
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(32)`);
  // Migration: add subagent_count column
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS subagent_count INT DEFAULT 0`);

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
  // Phase 2: add user_id to sessions and daemons
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INT`);
  await pool.query(`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS user_id INT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);

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

  // User daemon limit control
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS max_daemons INT DEFAULT 1`);
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

export async function setDaemonOffline(pool: pg.Pool, daemonId: string): Promise<void> {
  await pool.query(`UPDATE daemons SET status = 'offline' WHERE daemon_id = $1`, [daemonId]);
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

export async function insertEvent(pool: pg.Pool, sessionId: string, eventType: string, payload: any): Promise<number> {
  const payloadStr = JSON.stringify(payload);
  const hash = createHash('md5').update(`${sessionId}:${eventType}:${payloadStr}`).digest('hex').slice(0, 16);
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

export async function listSessions(pool: pg.Pool): Promise<any[]> {
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.cwd, s.title, s.source, s.status,
            s.created_at, s.updated_at, s.last_activity_at, s.exit_reason, s.subagent_count, s.pinned,
            s.model,
            d.status AS daemon_status, d.hostname AS hostname, d.alias AS daemon_alias
     FROM sessions s
     LEFT JOIN daemons d ON s.daemon_id = d.daemon_id
     WHERE s.session_id NOT LIKE 'pending-%'
     ORDER BY s.pinned DESC, s.pinned_at DESC NULLS LAST, COALESCE(s.last_activity_at, s.updated_at) DESC`
  );
  return result.rows.map((row: any) => ({
    ...row,
    daemon_online: row.daemon_status === 'online',
    daemon_alias: row.daemon_alias ?? null,
    daemon_status: undefined,
  }));
}

export async function upsertSession(pool: pg.Pool, sessionId: string, daemonId: string, agentType: string, cwd: string, status: string, title?: string, source?: string, exitReason?: string, userId?: number, model?: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, title, source, status, exit_reason, user_id, model, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       daemon_id = $2,
       status = $7,
       agent_type = COALESCE(NULLIF($3, ''), sessions.agent_type),
       cwd = COALESCE(NULLIF($4, ''), sessions.cwd),
       title = COALESCE($5, sessions.title),
       source = COALESCE($6, sessions.source),
       exit_reason = COALESCE($8, sessions.exit_reason),
       user_id = CASE WHEN $9 IS NOT NULL THEN $9 ELSE sessions.user_id END,
       model = COALESCE($10, sessions.model),
       updated_at = NOW()`,
    [sessionId, daemonId, agentType, cwd, title || null, source || 'daemon', status, exitReason || null, userId || null, model || null]
  );
}

/** Increment subagent_count for a session. */
export async function incrementSubagentCount(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET subagent_count = subagent_count + 1, updated_at = NOW() WHERE session_id = $1`,
    [sessionId]
  );
}

/** Mark sessions as completed if their daemon has been offline for > 5 minutes. */
export async function cleanStaleSessions(pool: pg.Pool): Promise<void> {
  await pool.query(`
    UPDATE sessions SET status = 'completed', updated_at = NOW()
    WHERE status IN ('running', 'busy')
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
 * Any session this daemon owns that is still 'running'/'busy' in the DB but NOT
 * in `activeSessionIds` is a zombie: its agent process ended without a terminal
 * session_status (daemon restart / machine sleep / crash mid-turn), so the row
 * is frozen "executing" forever — cleanStaleSessions can't help while the daemon
 * is online. Close them. An empty `activeSessionIds` (daemon has no live sessions)
 * correctly closes all of this daemon's lingering running/busy rows.
 * Returns the closed session IDs so the caller can notify clients.
 */
export async function reconcileDaemonSessions(pool: pg.Pool, daemonId: string, activeSessionIds: string[]): Promise<string[]> {
  const res = await pool.query(
    `UPDATE sessions SET status = 'completed', updated_at = NOW()
     WHERE daemon_id = $1
       AND status IN ('running', 'busy')
       AND session_id NOT LIKE 'pending-%'
       AND session_id <> ALL($2::text[])
     RETURNING session_id`,
    [daemonId, activeSessionIds]
  );
  return res.rows.map(r => r.session_id);
}

// --- Phase 2: User management ---

export async function createUser(pool: pg.Pool, email: string, passwordHash: string, displayName?: string): Promise<any> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at`,
    [email, passwordHash, displayName || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(pool: pg.Pool, email: string): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

export async function getUserById(pool: pg.Pool, id: number): Promise<any | null> {
  const result = await pool.query(
    `SELECT id, email, display_name, created_at FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
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
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.cwd, s.title, s.source, s.status,
            s.created_at, s.updated_at, s.last_activity_at, s.exit_reason, s.subagent_count, s.pinned,
            s.model,
            d.status AS daemon_status, d.hostname AS hostname, d.alias AS daemon_alias
     FROM sessions s
     LEFT JOIN daemons d ON s.daemon_id = d.daemon_id
     WHERE s.user_id = $1
       AND s.session_id NOT LIKE 'pending-%'
     ORDER BY s.pinned DESC, s.pinned_at DESC NULLS LAST, COALESCE(s.last_activity_at, s.updated_at) DESC`,
    [userId]
  );
  return result.rows.map((row: any) => ({
    ...row,
    daemon_online: row.daemon_status === 'online',
    daemon_alias: row.daemon_alias ?? null,
    daemon_status: undefined,
  }));
}

// --- Session deletion ---

export async function deleteSession(pool: pg.Pool, sessionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
  return (result.rowCount ?? 0) > 0;
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
    `SELECT 1 FROM sessions WHERE session_id = $1 AND title LIKE 'Terminal Session-%'`,
    [sessionId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Update session title only if it still has the default pattern. Returns true if updated. */
export async function updateTitleIfDefault(pool: pg.Pool, sessionId: string, newTitle: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions SET title = $1, updated_at = NOW() WHERE session_id = $2 AND title LIKE 'Terminal Session-%'`,
    [newTitle, sessionId]
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

/** Revoke a token by jti. */
export async function revokeToken(pool: pg.Pool, jti: string, userId: number, reason: string): Promise<void> {
  await pool.query(
    `INSERT INTO revoked_tokens (jti, user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [jti, userId, reason]
  );
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
export async function updateSessionStatus(pool: pg.Pool, sessionId: string, daemonId: string, status: string, exitReason?: string, userId?: number): Promise<boolean> {
  const res = await pool.query(
    `UPDATE sessions SET
       daemon_id = $2,
       status = $3,
       exit_reason = COALESCE($4, sessions.exit_reason),
       user_id = COALESCE($5::int, sessions.user_id),
       updated_at = NOW()
     WHERE session_id = $1`,
    [sessionId, daemonId, status, exitReason || null, userId || null]
  );
  return (res.rowCount ?? 0) > 0;
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
  const result = await pool.query(`DELETE FROM events WHERE created_at < NOW() - ($1 || ' days')::interval`, [days]);
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
export async function getTokenSummary(pool: pg.Pool, userId: number): Promise<{ total: number; today: number; thisWeek: number; thisMonth: number }> {
  const result = await pool.query(`
    WITH turn_tokens AS (
      SELECT e.created_at,
             (COALESCE((e.payload->'usage'->>'input_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'output_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint, 0) +
              COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint, 0)) AS delta
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type = 'agent_text' AND e.payload ? 'usage' AND s.user_id = $1
    )
    SELECT
      COALESCE(SUM(delta), 0) AS total,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN delta ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', NOW()) THEN delta ELSE 0 END), 0) AS this_week,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN delta ELSE 0 END), 0) AS this_month
    FROM turn_tokens
  `, [userId]);
  const r = result.rows[0] || {};
  return {
    total: parseInt(r.total ?? 0, 10),
    today: parseInt(r.today ?? 0, 10),
    thisWeek: parseInt(r.this_week ?? 0, 10),
    thisMonth: parseInt(r.this_month ?? 0, 10),
  };
}

/** Daemon-level token usage: cumulative total + today/month deltas + per-session breakdown
 *  with full token composition (input/output/cache_read/cache_create). */
export async function getTokensByDaemon(pool: pg.Pool, userId: number, daemonId: string): Promise<{
  total: number; today: number; thisMonth: number;
  sessions: Array<{ session_id: string; title: string; total_tokens: number; tok_input: number; tok_output: number; tok_cache_read: number; tok_cache_create: number; model: string; agent_type: string; status: string; created_at: Date }>;
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
           created_at
    FROM sessions
    WHERE user_id = $1 AND daemon_id = $2 AND session_id NOT LIKE 'pending-%'
    ORDER BY COALESCE(last_activity_at, updated_at) DESC
  `, [userId, daemonId]);

  const t = totals.rows[0] || {};
  return {
    total: parseInt(t.total ?? 0, 10),
    today: parseInt(t.today ?? 0, 10),
    thisMonth: parseInt(t.this_month ?? 0, 10),
    sessions: (sess.rows as any[]).map((r) => ({
      session_id: r.session_id,
      title: r.title,
      total_tokens: parseInt(r.total_tokens ?? 0, 10),
      tok_input: parseInt(r.tok_input ?? 0, 10),
      tok_output: parseInt(r.tok_output ?? 0, 10),
      tok_cache_read: parseInt(r.tok_cache_read ?? 0, 10),
      tok_cache_create: parseInt(r.tok_cache_create ?? 0, 10),
      model: r.model,
      agent_type: r.agent_type,
      status: r.status,
      created_at: r.created_at,
    })),
  };
}

/** Per-daemon session counts (active running/busy + total) for a user. */
export async function getSessionCountsByUser(pool: pg.Pool, userId: number): Promise<Record<string, { active: number; total: number }>> {
  const result = await pool.query(`
    SELECT daemon_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('running','busy'))::int AS active
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
