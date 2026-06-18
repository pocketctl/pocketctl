import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { createPool, initDB, parseDBUrl, createUser, getUserByEmail, getUserById, registerDevice, removeDevice, cleanStaleTombstones, upsertDaemonAlias, deleteDaemon, updateDisplayName, updateEmail, addToIOSWaitlist, revokeToken, isTokenRevoked, cleanRevokedTokens, insertAuditLog, bindTokenToDaemon, updateSessionTitle, isSessionOwnedByUser, getSessionAllEvents, getTokenSummary, getTokensByDaemon, backfillSessionTokens } from './db.js';
import { Router } from './router.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, verifyAccessTokenWithRevocation } from './auth.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush } from './push.js';
import { sendEmailCode } from './config/email.js';
import { generateCode, storeCode, verifyCode, hasPendingCode } from './config/verification.js';
import { validateClient } from './config/clients.js';
import { createSession, getSessionByDeviceCode, getSessionByUserCode, authorizeSession, recordPoll, canPoll, deleteSession } from './config/auth-sessions.js';
import { createQrSession, getQrSession, markScanned, confirmQrSession, deleteQrSession } from './config/qr-sessions.js';
import { createHash } from 'crypto';

const API_KEY = process.env.POCKETCTL_API_KEY || '';
const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketctl';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const MAX_WS_MESSAGE_SIZE = parseInt(process.env.MAX_WS_MESSAGE_SIZE || '1048576', 10);
const DEV_EMAIL = process.env.DEV_EMAIL || '';
const DEV_EMAIL_CODE = process.env.DEV_EMAIL_CODE || '';
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_CONNECTIONS = parseInt(process.env.RATE_LIMIT_MAX_CONNECTIONS || '30', 10);

const wsDaemonMap = new Map<any, string>();

// Simple rate limiter: IP -> { count, resetAt }
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimiter.set(ip, entry);
  }
  entry.count++;
  if (Math.random() < 0.01) {
    for (const [key, val] of rateLimiter) {
      if (now > val.resetAt) rateLimiter.delete(key);
    }
  }
  return entry.count <= RATE_LIMIT_MAX_CONNECTIONS;
}

