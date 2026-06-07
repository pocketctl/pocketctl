import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { createPool, initDB, parseDBUrl, createUser, getUserByEmail, getUserById } from './db.js';
import { Router } from './router.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from './auth.js';

const API_KEY = process.env.POCKETCTL_API_KEY || '';
const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketctl';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const MAX_WS_MESSAGE_SIZE = parseInt(process.env.MAX_WS_MESSAGE_SIZE || '1048576', 10);
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
}

main();
