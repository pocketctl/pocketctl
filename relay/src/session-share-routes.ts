import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import {
  signSessionShareToken as defaultSignSessionShareToken,
  verifyAccessTokenWithRevocation as defaultVerifyAccessToken,
  verifySessionShareToken as defaultVerifySessionShareToken,
} from './auth.js';
import {
  getSessionAllEvents as defaultGetSessionAllEvents,
  isSessionOwnedByUser as defaultIsSessionOwnedByUser,
} from './db.js';

const SHARE_DURATION_MS = 15 * 60 * 1000;
const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface SessionShareRouteDependencies {
  pool: Pool;
  publicIssuer: string;
  verifyAccessToken?: typeof defaultVerifyAccessToken;
  isSessionOwnedByUser?: typeof defaultIsSessionOwnedByUser;
  getSessionAllEvents?: typeof defaultGetSessionAllEvents;
  signSessionShareToken?: typeof defaultSignSessionShareToken;
  verifySessionShareToken?: typeof defaultVerifySessionShareToken;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setViewerHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, private');
  reply.header('Pragma', 'no-cache');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', SHARE_CSP);
  reply.type('text/html; charset=utf-8');
}

function unavailablePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>分享链接不可用 · PocketCtl</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0d1117; color: #e6edf3; }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
    p { color: #8b949e; line-height: 1.6; }
  </style>
</head>
<body><main><h1>分享链接不可用</h1><p>链接可能已过期、被修改，或对应会话已不可访问。</p></main></body>
</html>`;
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    const serialized = JSON.stringify(payload, null, 2);
    return serialized ?? String(payload);
  } catch {
    return String(payload);
  }
}

function shareViewerPage(events: any[]): string {
  const renderedEvents = events.map((event, index) => {
    const eventType = escapeHtml(String(event?.event_type ?? event?.payload?.type ?? 'event'));
    const createdAt = escapeHtml(String(event?.created_at ?? ''));
    const payload = escapeHtml(payloadText(event?.payload));
    return `<article class="event">
      <header><span>${index + 1}. ${eventType}</span><time>${createdAt}</time></header>
      <pre>${payload}</pre>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>共享会话 · PocketCtl</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0d1117; color: #e6edf3; }
    main { width: min(100% - 2rem, 900px); margin: 0 auto; padding: 2.5rem 0 4rem; }
    .intro { margin-bottom: 1.5rem; color: #8b949e; line-height: 1.6; }
    .event { margin: 0 0 1rem; overflow: hidden; border: 1px solid #30363d; border-radius: 12px; background: #161b22; }
    .event header { display: flex; justify-content: space-between; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid #21262d; color: #8b949e; font-size: .8rem; }
    pre { margin: 0; padding: 1rem; overflow-wrap: anywhere; white-space: pre-wrap; color: #e6edf3; font: .8rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>共享会话</h1>
    <p class="intro">这是一个临时、只读的完整会话快照。页面不提供登录或控制能力。</p>
    ${renderedEvents || '<p class="intro">当前没有可显示的会话事件。</p>'}
  </main>
</body>
</html>`;
}

export function registerSessionShareRoutes(
  app: FastifyInstance,
  dependencies: SessionShareRouteDependencies,
): void {
  const publicIssuer = new URL(dependencies.publicIssuer).toString().replace(/\/$/, '');
  const verifyAccessToken = dependencies.verifyAccessToken ?? defaultVerifyAccessToken;
  const isSessionOwnedByUser = dependencies.isSessionOwnedByUser ?? defaultIsSessionOwnedByUser;
  const getSessionAllEvents = dependencies.getSessionAllEvents ?? defaultGetSessionAllEvents;
  const signSessionShareToken = dependencies.signSessionShareToken ?? defaultSignSessionShareToken;
  const verifySessionShareToken = dependencies.verifySessionShareToken ?? defaultVerifySessionShareToken;

  app.post('/api/sessions/:sessionId/share-link', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401);
      return { error: 'authorization required' };
    }
    const access = await verifyAccessToken(authHeader.slice(7), dependencies.pool);
    if (!access) {
      reply.code(401);
      return { error: 'invalid token' };
    }
    const { sessionId } = req.params as { sessionId: string };
    const owned = await isSessionOwnedByUser(dependencies.pool, access.userId, sessionId);
    if (!owned) {
      reply.code(404);
      return { error: 'session not found or not owned' };
    }

    const token = signSessionShareToken(access.userId, sessionId);
    const url = `${publicIssuer}/share/session/${encodeURIComponent(token)}`;
    return {
      url,
      expires_at: new Date(Date.now() + SHARE_DURATION_MS).toISOString(),
    };
  });

  // Fastify's default maxParamLength is 100, while a signed JWT is longer.
  // A terminal wildcard keeps the public URL shape without widening global routing limits.
  app.get('/share/session/*', { logLevel: 'silent' }, async (req, reply) => {
    setViewerHeaders(reply);
    const unavailable = () => {
      reply.code(404);
      return unavailablePage();
    };
    const token = (req.params as { '*': string })['*'];
    const share = verifySessionShareToken(token);
    if (!share) return unavailable();

    try {
      const owned = await isSessionOwnedByUser(
        dependencies.pool,
        share.userId,
        share.sessionId,
      );
      if (!owned) return unavailable();
      const events = await getSessionAllEvents(dependencies.pool, share.sessionId);
      return shareViewerPage(events);
    } catch {
      return unavailable();
    }
  });
}
