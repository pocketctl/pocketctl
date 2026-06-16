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

export async function upsertSession(pool: pg.Pool, sessionId: string, daemonId: string, agentType: string, cwd: string, status: string, title?: string, source?: string, exitReason?: string, userId?: number): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, title, source, status, exit_reason, user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       daemon_id = $2,
       status = $7,
       title = COALESCE($5, sessions.title),
       source = COALESCE($6, sessions.source),
       exit_reason = COALESCE($8, sessions.exit_reason),
       user_id = CASE WHEN $9 IS NOT NULL THEN $9 ELSE sessions.user_id END,
       updated_at = NOW()`,
    [sessionId, daemonId, agentType, cwd, title || null, source || 'daemon', status, exitReason || null, userId || null]
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

export async function bindDaemonToUser(pool: pg.Pool, daemonId: string, userId: number): Promise<void> {
  await pool.query(`UPDATE daemons SET user_id = $1 WHERE daemon_id = $2`, [userId, daemonId]);
}

export async function listSessionsByUser(pool: pg.Pool, userId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT s.session_id, s.daemon_id, s.agent_type, s.cwd, s.title, s.source, s.status,
            s.created_at, s.updated_at, s.last_activity_at, s.exit_reason, s.subagent_count, s.pinned,
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
  await pool.query(`DELETE FROM events WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sessionId]);
  await pool.query(
    `INSERT INTO deleted_sessions (session_id) VALUES ($1) ON CONFLICT (session_id) DO UPDATE SET deleted_at = NOW()`,
    [sessionId]
  );
}

export async function isSessionDeleted(pool: pg.Pool, sessionId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM deleted_sessions WHERE session_id = $1`, [sessionId]);
  return (result.rowCount ?? 0) > 0;
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

export async function removeDevice(pool: pg.Pool, deviceToken: string): Promise<void> {
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

/** Update session cumulative cost (called on session_status carrying cost_usd from result event). */
export async function updateSessionCost(pool: pg.Pool, sessionId: string, costUsd: number): Promise<void> {
  await pool.query(`UPDATE sessions SET cost_usd = $1, updated_at = NOW() WHERE session_id = $2`, [costUsd, sessionId]);
}

/** Backfill sessions.cost_usd from events (latest session_status payload with cost_usd per session). */
export async function backfillSessionCost(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (session_id) session_id,
             COALESCE((payload->>'cost_usd')::float, 0) AS cost
      FROM events
      WHERE event_type = 'session_status' AND payload ? 'cost_usd'
      ORDER BY session_id, id DESC
    )
    UPDATE sessions SET cost_usd = latest.cost
    FROM latest WHERE sessions.session_id = latest.session_id
  `);
  return result.rowCount ?? 0;
}

/** User-level cost summary: cumulative total + today/week/month incremental deltas.
 *  Deltas computed via LAG over per-session cost snapshots so multi-turn sessions
 *  are attributed to the time bucket when each turn completed. */
export async function getCostSummary(pool: pg.Pool, userId: number): Promise<{ total: number; today: number; thisWeek: number; thisMonth: number }> {
  const result = await pool.query(`
    WITH cost_events AS (
      SELECT e.id, e.session_id, e.created_at, COALESCE((e.payload->>'cost_usd')::float, 0) AS cost
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type = 'session_status' AND e.payload ? 'cost_usd' AND s.user_id = $1
    ),
    deltas AS (
      SELECT created_at,
             cost - COALESCE(LAG(cost) OVER (PARTITION BY session_id ORDER BY id), 0) AS delta
      FROM cost_events
    )
    SELECT
      (SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE user_id = $1) AS total,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN delta ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', NOW()) THEN delta ELSE 0 END), 0) AS this_week,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN delta ELSE 0 END), 0) AS this_month
    FROM deltas
  `, [userId]);
  const r = result.rows[0] || {};
  return {
    total: parseFloat(r.total ?? 0),
    today: parseFloat(r.today ?? 0),
    thisWeek: parseFloat(r.this_week ?? 0),
    thisMonth: parseFloat(r.this_month ?? 0),
  };
}

/** Daemon-level cost: cumulative total + today/month deltas + per-session breakdown. */
export async function getCostByDaemon(pool: pg.Pool, userId: number, daemonId: string): Promise<{ total: number; today: number; thisMonth: number; sessions: Array<{ session_id: string; title: string; cost_usd: number }> } | null> {
  const own = await pool.query(`SELECT 1 FROM daemons WHERE daemon_id = $1 AND user_id = $2`, [daemonId, userId]);
  if ((own.rowCount ?? 0) === 0) return null;

  const totals = await pool.query(`
    WITH cost_events AS (
      SELECT e.id, e.session_id, e.created_at, COALESCE((e.payload->>'cost_usd')::float, 0) AS cost
      FROM events e JOIN sessions s ON s.session_id = e.session_id
      WHERE e.event_type = 'session_status' AND e.payload ? 'cost_usd' AND s.user_id = $1 AND s.daemon_id = $2
    ),
    deltas AS (
      SELECT created_at,
             cost - COALESCE(LAG(cost) OVER (PARTITION BY session_id ORDER BY id), 0) AS delta
      FROM cost_events
    )
    SELECT
      (SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE user_id = $1 AND daemon_id = $2) AS total,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN delta ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN delta ELSE 0 END), 0) AS this_month
    FROM deltas
  `, [userId, daemonId]);

  const sess = await pool.query(`
    SELECT session_id, COALESCE(title, '') AS title, cost_usd
    FROM sessions
    WHERE user_id = $1 AND daemon_id = $2 AND session_id NOT LIKE 'pending-%'
    ORDER BY COALESCE(last_activity_at, updated_at) DESC
  `, [userId, daemonId]);

  const t = totals.rows[0] || {};
  return {
    total: parseFloat(t.total ?? 0),
    today: parseFloat(t.today ?? 0),
    thisMonth: parseFloat(t.this_month ?? 0),
    sessions: (sess.rows as any[]).map((r) => ({
      session_id: r.session_id,
      title: r.title,
      cost_usd: parseFloat(r.cost_usd ?? 0),
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
