import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { shareViewerPage, unavailablePage } from './session-share/render.js';
import { withSessionHistoryScope } from './session-history/postgres-reader.js';
import {
  signManagedSessionShareToken as defaultSignSessionShareToken,
  verifyAccessTokenWithRevocation as defaultVerifyAccessToken,
  verifyManagedSessionShareToken as defaultVerifySessionShareToken,
} from './auth.js';
import {
  getSessionAllEvents as defaultGetSessionAllEvents,
  isSessionOwnedByUser as defaultIsSessionOwnedByUser,
} from './db.js';

import { postgresShareStore, ShareConflict, ShareLimit, type ShareStore, type ShareRecord } from './session-share/store.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
interface SessionShareRouteDependencies {
  pool: Pool;
  publicIssuer: string;
  store?: ShareStore;
  verifyAccessToken?: typeof defaultVerifyAccessToken;
  isSessionOwnedByUser?: typeof defaultIsSessionOwnedByUser;
  getSessionAllEvents?: typeof defaultGetSessionAllEvents;
  signSessionShareToken?: typeof defaultSignSessionShareToken;
  verifySessionShareToken?: typeof defaultVerifySessionShareToken;
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

  const store = dependencies.store ?? postgresShareStore(dependencies.pool);
  const active = (r: ShareRecord) => !r.revoked_at && r.expires_at.getTime() > r.server_time.getTime();
  const dto = (r: ShareRecord) => ({ id:r.id, session_id:r.session_id, title:r.title || r.session_id,
    created_at:r.created_at.toISOString(), expires_at:r.expires_at.toISOString(),
    status:r.revoked_at?'revoked':active(r)?'active':'expired', server_time:r.server_time.toISOString() });
  const urlFor = (r: ShareRecord) => `${publicIssuer}/share/session/${encodeURIComponent(signSessionShareToken({
    userId:r.user_id, sessionId:r.session_id, shareId:r.id,
    iat:Math.floor(r.created_at.getTime()/1000), exp:Math.floor(r.expires_at.getTime()/1000),
  }))}`;
  const authorize = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control','no-store, private');
    const bearer=req.headers.authorization;
    const access=bearer?.startsWith('Bearer ') ? await verifyAccessToken(bearer.slice(7),dependencies.pool) : null;
    if (!access) reply.code(401).send({error:'authorization required'});
    return access;
  };
  app.post('/api/sessions/:sessionId/share-link', async (req, reply) => {
    const access=await authorize(req,reply);if(!access)return;
    const {sessionId}=req.params as {sessionId:string};
    if(!await isSessionOwnedByUser(dependencies.pool,access.userId,sessionId))return reply.code(404).send({error:'session not found'});
    const requestId=(req.body as {request_id?:unknown}|null)?.request_id;
    if(typeof requestId!=='string'||!uuid.test(requestId))return reply.code(400).send({error:'request_id UUID required'});
    try {
      const record=await store.create(access.userId,sessionId,requestId);
      // A replay of a revoked/expired intent must never create a new authorization.
      return {...dto(record), ...(active(record)?{url:urlFor(record)}:{})};
    } catch(error) {
      if(error instanceof ShareConflict)return reply.code(409).send({error:'share request conflict'});
      if(error instanceof ShareLimit)return reply.code(429).send({error:'active share limit reached (100)'});
      throw error;
    }
  });
  app.get('/api/share-links',async(req,reply)=>{
    const access=await authorize(req,reply);if(!access)return;
    const sessionId=(req.query as {session_id?:unknown}).session_id;
    if(sessionId!==undefined&&(typeof sessionId!=='string'||sessionId.length>64))return reply.code(400).send({error:'invalid session'});
    const rows=await store.list(access.userId,sessionId as string|undefined);
    return {links:rows.map(dto),server_time:(rows[0]?.server_time??new Date()).toISOString()};
  });
  for(const suffix of ['', '/url'])app.get(`/api/share-links/:id${suffix}`,async(req,reply)=>{
    const access=await authorize(req,reply);if(!access)return;
    const {id}=req.params as {id:string};
    const record=uuid.test(id)?await store.get(access.userId,id):null;
    if(!record)return reply.code(404).send({error:'share not found'});
    if(suffix && !active(record))return reply.code(410).send({error:'share unavailable'});
    return {...dto(record),...(suffix?{url:urlFor(record)}:{})};
  });
  app.delete('/api/share-links/:id',async(req,reply)=>{
    const access=await authorize(req,reply);if(!access)return;
    const {id}=req.params as {id:string};
    const record=uuid.test(id)?await store.revoke(access.userId,id):null;
    if(!record)return reply.code(404).send({error:'share not found'});
    return dto(record);
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
      const record=await store.get(share.userId,share.shareId);
      if(!record || !active(record) || record.session_id!==share.sessionId ||
        Math.floor(record.created_at.getTime()/1000)!==share.iat || Math.floor(record.expires_at.getTime()/1000)!==share.exp) return unavailable();
      const owned = await isSessionOwnedByUser(
        dependencies.pool,
        share.userId,
        share.sessionId,
      );
      if (!owned) return unavailable();
      const events = await withSessionHistoryScope({ userId: share.userId }, () => getSessionAllEvents(dependencies.pool, share.sessionId));
      const current=await store.get(share.userId,share.shareId);
      if(!current || !active(current))return unavailable();
      return shareViewerPage(events, { expiresAt: record.expires_at });
    } catch {
      return unavailable();
    }
  });
}
