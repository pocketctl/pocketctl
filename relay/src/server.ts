import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { createPool, initDB, parseDBUrl, createUser, getUserByEmail, getUserById, getUserByPhone, createUserByPhone, registerDevice, removeDevice, cleanStaleTombstones, upsertDaemonAlias } from './db.js';
import { Router } from './router.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from './auth.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush } from './push.js';
import { sendSmsCode } from './config/sms.js';

const API_KEY = process.env.POCKETCTL_API_KEY || '';
const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketctl';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const MAX_WS_MESSAGE_SIZE = parseInt(process.env.MAX_WS_MESSAGE_SIZE || '1048576', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_CONNECTIONS = parseInt(process.env.RATE_LIMIT_MAX_CONNECTIONS || '30', 10);

const wsDaemonMap = new Map<any, string>();

// Dev-mode SMS verification code store: phone -> { code, expiresAt }
const smsCodeStore = new Map<string, { code: string; expiresAt: number }>();
const DEV_SMS_CODE = process.env.DEV_SMS_CODE || '';
const DEV_SMS_PHONE = process.env.DEV_SMS_PHONE || '';

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
    const accessToken = signAccessToken(user.id, user.email);
    const refreshToken = signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    };
  });

  // Login
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as any;
    if (!email || !password) {
      reply.code(400); return { error: 'email and password are required' };
    }
    const user = await getUserByEmail(pool, email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      reply.code(401); return { error: 'invalid email or password' };
    }
    const accessToken = signAccessToken(user.id, user.email);
    const refreshToken = signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    };
  });

  // Refresh token
  app.post('/api/auth/refresh', async (req, reply) => {
    const { refresh_token } = req.body as any;
    if (!refresh_token) {
      reply.code(400); return { error: 'refresh_token is required' };
    }
    const payload = verifyRefreshToken(refresh_token);
    if (!payload) {
      reply.code(401); return { error: 'invalid or expired refresh token' };
    }
    const user = await getUserById(pool, payload.userId);
    if (!user) {
      reply.code(401); return { error: 'user not found' };
    }
    const accessToken = signAccessToken(user.id, user.email);
    const newRefreshToken = signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    };
  });

  // ---- REST API: SMS Auth (Phase 3) ----

  // Send SMS verification code
  app.post('/api/auth/sms/send', async (req, reply) => {
    const { phone } = req.body as any;
    if (!phone) {
      reply.code(400); return { error: 'phone is required' };
    }
    // Normalize phone: remove spaces
    const normalizedPhone = phone.replace(/\s+/g, '');
    // Dev mode: only allow test phone number (if configured)
    if (NODE_ENV !== 'production' && DEV_SMS_PHONE) {
      if (normalizedPhone !== DEV_SMS_PHONE) {
        reply.code(400);
        return { error: `开发模式仅支持测试手机号 ${DEV_SMS_PHONE}` };
      }
    }
    if (NODE_ENV !== 'production' && !DEV_SMS_PHONE) {
      reply.code(400);
      return { error: '开发模式快捷登录未配置，请设置 DEV_SMS_PHONE 和 DEV_SMS_CODE 环境变量' };
    }
    // Generate 6-digit code
    const code = (NODE_ENV === 'production' || !DEV_SMS_CODE)
      ? String(Math.floor(100000 + Math.random() * 900000))
      : DEV_SMS_CODE;
    const expireMinutes = NODE_ENV === 'production' ? 1 : 5;
    const expiresAt = Date.now() + expireMinutes * 60 * 1000;
    smsCodeStore.set(normalizedPhone, { code, expiresAt });
    console.log(`[sms] code for ${normalizedPhone}: ${code} (expires in ${expireMinutes}m)`);

    // Production: send via Tencent Cloud SMS
    if (NODE_ENV === 'production') {
      try {
        await sendSmsCode(normalizedPhone, code);
      } catch (err: any) {
        console.error(`[sms] send failed for ${normalizedPhone}:`, err.message);
        reply.code(500);
        return { error: '验证码发送失败，请稍后重试' };
      }
      return { success: true, message: 'verification code sent' };
    }

    // Dev mode: return code in response for testing
    return { success: true, message: 'verification code sent', code };
  });

  // Verify SMS code and login/register
  app.post('/api/auth/sms/verify', async (req, reply) => {
    const { phone, code } = req.body as any;
    if (!phone || !code) {
      reply.code(400); return { error: 'phone and code are required' };
    }
    const normalizedPhone = phone.replace(/\s+/g, '');
    const stored = smsCodeStore.get(normalizedPhone);
    if (!stored || stored.code !== code || Date.now() > stored.expiresAt) {
      reply.code(400); return { error: 'invalid or expired verification code' };
    }
    smsCodeStore.delete(normalizedPhone);
    // Find or create user by phone
    let user = await getUserByPhone(pool, normalizedPhone);
    if (!user) {
      user = await createUserByPhone(pool, normalizedPhone);
    }
    const accessToken = signAccessToken(user.id, user.email, user.phone);
    const refreshToken = signRefreshToken(user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, phone: user.phone, display_name: user.display_name },
    };
  });

  // Apple Sign In (Phase 3)
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
    let userId: number | null = null;

    // Auth: try JWT token first, fall back to API key
    if (token) {
      const payload = verifyAccessToken(token);
      if (!payload) {
        socket.close(4001, 'invalid token');
        return;
      }
      userId = payload.userId;
    } else if (apiKey && API_KEY && apiKey === API_KEY) {
      // Legacy API key auth — no user isolation
      userId = null;
    } else {
      socket.close(4001, 'authentication required');
      return;
    }

    const connType = query.type as string;
    console.log(`WS connected: type=${connType} ip=${clientIp} user=${userId || 'legacy'}`);

    socket.on('message', (raw: Buffer) => {
      if (raw.length > MAX_WS_MESSAGE_SIZE) {
        socket.close(4003, 'message too large');
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());
        if (connType === 'daemon') {
          if (msg.type === 'register') {
            router.registerDaemon(socket, msg, userId);
            wsDaemonMap.set(socket, msg.daemon_id);
          } else {
            const daemonId = wsDaemonMap.get(socket);
            if (daemonId) router.handleDaemonMessage(daemonId, msg);
          }
        } else {
          router.registerClient(socket, userId);
          router.handleClientMessage(socket, msg);
        }
      } catch (err) {
        console.error(`message parse error from ${clientIp}:`, (err as Error).message);
      }
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
  });

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`pocketctl relay listening on port ${PORT} [${NODE_ENV}]`);
  } catch (err) { console.error('failed to start:', err); process.exit(1); }

  // Periodic cleanup: remove tombstones older than 30 days (every 6 hours)
  setInterval(async () => {
    try {
      const count = await cleanStaleTombstones(pool);
      if (count > 0) console.log(`[cleanup] removed ${count} stale tombstones`);
    } catch (err) { console.error('[cleanup] tombstone cleanup error:', (err as Error).message); }
  }, 6 * 60 * 60 * 1000);
}

main();