async function main() {
  const pool = createPool(parseDBUrl(DB_URL));
  await initDB(pool);
  console.log('Database initialized');
  // Backfill sessions token columns from agent_text usage events
  try {
    const backfilled = await backfillSessionTokens(pool);
    if (backfilled > 0) console.log(`[tokens] backfilled ${backfilled} sessions with token usage`);
  } catch (e) { console.error('[tokens] backfill failed:', e); }

  const router = new Router(pool);
  const app = Fastify({ logger: false });

  const corsOrigin = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : true;
  await app.register(fastifyCors, { origin: corsOrigin });
  await app.register(fastifyWebsocket);

  // ---- REST API: Auth ----

  // Register
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password, displayName } = req.body as any;
    if (!email || !password) {
      reply.code(400); return { error: 'email and password are required' };
    }
    if (password.length < 6) {
      reply.code(400); return { error: 'password must be at least 6 characters' };
    }
    const existing = await getUserByEmail(pool, email);
    if (existing) {
      reply.code(409); return { error: 'email already registered' };
    }
    const user = await createUser(pool, email, hashPassword(password), displayName);
    const accessToken = await signAccessToken(user.id, user.email);
    const refreshToken = await signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    };
  });

  // Login (DEPRECATED — use /api/auth/email/verify or /api/auth/sms/verify)
  app.post('/api/auth/login', async (req, reply) => {
    reply.header('Deprecation', 'true');
    reply.header('Sunset', 'Sat, 01 Nov 2026 00:00:00 GMT');
    const { email, password } = req.body as any;
    if (!email || !password) {
      reply.code(400); return { error: 'email and password are required. This endpoint is deprecated — use /api/auth/email/verify instead.' };
    }
    const user = await getUserByEmail(pool, email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      reply.code(401); return { error: 'invalid email or password. This endpoint is deprecated — use /api/auth/email/verify instead.' };
    }
    const accessToken = await signAccessToken(user.id, user.email);
    const refreshToken = await signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      _warning: 'This endpoint is deprecated and will be removed. Use /api/auth/email/verify for email-based login.',
    };
  });

  // Refresh token (with rotation and breach detection)
  app.post('/api/auth/refresh', async (req, reply) => {
    const { refresh_token } = req.body as any;
    if (!refresh_token) {
      reply.code(400); return { error: 'refresh_token is required' };
    }
    const payload = verifyRefreshToken(refresh_token);
    if (!payload) {
      reply.code(401); return { error: 'invalid or expired refresh token' };
    }

    // Breach detection: if this token was already revoked, revoke ALL user tokens
    if (payload.jti) {
      try {
        const alreadyRevoked = await isTokenRevoked(pool, payload.jti);
        if (alreadyRevoked) {
          // Breach detected — revoke all tokens
          await revokeToken(pool, payload.jti, payload.userId, 'breach');
          await insertAuditLog(pool, payload.userId, 'breach_detected', {
            jti: payload.jti,
            message: 'refresh token reuse detected',
          });
          reply.code(401);
          return { error: 'invalid or expired refresh token' };
        }
      } catch (err) {
        console.error('refresh revocation check:', err);
      }
    }

    const user = await getUserById(pool, payload.userId);
    if (!user) {
      reply.code(401); return { error: 'user not found' };
    }

    // Revoke old refresh token (rotation)
    if (payload.jti) {
      revokeToken(pool, payload.jti, payload.userId, 'rotation').catch(console.error);
    }

    const accessToken = await signAccessToken(user.id, user.email, user.phone);
    const newRefreshToken = await signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    };
  });

  // Apple Sign In (Phase 3)

  // ---- REST API: Email Verification Code Auth ----

  // Send email verification code
  app.post('/api/auth/email/send', async (req, reply) => {
    const { email } = req.body as any;
    if (!email) {
      reply.code(400); return { error: 'email is required' };
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
      reply.code(400); return { error: 'invalid email format' };
    }

    // Dev/test email shortcut: if DEV_EMAIL configured and matches, use fixed code (skip SES)
    // Works in any NODE_ENV — useful when SES unavailable (e.g. pre-ICP-filing)
    if (DEV_EMAIL && normalizedEmail === DEV_EMAIL.toLowerCase()) {
      if (hasPendingCode(normalizedEmail)) {
        reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
      }
      const devCode = DEV_EMAIL_CODE || '123456';
      storeCode(normalizedEmail, devCode, 5 * 60 * 1000);
      console.log(`[email] dev code for ${normalizedEmail}: ${devCode} (expires in 5m)`);
      return { success: true, message: 'verification code sent', code: devCode };
    }

    // Dev mode without DEV_EMAIL configured
    if (NODE_ENV !== 'production' && !DEV_EMAIL) {
      reply.code(400);
      return { error: '开发模式邮箱登录未配置，请设置 DEV_EMAIL 和 DEV_EMAIL_CODE 环境变量' };
    }

    // Rate limit: prevent rapid re-send
    if (hasPendingCode(normalizedEmail)) {
      reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
    }

    // Generate and store 6-digit code
    const code = generateCode();
    const expireMinutes = NODE_ENV === 'production' ? 1 : 5;
    storeCode(normalizedEmail, code, expireMinutes * 60 * 1000);
    console.log(`[email] code for ${normalizedEmail}: ${code} (expires in ${expireMinutes}m)`);

    // Send via Tencent Cloud SES (production) or return code in dev
    if (NODE_ENV === 'production') {
      try {
        await sendEmailCode(normalizedEmail, code);
      } catch (err: any) {
        console.error(`[email] send failed for ${normalizedEmail}:`, err.message);
        reply.code(500);
        return { error: '验证码发送失败，请稍后重试' };
      }
      return { success: true, message: 'verification code sent' };
    }

    // Dev mode: return code in response for testing
    return { success: true, message: 'verification code sent', code };
  });

  // Verify email code and login/register
  app.post('/api/auth/email/verify', async (req, reply) => {
    const { email, code } = req.body as any;
    if (!email || !code) {
      reply.code(400); return { error: 'email and code are required' };
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!verifyCode(normalizedEmail, code)) {
      reply.code(400); return { error: 'invalid or expired verification code' };
    }
    // Find or create user by email
    let user = await getUserByEmail(pool, normalizedEmail);
    if (!user) {
      // Create new user (email-only, no phone, no password)
      const displayName = normalizedEmail.split('@')[0];
      try {
        user = await createUser(pool, normalizedEmail, '', displayName);
      } catch (e: any) {
        reply.code(500); return { error: '创建用户失败' };
      }
    }
    const accessToken = await signAccessToken(user.id, user.email, user.phone);
    const refreshToken = await signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, phone: user.phone, display_name: user.display_name },
    };
  });
  app.post('/api/auth/apple/signin', async (req, reply) => {
    const { identityToken } = req.body as any;
    if (!identityToken) {
      reply.code(400); return { error: 'identityToken is required' };
    }
    // TODO: Verify Apple identity token with Apple's public keys
    // For now, return a placeholder error
    reply.code(501); return { error: 'Apple Sign In not yet implemented' };
  });

  // ---- REST API: Device Registration (Phase 3) ----

  // Register device for push notifications
  app.post('/api/devices/register', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { deviceToken, platform, deviceName } = req.body as any;
    if (!deviceToken) {
      reply.code(400); return { error: 'deviceToken is required' };
    }
    await registerDevice(pool, payload.userId, deviceToken, platform || 'ios', deviceName);
    return { success: true };
  });

  // Unregister device
  app.delete('/api/devices/:token', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { token } = req.params as any;
    await removeDevice(pool, token);
    return { success: true };
  });

  // Set daemon alias
  app.put('/api/daemons/:daemonId/alias', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { daemonId } = req.params as any;
    const { alias } = req.body as any;
    const result = await upsertDaemonAlias(pool, payload.userId, daemonId, alias ?? null);
    if (result === undefined) {
      reply.code(403); return { error: 'daemon not found or not owned by user' };
    }
    return { success: true, alias: result };
  });

  // Force-kick a daemon (requires email re-verification)
  app.post('/api/daemons/:daemonId/forceKick', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }

    const { daemonId } = req.params as any;

    // Rate limit: max 3 force-kicks per user per hour
    const rateLimitResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE user_id = $1 AND action = 'force_kick' AND created_at > NOW() - INTERVAL '1 hour'`,
      [payload.userId]
    );
    const recentKicks = parseInt(rateLimitResult.rows[0]?.cnt || '0');
    if (recentKicks >= 3) {
      reply.code(429);
      return { error: '操作过于频繁，请 1 小时后再试' };
    }

    const result = await router.handleForceKick(daemonId, payload.userId);
    if (!result.success) {
      reply.code(result.error === 'forbidden' ? 403 : 404);
      return { error: result.error || 'failed to kick daemon' };
    }

    await insertAuditLog(pool, payload.userId, 'force_kick', {
      daemon_id: daemonId,
    }, req.ip);

    return { success: true };
  });

  // ---- Token Usage Tracking ----

  // User-level token usage summary: total / today / thisWeek / thisMonth
  app.get('/api/tokens/summary', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    return await getTokenSummary(pool, payload.userId);
  });

  // Daemon-level token usage: total / today / thisMonth + per-session breakdown
  app.get('/api/tokens/by-daemon/:daemonId', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { daemonId } = req.params as any;
    const data = await getTokensByDaemon(pool, payload.userId, daemonId);
    if (!data) { reply.code(404); return { error: 'daemon not found or not owned' }; }
    return data;
  });

  // Unregister (delete) a daemon — sessions preserved with daemon_id nulled (C4)
  app.delete('/api/daemons/:daemonId', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { daemonId } = req.params as any;
    const ok = await deleteDaemon(pool, payload.userId, daemonId);
    if (!ok) { reply.code(404); return { error: 'daemon not found or not owned' }; }
    // Notify same-user clients to remove the daemon from their list
    router.broadcastToUser(payload.userId, { type: 'daemon_status', daemon_id: daemonId, status: 'unregistered' });
    return { success: true };
  });

  // Upgrade agent on a daemon (C4c): web → relay → daemon `claude update`. Async, result via upgrade_result event.
  app.post('/api/daemons/:daemonId/upgrade-agent', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { daemonId } = req.params as any;
    const { agent } = (req.body as any) || {};
    const result = await router.handleUpgrade(daemonId, payload.userId, agent);
    if (!result.success) {
      reply.code(result.error === 'forbidden' ? 403 : 400);
      return { error: result.error || 'failed' };
    }
    return { success: true };
  });

  // ---- Session Actions (REST) ----

  // Rename session
  app.put('/api/sessions/:sessionId/title', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { sessionId } = req.params as any;
    const { title } = req.body as any;
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      reply.code(400); return { error: 'title is required' };
    }
    const cleanTitle = title.trim().slice(0, 60);
    const ok = await updateSessionTitle(pool, payload.userId, sessionId, cleanTitle);
    if (!ok) { reply.code(404); return { error: 'session not found or not owned' }; }
    // Broadcast title update to same-user clients
    router.broadcastToUser(payload.userId, { type: 'session_title_update', session_id: sessionId, title: cleanTitle });
    return { success: true, title: cleanTitle };
  });

  // Export session record
  app.get('/api/sessions/:sessionId/export', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { sessionId } = req.params as any;
    const format = ((req.query as any).format || 'md') as string;
    const owned = await isSessionOwnedByUser(pool, payload.userId, sessionId);
    if (!owned) { reply.code(404); return { error: 'session not found or not owned' }; }

    const events = await getSessionAllEvents(pool, sessionId);
    const sessRow = await pool.query('SELECT title, agent_type, created_at FROM sessions WHERE session_id = $1', [sessionId]);
    const rawTitle = sessRow.rows[0]?.title || sessionId.slice(0, 8);
    // ASCII-safe filename (fallback) + RFC 5987 for unicode
    const asciiName = rawTitle.replace(/[^\w\-]/g, '_').slice(0, 40) || 'session';
    const utf8Name = encodeURIComponent(rawTitle);
    const makeDisposition = (ext: string) => `attachment; filename="${asciiName}.${ext}"; filename*=UTF-8''${utf8Name}.${ext}`;

    if (format === 'json') {
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', makeDisposition('json'));
      return { session_id: sessionId, title: sessRow.rows[0]?.title || '', exported_at: new Date().toISOString(), events: events.map(e => e.payload) };
    }

    // Build markdown / text
    const lines: string[] = [];
    if (format === 'md') {
      lines.push(`# ${sessRow.rows[0]?.title || sessionId.slice(0, 8)}`);
      lines.push('');
    }
    for (const e of events) {
      const p = e.payload;
      if (p.type === 'user_text' || p.type === 'user_message') {
        lines.push(format === 'md' ? `## 👤 User` : '[User]');
        lines.push(p.text || p.content || '');
        lines.push('');
      } else if (p.type === 'agent_text') {
        lines.push(format === 'md' ? `## 🤖 Assistant` : '[Assistant]');
        lines.push(p.text || '');
        lines.push('');
      } else if (p.type === 'tool_call') {
        const toolName = p.tool || 'tool';
        lines.push(format === 'md' ? `<details><summary>🔧 ${toolName}</summary>` : `[Tool: ${toolName}]`);
        if (p.input) lines.push('```json\n' + JSON.stringify(p.input, null, 2) + '\n```');
        if (format === 'md') lines.push('</details>');
        lines.push('');
      } else if (p.type === 'tool_result') {
        const out = (p.output || '').slice(0, 2000);
        if (out) lines.push(format === 'md' ? `<details><summary>📋 Result</summary>\n\n\`\`\`\n${out}\n\`\`\`\n</details>` : `[Result] ${out.slice(0, 200)}`);
        lines.push('');
      }
    }
    const content = lines.join('\n');
    const ext = format === 'md' ? 'md' : 'txt';
    reply.header('Content-Type', format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', makeDisposition(ext));
    return content;
  });

  // Update user display name
  app.put('/api/user/profile', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { display_name } = req.body as any;
    if (!display_name || typeof display_name !== 'string' || display_name.trim().length === 0) {
      reply.code(400); return { error: 'display_name is required' };
    }
    await updateDisplayName(pool, payload.userId, display_name.trim().slice(0, 100));
    return { success: true };
  });

  // Bind email to user account
  app.put('/api/user/email', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { email } = req.body as any;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      reply.code(400); return { error: 'valid email is required' };
    }
    try {
      await updateEmail(pool, payload.userId, email.trim().toLowerCase());
      return { success: true };
    } catch (err: any) {
      if (err.code === '23505') {
        reply.code(409); return { error: '该邮箱已被其他账号绑定' };
      }
      throw err;
    }
  });

  // ---- iOS Waitlist (with anti-abuse) ----

  // Rate limiter: per-IP (max 5 per hour) + global (max 50 per hour)
  const waitlistIPLimiter = new Map<string, { count: number; resetAt: number }>();
  const WAITLIST_IP_MAX = 5;
  const WAITLIST_IP_WINDOW = 60 * 60 * 1000; // 1 hour
  let waitlistGlobalCount = 0;
  let waitlistGlobalResetAt = Date.now() + 60 * 60 * 1000;

  app.post('/api/waitlist/ios', async (req, reply) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    // Global rate limit
    if (now > waitlistGlobalResetAt) {
      waitlistGlobalCount = 0;
      waitlistGlobalResetAt = now + 60 * 60 * 1000;
    }
    if (waitlistGlobalCount >= 50) {
      reply.code(429); return { error: '提交过于频繁，请稍后再试' };
    }

    // Per-IP rate limit
    let entry = waitlistIPLimiter.get(clientIp);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WAITLIST_IP_WINDOW };
      waitlistIPLimiter.set(clientIp, entry);
    }
    if (entry.count >= WAITLIST_IP_MAX) {
      reply.code(429); return { error: '提交次数过多，请 1 小时后再试' };
    }

    // Periodic cleanup of expired entries
    if (Math.random() < 0.05) {
      for (const [key, val] of waitlistIPLimiter) {
        if (now > val.resetAt) waitlistIPLimiter.delete(key);
      }
    }

    const { email } = req.body as any;
    if (!email) {
      reply.code(400); return { error: 'email is required' };
    }

    // Email format validation
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.includes('@') || normalizedEmail.length > 254) {
      reply.code(400); return { error: '无效的邮箱地址' };
    }
    const emailParts = normalizedEmail.split('@');
    if (emailParts.length !== 2 || !emailParts[0] || !emailParts[1].includes('.')) {
      reply.code(400); return { error: '无效的邮箱地址' };
    }

    const result = await addToIOSWaitlist(pool, email);
    if (!result.inserted) {
      reply.code(400); return { error: result.message };
    }

    // Increment counters on successful submission
    entry.count++;
    waitlistGlobalCount++;

    return { success: true, message: result.message };
  });

  // ---- OAuth 2.0 Device Authorization Grant (RFC 8628) ----

  // Device Authorization Endpoint (§3.1)
  app.post('/api/auth/device/authorize', async (req, reply) => {
    const { client_id, scope, code_challenge, code_challenge_method, machine_id } = req.body as any;

    // Validate client
    if (!client_id) {
      reply.code(400);
      return { error: 'invalid_request', error_description: 'client_id is required' };
    }
    const client = validateClient(client_id);
    if (!client) {
      reply.code(400);
      return { error: 'invalid_client', error_description: 'Unknown client_id' };
    }
    // Public clients MUST use PKCE
    if (client.token_endpoint_auth_method === 'none') {
      if (!code_challenge) {
        reply.code(400);
        return { error: 'invalid_request', error_description: 'code_challenge is required for public clients' };
      }
      if (code_challenge_method && code_challenge_method !== 'S256') {
        reply.code(400);
        return { error: 'invalid_request', error_description: 'only S256 code_challenge_method is supported' };
      }
    }

    const result = createSession(client_id, code_challenge, machine_id);
    // Use WEB_APP_URL env var for the verification URI, fallback to relay host
    const webAppUrl = process.env.WEB_APP_URL || `http://${req.hostname}:${PORT}`;
    const verificationUri = `${webAppUrl}/login/cli`;
    reply.code(200);
    return {
      device_code: result.device_code,
      user_code: result.user_code,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${result.user_code}`,
      expires_in: result.expires_in,
      interval: result.interval,
    };
  });

  // User Code Confirmation Endpoint (browser submits the user_code)
  app.post('/api/auth/device/confirm', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401);
      return { error: 'authentication_required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401);
      return { error: 'invalid_token' };
    }

    const { user_code } = req.body as any;
    if (!user_code) {
      reply.code(400);
      return { error: 'invalid_request', error_description: 'user_code is required' };
    }

    const ok = authorizeSession(user_code, payload.userId);
    if (!ok) {
      reply.code(400);
      return { error: 'invalid_user_code', error_description: 'user_code is invalid or expired' };
    }

    insertAuditLog(pool, payload.userId, 'device_authorize', {
      user_code,
      client_id: 'pocketctl-cli',
    }, req.ip).catch(console.error);

    return { success: true };
  });

  // Device Access Token Endpoint (§3.4)
  app.post('/api/auth/device/token', async (req, reply) => {
    const { grant_type, device_code, client_id, code_verifier } = req.body as any;

    if (grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
      reply.code(400);
      return { error: 'unsupported_grant_type' };
    }
    if (!device_code || !client_id) {
      reply.code(400);
      return { error: 'invalid_request' };
    }

    // Validate client
    const client = validateClient(client_id);
    if (!client) {
      reply.code(400);
      return { error: 'invalid_client' };
    }

    // Rate limiting: check polling interval
    if (!canPoll(device_code, 5)) {
      reply.code(400);
      return { error: 'slow_down' };
    }

    const session = getSessionByDeviceCode(device_code);
    if (!session) {
      reply.code(400);
      return { error: 'expired_token', error_description: 'device_code has expired' };
    }

    if (session.status === 'pending') {
      reply.code(400);
      return { error: 'authorization_pending' };
    }

    // Verify PKCE
    if (client.token_endpoint_auth_method === 'none') {
      if (!code_verifier) {
        reply.code(400);
        return { error: 'invalid_grant', error_description: 'code_verifier is required' };
      }
      const expectedChallenge = session.code_challenge;
      const actualChallenge = createHash('sha256')
        .update(code_verifier)
        .digest('base64url');
      if (actualChallenge !== expectedChallenge) {
        reply.code(400);
        return { error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' };
      }
    }

    // Issue tokens
    const user = await getUserById(pool, session.user_id!);
    if (!user) {
      reply.code(500);
      return { error: 'server_error', error_description: 'user not found' };
    }

    const machineId = session.machine_id || 'unknown';
    const accessToken = await signAccessToken(user.id, user.email, user.phone, machineId);
    const refreshToken = await signRefreshToken(user.id);

    // Clean up the session
    deleteSession(device_code);

    insertAuditLog(pool, user.id, 'token_issued', {
      client_id,
      machine_id: machineId,
      grant_type: 'device_code',
    }, req.ip).catch(console.error);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 86400,
    };
  });

  // Token Revocation Endpoint (RFC 7009)
  app.post('/api/auth/revoke', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401);
      return { error: 'authorization required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401);
      return { error: 'invalid token' };
    }

    const { token, token_type_hint } = req.body as any;
    if (!token) {
      reply.code(400);
      return { error: 'invalid_request', error_description: 'token is required' };
    }

    // Extract jti from the submitted token (without verifying expiry)
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const rawPayload = Buffer.from(parts[1], 'base64url').toString('utf8');
        const claims = JSON.parse(rawPayload);
        const jti = claims.jti;
        const tokenUserId = claims.userId;

        // Only allow revoking own tokens
        if (tokenUserId && tokenUserId !== payload.userId) {
          reply.code(403);
          return { error: 'forbidden', error_description: 'cannot revoke another user\'s token' };
        }

        if (jti) {
          await revokeToken(pool, jti, payload.userId, 'user_revoke');
          await insertAuditLog(pool, payload.userId, 'token_revoke', {
            jti,
            token_type_hint: token_type_hint || 'unknown',
          }, req.ip);
        }
      }
    } catch {
      // Token parse error — still return 200 per RFC 7009
    }

    reply.code(200);
    return {};
  });

  // ---- QR Scan-Login (web displays QR → iOS scans → iOS confirms → web polls for token) ----

  // Web creates a QR login session and renders the QR payload
  app.post('/api/auth/qr/create', async (req, reply) => {
    const result = createQrSession();
    const webAppUrl = process.env.WEB_APP_URL || `http://${req.hostname}:${PORT}`;
    // Payload written into the QR: a URL the iOS scanner parses to extract qr_token.
    const qr_payload = `${webAppUrl}/login/qr?token=${result.qr_token}`;
    reply.code(200);
    return {
      qr_token: result.qr_token,
      qr_payload,
      expires_in: result.expires_in,
      interval: 2,
    };
  });

  // Web polls the status of a QR login session
  app.get('/api/auth/qr/status', async (req, reply) => {
    const { qr_token } = req.query as any;
    if (!qr_token) {
      reply.code(400); return { error: 'qr_token is required' };
    }
    const session = getQrSession(qr_token);
    if (!session) {
      reply.code(200);
      return { status: 'expired' as const };
    }

    // Once confirmed, issue JWTs and consume the session.
    if (session.status === 'confirmed' && session.user_id != null) {
      const user = await getUserById(pool, session.user_id);
      deleteQrSession(qr_token); // single-use
      if (!user) {
        reply.code(200);
        return { status: 'expired' as const };
      }
      const accessToken = await signAccessToken(user.id, user.email, user.phone, 'web-qr');
      const refreshToken = await signRefreshToken(user.id);
      insertAuditLog(pool, user.id, 'qr_login_issued', { via: 'web-qr' }, req.ip).catch(console.error);
      reply.code(200);
      return {
        status: 'confirmed' as const,
        access_token: accessToken,
        refresh_token: refreshToken,
        user: { id: user.id, email: user.email, phone: user.phone, display_name: user.display_name },
      };
    }

    reply.code(200);
    return { status: session.status };
  });

  // iOS (an already-authenticated device) confirms a QR login session
  app.post('/api/auth/qr/confirm', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authentication_required' };
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      reply.code(401); return { error: 'invalid_token' };
    }

    const { qr_token } = req.body as any;
    if (!qr_token) {
      reply.code(400); return { error: 'qr_token is required' };
    }

    const ok = confirmQrSession(qr_token, payload.userId);
    if (!ok) {
      reply.code(400); return { error: 'invalid_or_expired_qr_token' };
    }

    insertAuditLog(pool, payload.userId, 'qr_login_confirm', { via: 'ios-scan' }, req.ip).catch(console.error);
    return { success: true };
  });

  // Device Authorization Page (served by relay, self-contained HTML)
  app.get('/login/cli', async (req, reply) => {
    const userCode = (req.query as any).code || '';
    const relayBaseUrl = `http://${req.hostname}:${PORT}`;
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return deviceAuthPage(userCode, relayBaseUrl);
  });

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', async (req) => {
    const baseUrl = `http://${req.hostname}:${PORT}`;
    return {
      issuer: baseUrl,
      device_authorization_endpoint: `${baseUrl}/api/auth/device/authorize`,
      token_endpoint: `${baseUrl}/api/auth/device/token`,
      revocation_endpoint: `${baseUrl}/api/auth/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
      response_types_supported: ['token'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  });

  // Restart daemon (remote control)
  app.post('/api/daemons/:daemonId/restart', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { daemonId } = req.params as any;
    const daemon = (router as any).daemons.get(daemonId);
    if (!daemon || daemon.ws.readyState !== 1 || !(router as any).sameUser(daemon.userId, payload.userId)) {
      reply.code(404); return { error: 'daemon not found or offline' };
    }
    router['send'](daemon.ws, { type: 'daemon_restart' });
    return { success: true };
  });

  // ---- Health check ----

  app.get('/health', async () => {
    try { await pool.query('SELECT 1'); return { status: 'ok', version: process.env.npm_package_version || 'dev' }; }
    catch { return { status: 'degraded', error: 'db unreachable' }; }
  });

  // ---- WebSocket endpoint ----

  app.get('/ws', { websocket: true }, (socket, req) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    if (!checkRateLimit(clientIp)) {
      socket.close(4029, 'rate limit exceeded');
      return;
    }

    const query = req.query as any;
    const token = query.token as string;
    const apiKey = query.api_key as string;
    const connType = query.type as string;

    // Buffer early messages until auth completes
    const earlyMessages: Buffer[] = [];
    let authDone = false;
    let userId: number | null = null;
    let tokenJti: string | undefined;
    let tokenMachineId: string | undefined;

    // Register message listener BEFORE async auth (avoid race condition)
    socket.on('message', (raw: Buffer) => {
      // debug log removed
      if (!authDone) {
        earlyMessages.push(raw);
        // debug log removed
        return;
      }
      processMessage(raw);
    });

    socket.on('close', () => {
      if (connType === 'daemon') {
        const daemonId = wsDaemonMap.get(socket);
        if (daemonId) { router.unregisterDaemon(daemonId); wsDaemonMap.delete(socket); }
      } else {
        router.unregisterClient(socket);
      }
      console.log(`WS disconnected: type=${connType} ip=${clientIp}`);
    });

    function processMessage(raw: Buffer) {
      if (raw.length > MAX_WS_MESSAGE_SIZE) {
        socket.close(4003, 'message too large');
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());
        // debug log removed
        if (connType === 'daemon') {
          if (msg.type === 'register') {
            router.registerDaemon(socket, msg, userId, tokenJti, tokenMachineId);
            wsDaemonMap.set(socket, msg.daemon_id);
            console.log('[ws] daemon registered, total in map:', wsDaemonMap.size);
          } else {
            const daemonId = wsDaemonMap.get(socket);
            if (daemonId) {
              router.handleDaemonMessage(daemonId, msg);
            }
            else console.log('[ws] message for unknown daemon, type:', msg.type);
          }
        } else {
          router.registerClient(socket, userId);
          router.handleClientMessage(socket, msg);
        }
      } catch (err) {
        console.error(`message parse error from ${clientIp}:`, (err as Error).message);
      }
    }

    // Async auth + flush buffered messages
    (async () => {
      if (token) {
        const payload = await verifyAccessTokenWithRevocation(token, pool);
        if (!payload) {
          socket.close(4001, 'invalid token');
          return;
        }
        userId = payload.userId;
        tokenJti = payload.jti;
        tokenMachineId = payload.machine_id;
      } else if (apiKey && API_KEY && apiKey === API_KEY) {
        userId = null;
      } else {
        socket.close(4001, 'authentication required');
        return;
      }

      authDone = true;
      console.log(`WS connected: type=${connType} ip=${clientIp} user=${userId || 'legacy'}`);

      // Process any messages that arrived during auth
      for (const raw of earlyMessages) {
        processMessage(raw);
      }
      earlyMessages.length = 0;
    })().catch((err) => {
      console.error(`ws auth error from ${clientIp}:`, err.message);
      socket.close(4011, 'internal error');
    });
  });

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`pocketctl relay listening on port ${PORT} [${NODE_ENV}]`);
  } catch (err) { console.error('failed to start:', err); process.exit(1); }

  // Periodic cleanup: remove tombstones older than 30 days (every 6 hours)
  setInterval(async () => {
    try {
      const tombstoneCount = await cleanStaleTombstones(pool);
      const { accessPurged, refreshPurged } = await cleanRevokedTokens(pool);
      const totalPurged = tombstoneCount + accessPurged + refreshPurged;
      if (totalPurged > 0) console.log(`[cleanup] removed ${tombstoneCount} tombstones, ${accessPurged} access tokens, ${refreshPurged} refresh tokens`);
    } catch (err) { console.error('[cleanup] cleanup error:', (err as Error).message); }
  }, 6 * 60 * 60 * 1000);
}

// ---- Device Auth Page (self-contained HTML) ----

function deviceAuthPage(userCode: string, relayBaseUrl: string): string {
  const escapedCode = userCode.replace(/[<>&"']/g, '');
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pocketctl — 设备授权</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --fg: #e6edf3; --fg-secondary: #8b949e; --fg-tertiary: #6e7681;
    --accent: #58a6ff; --accent-muted: rgba(88,166,255,0.1);
    --primary-btn: #238636; --primary-btn-hover: #2ea043;
    --error: #f85149; --error-bg: rgba(248,81,73,0.1);
    --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px;
    --font-mono: 'SF Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, sans-serif; }
  .page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .container { width: 100%; max-width: 420px; }
  .brand { text-align: center; margin-bottom: 32px; }
  .brand-name { font-size: 28px; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
  .brand-tagline { font-size: 15px; color: var(--fg-secondary); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 32px; }
  .card-title { font-size: 20px; font-weight: 600; text-align: center; margin-bottom: 20px; }
  .code-display { display: flex; flex-direction: column; align-items: center; margin: 16px 0; padding: 16px; background: var(--bg); border-radius: var(--radius-lg); border: 1px dashed var(--border); }
  .code-label { font-size: 12px; color: var(--fg-tertiary); margin-bottom: 4px; }
  .code-value { font-family: var(--font-mono); font-size: 28px; font-weight: 700; color: var(--accent); letter-spacing: 6px; }
  .form-group { margin-bottom: 14px; }
  .form-label { font-size: 13px; font-weight: 500; color: var(--fg-secondary); margin-bottom: 6px; display: block; }
  .input { width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); font-size: 14px; outline: none; }
  .input:focus { border-color: var(--accent); }
  .code-row { display: flex; gap: 8px; }
  .code-row .input { flex: 1; font-family: var(--font-mono); letter-spacing: 4px; text-align: center; font-size: 18px !important; }
  .btn { width: 100%; padding: 12px; border: none; border-radius: var(--radius-md); font-size: 15px; font-weight: 600; cursor: pointer; }
  .btn-primary { background: var(--primary-btn); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--primary-btn-hover); }
  .btn-secondary { background: none; border: 1px solid var(--border); color: var(--accent); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .get-code-btn { white-space: nowrap; padding: 10px 14px; background: none; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--accent); font-size: 13px; cursor: pointer; flex-shrink: 0; }
  .get-code-btn:disabled { color: var(--fg-tertiary); cursor: not-allowed; }
  .error { display: none; align-items: center; gap: 8px; padding: 10px 14px; border-radius: var(--radius-md); background: var(--error-bg); color: var(--error); font-size: 13px; margin-bottom: 14px; }
  .error.show { display: flex; }
  .success-icon { text-align: center; font-size: 48px; margin: 16px 0; }
  .mt-12 { margin-top: 12px; }
  .mt-16 { margin-top: 16px; }
  .info-text { font-size: 13px; color: var(--fg-secondary); text-align: center; }
  .user-info { text-align: center; color: var(--fg-secondary); font-size: 13px; margin: 12px 0; }
  .user-info strong { color: var(--fg); }
</style>
</head>
<body>
<div class="page">
  <div class="container">
    <div class="brand">
      <div class="brand-name">pocketctl</div>
      <div class="brand-tagline">设备授权</div>
    </div>

    <div class="card">
      <div class="card-title" id="title">pocketctl CLI 正在请求访问权限</div>

      <div id="error-banner" class="error">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4h1.5v5h-1.5V5zm.75 6.5a.75.75 0 110-1.5.75.75 0 010 1.5z"/></svg>
        <span id="error-text"></span>
      </div>

      <div class="code-display" id="code-display" style="display:none">
        <span class="code-label">授权码</span>
        <span class="code-value" id="user-code">${escapedCode || '------'}</span>
      </div>

      <!-- Step 1: Login -->
      <div id="step-login">
        <p class="info-text">请先登录你的账户，然后授权 CLI 设备访问</p>
        <div class="form-group mt-16">
          <label class="form-label">邮箱地址</label>
          <input type="email" class="input" id="email" placeholder="请输入邮箱地址" />
        </div>
        <div class="form-group">
          <label class="form-label">验证码</label>
          <div class="code-row">
            <input type="text" class="input" id="code" placeholder="6 位验证码" maxlength="6" />
            <button class="get-code-btn" id="send-code-btn" onclick="sendCode()">获取验证码</button>
          </div>
        </div>
        <button class="btn btn-primary" id="login-btn" onclick="doLogin()">登录并授权</button>
      </div>

      <!-- Step 2: Authorized -->
      <div id="step-authorized" style="display:none;">
        <div class="success-icon">✅</div>
        <p class="info-text">pocketctl CLI 已获得访问权限。<br/>你可以关闭此页面。</p>
      </div>

      <!-- Step 3: Already logged in -->
      <div id="step-already-logged-in" style="display:none;">
        <p class="user-info" id="logged-in-info"></p>
        <button class="btn btn-primary" id="auth-btn" onclick="confirmAuth()">授权此设备</button>
      </div>

      <!-- Step 4: Invalid code -->
      <div id="step-invalid" style="display:none;">
        <p class="info-text">此授权码已过期或无效。<br/>请在命令行重新运行 <code style="background:var(--bg);padding:2px 6px;border-radius:4px;">pocketctl login</code></p>
      </div>
    </div>
  </div>
</div>

<script>
const RELAY = '';
const USER_CODE = '${escapedCode}';
let countdown = 0, timer = null, accessToken = '', userEmail = '';
let emailInput, codeInput, errorBanner, errorText, sendCodeBtn, loginBtn;

function showError(msg) {
  errorBanner.classList.add('show');
  errorText.textContent = msg;
}
function hideError() { errorBanner.classList.remove('show'); }
function setLoading(btn, loading, text) {
  btn.disabled = loading;
  btn.textContent = loading ? text + '...' : text;
}

async function api(path, body, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
  const res = await fetch(RELAY + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json() };
}

async function sendCode() {
  hideError();
  const email = emailInput.value.trim();
  if (!email.includes('@')) { showError('请输入有效的邮箱地址'); return; }
  const { ok, data } = await api('/api/auth/email/send', { email });
  if (!ok) { showError(data.error || '发送失败'); return; }
  countdown = 60;
  sendCodeBtn.disabled = true;
  timer = setInterval(() => {
    countdown--;
    sendCodeBtn.textContent = countdown + 's 后重发';
    if (countdown <= 0) { clearInterval(timer); sendCodeBtn.disabled = false; sendCodeBtn.textContent = '获取验证码'; }
  }, 1000);
}

async function doLogin() {
  hideError();
  const email = emailInput.value.trim();
  const code = codeInput.value.trim();
  if (!email.includes('@')) { showError('请输入有效的邮箱地址'); return; }
  if (code.length !== 6) { showError('请输入6位验证码'); return; }
  setLoading(loginBtn, true, '登录中');
  const { ok, data } = await api('/api/auth/email/verify', { email, code });
  if (!ok) { setLoading(loginBtn, false, '登录并授权'); showError(data.error || '验证失败'); return; }
  accessToken = data.access_token;
  userEmail = data.user.email;
  localStorage.setItem('pocketctl_access_token', data.access_token);
  localStorage.setItem('pocketctl_refresh_token', data.refresh_token);
  localStorage.setItem('pocketctl_user', JSON.stringify(data.user));
  setLoading(loginBtn, false, '登录并授权');
  await confirmAuth();
}

async function confirmAuth() {
  hideError();
  const btn = document.getElementById('auth-btn');
  if (btn) setLoading(btn, true, '授权中');
  const { ok, data } = await api('/api/auth/device/confirm', { user_code: USER_CODE }, true);
  if (btn) setLoading(btn, false, '授权此设备');
  if (!ok) {
    if (data.error === 'invalid_user_code') {
      document.querySelectorAll('[id^="step-"]').forEach(el => el.style.display = 'none');
      document.getElementById('step-invalid').style.display = 'block';
      return;
    }
    showError(data.error_description || data.error || '授权失败');
    return;
  }
  document.querySelectorAll('[id^="step-"]').forEach(el => el.style.display = 'none');
  document.getElementById('step-authorized').style.display = 'block';
  document.getElementById('title').textContent = '✅ 授权成功';
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  emailInput = document.getElementById('email');
  codeInput = document.getElementById('code');
  errorBanner = document.getElementById('error-banner');
  errorText = document.getElementById('error-text');
  sendCodeBtn = document.getElementById('send-code-btn');
  loginBtn = document.getElementById('login-btn');

  codeInput.addEventListener('input', (e) => {
    codeInput.value = e.target.value.replace(/\\D/g, '').slice(0, 6);
  });

  if (!USER_CODE) {
    document.querySelectorAll('[id^="step-"]').forEach(el => el.style.display = 'none');
    document.getElementById('step-invalid').style.display = 'block';
    document.getElementById('title').textContent = '授权码无效';
    return;
  }

  // Check if already logged in
  const savedToken = localStorage.getItem('pocketctl_access_token');
  const savedUser = localStorage.getItem('pocketctl_user');
  if (savedToken && savedUser) {
    try {
      const user = JSON.parse(savedUser);
      accessToken = savedToken;
      userEmail = user.email;
      document.getElementById('step-login').style.display = 'none';
      document.getElementById('step-already-logged-in').style.display = 'block';
      document.getElementById('logged-in-info').innerHTML = '已登录: <strong>' + (user.email || user.phone || '未知') + '</strong>';
    } catch(e) {}
  }
});
</script>
</body>
</html>`;
}

main();
