import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import type pg from 'pg';
import { initDB, parseDBUrl, createUserWithWelcomeEmail, getUserByEmail, getUserById, getUserPlanAndWhitelist, getUserProfile, userExists, deleteUserAccount, registerDevice, removeDevice, cleanStaleTombstones, upsertDaemonAlias, updateDisplayName, updateEmail, addToIOSWaitlist, revokeToken, isTokenRevoked, cleanRevokedTokens, insertAuditLog, bindTokenToDaemon, updateSessionTitle, isSessionOwnedByUser, getSessionAllEvents, getTokenSummary, getTokensByDaemon, backfillSessionTokens, backfillSessionModel, backfillTokenDailyStats, aggregateDayIntoStats, cleanStaleEvents, getTokenDailySeries, getTokenByModel, getTokenByDaemon, getSessionTokenTrend, listProUserIds, getUserDailyTokens, getUserWeeklyTokens, markReportSent, handleRefreshReuse } from './db.js';
import { closeRelayPools, createRelayPools } from './db-pools.js';
import { Router, parseDurableIngressFlag, type FlagConfig } from './router.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken, decodeToken, verifyAccessTokenWithRevocation } from './auth.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush, dailyReportPush, weeklyReportPush } from './push.js';
import { sendEmailCode } from './config/email.js';
import { generateCode, storeCode, verifyCode, hasPendingCode } from './config/verification.js';
import { validateClient } from './config/clients.js';
import { createSession, getSessionByDeviceCode, getSessionByUserCode, authorizeSession, recordPoll, canPoll, deleteSession } from './config/auth-sessions.js';
import { createQrSession, getQrSession, markScanned, confirmQrSession, deleteQrSession } from './config/qr-sessions.js';
import { resolveEntitlements } from './entitlements.js';
import { getQuotaSnapshot } from './quota.js';
import { createWsTicketStore } from './config/ws-tickets.js';
import type { WsTicketPayload } from './config/ws-tickets.js';
import { createHash } from 'crypto';
import { ConnectionRateLimiter } from './rate-limit.js';
import { isAppReviewEmail, isAppReviewEnabled, isConfiguredAppReviewEmail, verifyAppReviewCode } from './config/app-review-auth.js';
import { ensureAppReviewDemoData } from './config/app-review-demo.js';
import { resolveLanguage } from './config/language.js';
import { findOrCreateEmailUser } from './email-user.js';
export { findOrCreateEmailUser } from './email-user.js';
import { createWelcomeEmailWorker } from './welcome-email-worker.js';
import { pathToFileURL } from 'node:url';
import { registerDaemonConnection, type DaemonSocketIdentity } from './daemon-registration.js';
import { resolveBuildInfo, resolveCorsOrigin, resolvePublicIssuer } from './runtime-config.js';
import { ConnectionAdmission } from './connection-admission.js';
import { RegistrationDeadline } from './registration-deadline.js';
import { resolveAdmissionAddress } from './remote-address.js';
import {
  registry as relayMetricsRegistry,
  attentionRecoveryOpen,
  attentionRecoveryQuickResolutions,
  attentionRecoveryTransitions,
  tokenUsageDayClosures,
  tokenUsageShadowComparisons,
} from './metrics.js';
import { registerRelayMetricsRoute } from './relay-metrics-route.js';
export { registerRelayMetricsRoute } from './relay-metrics-route.js';
import {
  RealtimeOutboxConsumer,
  RealtimeOutboxRepository,
} from './materialization/realtime-outbox.js';
import { assertDurableIngressSchema } from './event-worker-main.js';
import { registerSessionShareRoutes } from './session-share-routes.js';
import { attentionInboxConfig } from './attention-inbox/config.js';
import { serializeAttentionItem, serializeAttentionRecovery } from './attention-inbox/dto.js';
import { createAttentionNotifier } from './attention-inbox/notifier.js';
import { createAttentionProjectionWorker } from './attention-inbox/projection-worker.js';
import { AttentionInboxRepository } from './attention-inbox/repository.js';
import { AttentionRecoveryRepository } from './attention-inbox/recovery-repository.js';
import { registerAttentionInboxRoutes } from './attention-inbox/routes.js';
import { createAttentionInboxRuntime } from './attention-inbox/runtime.js';
import { AttentionInboxService } from './attention-inbox/service.js';
import {
  assertTokenUsageFeatureDependencies,
  tokenUsageFeatures,
  useFactAuthoritativeSessionDeletion,
} from './config/token-usage.js';
import {
  getSessionTokenTrendV2,
  getTodayTokenUsageByAgentV2,
  getTokenDashboardV2,
  getUserDailyTokensV2,
  getUserWeeklyTokensV2,
} from './token-usage/dashboard-v2.js';
import { readTokenDashboard } from './token-usage/read-service.js';
import {
  assertTokenUsageWriteContinuity,
  initializeTokenUsageAccounting,
  runTokenUsageCloseSweep,
} from './token-usage/lifecycle.js';

const API_KEY = process.env.POCKETCTL_API_KEY || '';
const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketctl';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const DEV_EMAIL = process.env.DEV_EMAIL || '';
const DEV_EMAIL_CODE = process.env.DEV_EMAIL_CODE || '';
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_CONNECTIONS = parseInt(process.env.RATE_LIMIT_MAX_CONNECTIONS || '30', 10);
const RATE_LIMIT_BURST_WINDOW_MS = parseInt(process.env.RATE_LIMIT_BURST_WINDOW_MS || '10000', 10);
const RATE_LIMIT_BURST_MAX = parseInt(process.env.RATE_LIMIT_BURST_MAX || '5', 10);
const RATE_LIMIT_AUTH_FAIL_THRESHOLD = parseInt(process.env.RATE_LIMIT_AUTH_FAIL_THRESHOLD || '3', 10);
const REFRESH_COOKIE_NAME = 'pocketctl_refresh_token';
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const DAEMON_REGISTRATION_DEADLINE_MS = 10_000;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const wsDaemonMap = new Map<any, DaemonSocketIdentity>();
const wsTickets = createWsTicketStore(60_000);

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export interface RelayRuntimeConfig {
  durableIngress: FlagConfig;
  materializationMode: 'inline' | 'worker';
  eventWindow: number;
  maxEventBytes: number;
  maxChunkBytes: number;
  replayBatchMaxEvents: number;
  replayBatchMaxBytes: number;
}

function strictPositiveConfig(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  return value;
}

export function resolveRelayRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RelayRuntimeConfig {
  const durableIngress = parseDurableIngressFlag(env);
  const rawMaterialization = env.RELAY_MATERIALIZATION_MODE ?? 'inline';
  if (rawMaterialization !== 'inline' && rawMaterialization !== 'worker') {
    throw new Error(`invalid RELAY_MATERIALIZATION_MODE: ${rawMaterialization}`);
  }
  for (const [name, fallback] of [
    ['DB_CONTROL_POOL_MAX', 4],
    ['DB_INGEST_POOL_MAX', 8],
    ['DB_QUERY_POOL_MAX', 8],
    ['DB_WORKER_POOL_MAX', 8],
    ['DB_POOL_SINGLE_MAX', 16],
    ['DB_POOL_TOTAL_MAX', 28],
  ] as const) {
    strictPositiveConfig(env, name, fallback);
  }
  const eventWindow = strictPositiveConfig(env, 'RELAY_DURABLE_INGRESS_WINDOW', 128);
  const maxEventBytes = strictPositiveConfig(env, 'MAX_WS_MESSAGE_SIZE', 1_048_576);
  const maxChunkBytes = strictPositiveConfig(env, 'MAX_CHUNK_BYTES', 131_072);
  const replayBatchMaxEvents = strictPositiveConfig(env, 'REPLAY_BATCH_MAX_EVENTS', 50);
  const replayBatchMaxBytes = strictPositiveConfig(env, 'REPLAY_BATCH_MAX_BYTES', 524_288);
  if (eventWindow > 65_536) {
    throw new Error('RELAY_DURABLE_INGRESS_WINDOW must be at most 65536');
  }
  if (maxChunkBytes > maxEventBytes) {
    throw new Error('MAX_CHUNK_BYTES must not exceed MAX_WS_MESSAGE_SIZE');
  }
  if (replayBatchMaxBytes > maxEventBytes) {
    throw new Error('REPLAY_BATCH_MAX_BYTES must not exceed MAX_WS_MESSAGE_SIZE');
  }
  if (rawMaterialization === 'inline' && durableIngress.mode !== 'off') {
    throw new Error('RELAY_MATERIALIZATION_MODE=inline requires RELAY_DURABLE_INGRESS=off');
  }
  return {
    durableIngress,
    materializationMode: rawMaterialization,
    eventWindow,
    maxEventBytes,
    maxChunkBytes,
    replayBatchMaxEvents,
    replayBatchMaxBytes,
  };
}

export async function assertRelayMaterializationReady(
  mode: 'inline' | 'worker',
  pool: Pick<pg.Pool, 'query'>,
): Promise<void> {
  if (mode === 'worker') await assertDurableIngressSchema(pool as pg.Pool);
}

// Connection rate limiter: burst + sustained window, plus an escalating ban for
// IPs that repeatedly fail auth. The auth-fail ban is what silences a
// revoked-token zombie regardless of the client version — it must fail auth on
// every reconnect, so it climbs the ban ladder and goes quiet. See rate-limit.ts.
const rateLimiter = new ConnectionRateLimiter({
  burstWindowMs: RATE_LIMIT_BURST_WINDOW_MS,
  burstMax: RATE_LIMIT_BURST_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
  windowMax: RATE_LIMIT_MAX_CONNECTIONS,
  authFailThreshold: RATE_LIMIT_AUTH_FAIL_THRESHOLD,
});

function parseCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        return rawValue.join('=');
      }
    }
  }
  return '';
}

function refreshCookie(token: string): string {
  const attrs = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/api/auth',
    'SameSite=Lax',
    `Max-Age=${REFRESH_COOKIE_MAX_AGE}`,
  ];
  if (NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

function expiredRefreshCookie(): string {
  const attrs = [
    `${REFRESH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/api/auth',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

function setRefreshCookie(reply: any, token: string) {
  reply.header('Set-Cookie', refreshCookie(token));
}

function clearRefreshCookie(reply: any) {
  reply.header('Set-Cookie', expiredRefreshCookie());
}

export async function consumeLiveUserWsTicket(
  store: { consume(ticket: string): WsTicketPayload | null },
  ticket: string,
  pool: any,
): Promise<WsTicketPayload | null> {
  const payload = store.consume(ticket);
  if (!payload) return null;
  try {
    return await userExists(pool, payload.userId) ? payload : null;
  } catch {
    return null;
  }
}

export async function handleDeleteAccountRequest(
  req: any,
  reply: any,
  pool: any,
  router: Pick<Router, 'terminateUserConnections'>,
): Promise<{ success: true } | { error: string }> {
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401);
    return { error: 'authorization required' };
  }
  const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
  if (!payload) {
    reply.code(401);
    return { error: 'invalid token' };
  }

  router.terminateUserConnections(payload.userId);
  const deleted = await deleteUserAccount(pool, payload.userId);
  clearRefreshCookie(reply);
  if (!deleted) {
    reply.code(404);
    return { error: 'user not found' };
  }
  return { success: true };
}

export async function startRelayBackgroundWorkers(deps: {
  welcome: { start(): void; stop?(): Promise<void> };
  realtimeOutboxConsumer: { start(): Promise<void> };
}): Promise<void> {
  deps.welcome.start()
  try {
    await deps.realtimeOutboxConsumer.start()
  } catch (error) {
    await deps.welcome.stop?.()
    throw error
  }
}

export function registerDurableIngressReadinessRoute(
  app: FastifyInstance,
  getDatabaseReady: () => boolean,
  pool: Pick<pg.Pool, 'query'>,
  buildInfo: Record<string, unknown>,
): void {
  app.get('/health/ready', async (_req, reply) => {
    if (!getDatabaseReady()) {
      reply.code(503);
      return { status: 'not_ready', ...buildInfo, error: 'database schema initializing' };
    }
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', ...buildInfo };
    } catch {
      reply.code(503);
      return { status: 'degraded', ...buildInfo, error: 'db unreachable' };
    }
  });
}

export { relayMetricsRegistry }

interface RelayWebSocketHandlerDependencies {
  getDatabaseReady(): boolean;
  maxMessageSize: number;
  apiKey: string;
  trustProxy: boolean;
  random(): number;
  rateLimiter: {
    check(address: string): { allowed: boolean; reason?: string };
    gc(): void;
    recordAuthFailure(address: string): number;
    clearAuthFailure(address: string): void;
  };
  connectionAdmission: {
    tryAcquire(
      type: 'daemon' | 'client',
      address: string,
    ): { admitted: true; release: () => void } | { admitted: false; retryAfterMs: number };
  };
  verifyAccessToken(token: string): Promise<any>;
  consumeTicket(ticket: string): Promise<any>;
  decodeToken(token: string): any;
  registerDaemon(
    router: any,
    daemonMap: Map<any, any>,
    socket: any,
    message: any,
    userId: number | null,
    tokenJti: string | undefined,
    tokenMachineId: string | undefined,
    releaseAdmission: () => void,
  ): Promise<boolean>;
  createRegistrationDeadline(onTimeout: () => void): {
    complete(): boolean;
    isActive(): boolean;
  };
  router: any;
  wsDaemonMap: Map<any, any>;
}

export function createRelayWebSocketHandler(dependencies: RelayWebSocketHandlerDependencies) {
  return (socket: any, req: any): void => {
    const query = req.query as any;
    const connType = query.type as string;
    // This is the production preflight boundary. Nothing below it may observe
    // or mutate connection, auth, admission, rate-limit, or Router state while
    // the authoritative schema is still initializing.
    if (!dependencies.getDatabaseReady() && connType === 'daemon') {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'relay_restarting', retryable: true }));
        socket.close(1013, 'relay restarting');
      }
      return;
    }

    const clientIp = resolveAdmissionAddress({
      transportAddress: req.socket.remoteAddress,
      frameworkClientAddress: req.ip,
      trustProxy: dependencies.trustProxy,
    });

    const decision = dependencies.rateLimiter.check(clientIp);
    if (dependencies.random() < 0.01) dependencies.rateLimiter.gc();
    if (!decision.allowed) {
      socket.close(4029, decision.reason || 'rate limit exceeded');
      return;
    }

    const authHeader = req.headers['authorization'] as string | undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const ticket = query.ticket as string;
    const apiKey = query.api_key as string;
    const admission = dependencies.connectionAdmission.tryAcquire(
      connType === 'daemon' ? 'daemon' : 'client',
      clientIp,
    );
    if (!admission.admitted) {
      socket.send(JSON.stringify({
        type: 'disconnect',
        reason: 'relay_overloaded',
        retryable: true,
        retry_after_ms: admission.retryAfterMs,
      }));
      socket.close(1013, 'relay overloaded');
      return;
    }
    const releaseAdmission = admission.release;

    const earlyMessages: Buffer[] = [];
    let authDone = false;
    let userId: number | null = null;
    let tokenJti: string | undefined;
    let tokenMachineId: string | undefined;
    let registrationDeadline: ReturnType<RelayWebSocketHandlerDependencies['createRegistrationDeadline']> | undefined;
    if (connType === 'daemon') {
      registrationDeadline = dependencies.createRegistrationDeadline(() => {
        releaseAdmission();
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'disconnect', reason: 'registration_timeout', retryable: true }));
          socket.close(1013, 'registration timeout');
        }
      });
    }

    socket.on('message', (raw: Buffer) => {
      if (!authDone) {
        earlyMessages.push(raw);
        return;
      }
      enqueueMessage(raw);
    });

    socket.on('close', () => {
      registrationDeadline?.complete();
      releaseAdmission();
      if (connType === 'daemon') {
        const daemon = dependencies.wsDaemonMap.get(socket);
        if (daemon) {
          dependencies.router.unregisterDaemon(daemon.daemonId, socket);
          dependencies.wsDaemonMap.delete(socket);
        }
      } else {
        dependencies.router.unregisterClient(socket);
      }
      console.log(`WS disconnected: type=${connType} ip=${clientIp}`);
    });

    let messageChain = Promise.resolve();
    function enqueueMessage(raw: Buffer): void {
      messageChain = messageChain.then(() => processMessage(raw)).catch((err) => {
        console.error(`message processing error from ${clientIp}:`, err.message);
      });
    }

    async function processMessage(raw: Buffer): Promise<void> {
      if (raw.length > dependencies.maxMessageSize) {
        socket.close(4003, 'message too large');
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());
        if (connType === 'daemon') {
          if (msg.type === 'register') {
            if (!registrationDeadline?.isActive()) return;
            let registered = false;
            try {
              registered = await dependencies.registerDaemon(
                dependencies.router,
                dependencies.wsDaemonMap,
                socket,
                msg,
                userId,
                tokenJti,
                tokenMachineId,
                releaseAdmission,
              );
            } finally {
              const completed = registrationDeadline.complete();
              if (!completed && registered) dependencies.router.unregisterDaemon(msg.daemon_id, socket);
            }
            if (registered && socket.readyState === 1) {
              console.log('[ws] daemon registered, total in map:', dependencies.wsDaemonMap.size);
            }
          } else {
            const daemon = dependencies.wsDaemonMap.get(socket);
            if (daemon) {
              dependencies.router.handleDaemonMessage(daemon.daemonId, msg, socket, daemon.startedAt);
            } else {
              console.log('[ws] message for unknown daemon, type:', msg.type);
            }
          }
        } else {
          dependencies.router.registerClient(socket, userId);
          dependencies.router.handleClientMessage(socket, msg);
        }
      } catch (err) {
        console.error(`message parse error from ${clientIp}:`, (err as Error).message);
      }
    }

    (async () => {
      if (token) {
        const payload = await dependencies.verifyAccessToken(token);
        if (!payload) {
          const decoded = dependencies.decodeToken(token);
          const owner = decoded && decoded.userId
            ? `claimed user=${decoded.userId} daemon=${decoded.machine_id || '?'} jti=${(decoded.jti || '').slice(0, 8)}`
            : 'malformed';
          const banSec = dependencies.rateLimiter.recordAuthFailure(clientIp);
          console.log(`WS rejected: type=${connType} ip=${clientIp} reason=invalid_token ${owner}${banSec ? ` banned=${banSec}s` : ''}`);
          registrationDeadline?.complete();
          releaseAdmission();
          socket.close(4001, 'invalid token');
          return;
        }
        userId = payload.userId;
        tokenJti = payload.jti;
        tokenMachineId = payload.machine_id;
      } else if (ticket) {
        const payload = await dependencies.consumeTicket(ticket);
        if (!payload) {
          const banSec = dependencies.rateLimiter.recordAuthFailure(clientIp);
          console.log(`WS rejected: type=${connType} ip=${clientIp} reason=invalid_ticket${banSec ? ` banned=${banSec}s` : ''}`);
          registrationDeadline?.complete();
          releaseAdmission();
          socket.close(4001, 'invalid ticket');
          return;
        }
        userId = payload.userId;
        tokenJti = payload.jti;
        tokenMachineId = payload.machine_id;
      } else if (apiKey && dependencies.apiKey && apiKey === dependencies.apiKey) {
        userId = null;
      } else {
        const banSec = dependencies.rateLimiter.recordAuthFailure(clientIp);
        console.log(`WS rejected: type=${connType} ip=${clientIp} reason=auth_required${banSec ? ` banned=${banSec}s` : ''}`);
        registrationDeadline?.complete();
        releaseAdmission();
        socket.close(4001, 'authentication required');
        return;
      }

      if (connType === 'daemon' && !registrationDeadline?.isActive()) return;

      dependencies.rateLimiter.clearAuthFailure(clientIp);
      authDone = true;
      console.log(`WS connected: type=${connType} ip=${clientIp} user=${userId || 'legacy'}`);

      if (connType !== 'daemon') {
        dependencies.router.registerClient(socket, userId);
        releaseAdmission();
      }

      for (const raw of earlyMessages) enqueueMessage(raw);
      earlyMessages.length = 0;
    })().catch((err) => {
      console.error(`ws auth error from ${clientIp}:`, err.message);
      registrationDeadline?.complete();
      releaseAdmission();
      socket.close(4011, 'internal error');
    });
  };
}

async function main() {
  const tStart = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const corsOrigin = resolveCorsOrigin(NODE_ENV, ALLOWED_ORIGINS)
  const publicIssuer = resolvePublicIssuer(
    NODE_ENV,
    process.env.PUBLIC_ISSUER_URL,
    `http://localhost:${PORT}`,
  )
  const buildInfo = resolveBuildInfo(process.env)
  const runtimeConfig = resolveRelayRuntimeConfig(process.env)
  const tokenFeatures = tokenUsageFeatures(process.env)
  const attentionConfig = attentionInboxConfig(process.env)
  assertTokenUsageFeatureDependencies(tokenFeatures, runtimeConfig.durableIngress.mode)
  const pools = createRelayPools(parseDBUrl(DB_URL))
  const pool = pools.query
  const welcomeEmailWorker = createWelcomeEmailWorker({ pool: pools.worker })
  const attentionRepository = new AttentionInboxRepository(
    pools.query,
    process.env.JWT_SECRET!,
  )
  const recoveryRepository = new AttentionRecoveryRepository(pools.query)
  const recoveryObserver = attentionConfig.recovery.projection ? {
    async confirmedOffline(input: {
      userId: number
      daemonId: string
      registrationGeneration: string
      daemonDisplayName: string
    }): Promise<void> {
      const result = await recoveryRepository.recordConfirmedOffline(input)
      attentionRecoveryTransitions.inc({ outcome: result.outcome })
    },
    async confirmedOnline(input: {
      userId: number
      daemonId: string
      registrationGeneration: string
    }): Promise<void> {
      const result = await recoveryRepository.recordConfirmedOnline(input)
      if (result.resolved > 0) attentionRecoveryTransitions.inc({ outcome: 'resolved' }, result.resolved)
      if (result.quickResolved > 0) attentionRecoveryQuickResolutions.inc(result.quickResolved)
    },
  } : undefined
  const router = new Router(pools, {
    transport: {
      maxEventBytes: runtimeConfig.maxEventBytes,
      maxChunkBytes: runtimeConfig.maxChunkBytes,
      replayBatchMaxEvents: runtimeConfig.replayBatchMaxEvents,
      replayBatchMaxBytes: runtimeConfig.replayBatchMaxBytes,
    },
    durableIngress: {
      mode: runtimeConfig.durableIngress.mode,
      canaryDaemonIds: runtimeConfig.durableIngress.daemonIds,
      eventWindow: runtimeConfig.eventWindow,
    },
    tokenUsageFactsAuthoritative: useFactAuthoritativeSessionDeletion(tokenFeatures),
    writeTokenUsageFacts: tokenFeatures.writeFacts,
    recoveryObserver,
  });
  const realtimeOutboxConsumer = new RealtimeOutboxConsumer({
    repository: new RealtimeOutboxRepository(pools.query),
    deliver: (delivery) => router.deliverDurableMaterializedEvent(delivery),
  })
  const attentionService = new AttentionInboxService({
    mode: attentionConfig.mode,
    repository: attentionRepository,
    router,
    requestHashSecret: process.env.JWT_SECRET!,
  })
  const attentionProjection = createAttentionProjectionWorker({
    pool: pools.worker,
    repository: attentionRepository,
  })
  const attentionNotifier = createAttentionNotifier({
    pool: pools.worker,
    loadItem: async (userId, itemId, revision) => {
      const item = await attentionRepository.getItem(userId, itemId, revision)
      return item ? serializeAttentionItem(item) : null
    },
    loadRecovery: async (userId, itemId, revision) => {
      const item = await recoveryRepository.getItem(userId, itemId, revision)
      return item ? serializeAttentionRecovery(item) : null
    },
    recoveryVisible: attentionConfig.recovery.visible,
    broadcast: (userId, payload) => router.broadcastToUser(userId, payload),
  })
  const recoveryBackfillNotBefore = Date.now() + positiveEnvInt('RELAY_LIST_GRACE_MS', 60_000)
  const attentionMaintenance = {
    async runMaintenance(): Promise<number> {
      const itemChanges = await attentionRepository.runMaintenance()
      if (!attentionConfig.recovery.projection) return itemChanges
      const recovery = await recoveryRepository.runMaintenance({
        projectOffline: Date.now() >= recoveryBackfillNotBefore,
      })
      attentionRecoveryOpen.set(recovery.open)
      if (recovery.changed > 0) {
        attentionRecoveryTransitions.inc({ outcome: 'reconciled' }, recovery.changed)
      }
      return itemChanges + recovery.changed
    },
  }
  const attentionRuntime = createAttentionInboxRuntime({
    mode: attentionConfig.mode,
    projection: attentionProjection,
    maintenance: attentionMaintenance,
    notifier: attentionNotifier,
    onError: (component, error) => {
      console.error(`[attention-inbox] ${component} failed:`, error instanceof Error ? error.name : typeof error)
    },
  })
  let shuttingDown = false
  let databaseReady = false
  const tPool = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  // initDB 不阻塞 app.listen：生产重启表已存在，initDB 基本 no-op；全新库首启期间
  // 表可能短暂不存在，但生产不触发该路径。失败仍致命 → exit。
  initDB(pools.query)
    .then(async () => {
      await assertRelayMaterializationReady(runtimeConfig.materializationMode, pools.query)
      await assertTokenUsageWriteContinuity(pool, tokenFeatures)
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      console.log(`[startup] initDB done in ${(t - tPool).toFixed(0)}ms`);
      console.log('Database initialized');
      // Backfill sessions token columns from agent_text usage events
      try {
        const backfilled = await backfillSessionTokens(pool);
        if (backfilled > 0) console.log(`[tokens] backfilled ${backfilled} sessions with token usage`);
        const modelBf = await backfillSessionModel(pool);
        if (modelBf > 0) console.log(`[tokens] backfilled ${modelBf} sessions with model`);
        if (!tokenFeatures.writeFacts) {
          const statsBf = await backfillTokenDailyStats(pool);
          if (statsBf > 0) console.log(`[tokens] backfilled ${statsBf} token_daily_stats rows`);
        }
      } catch (e) { console.error('[tokens] backfill failed:', e); }
      if (tokenFeatures.writeFacts) {
        const initialized = await initializeTokenUsageAccounting(pool, tokenFeatures)
        if (initialized) {
          console.log(
            `[tokens:v2] baseline adopted_days=${initialized.migration.adoptedHistoricalDays}`
            + ` event_facts=${initialized.migration.backfilledEventFacts}`
            + ` synthetic_facts=${initialized.migration.syntheticCurrentFacts}`
            + ` session_rollups=${initialized.migration.backfilledSessionRollups}`,
          )
          for (const result of initialized.closures) {
            tokenUsageDayClosures.inc({ result: result.status })
          }
        }
      }
      if (!shuttingDown) {
        await startRelayBackgroundWorkers({ welcome: welcomeEmailWorker, realtimeOutboxConsumer });
        await attentionRuntime.start();
      }
      if (!shuttingDown) databaseReady = true
    })
    .catch((e) => { console.error('[startup] initDB failed:', e); process.exit(1) })
  const tInit = tPool // listen 不再等 initDB

  const connectionAdmission = new ConnectionAdmission({
    daemonGlobalMax: positiveEnvInt('RELAY_DAEMON_HANDSHAKE_MAX', 64),
    clientGlobalMax: positiveEnvInt('RELAY_CLIENT_HANDSHAKE_MAX', 128),
    daemonPerAddressMax: positiveEnvInt('RELAY_DAEMON_HANDSHAKE_PER_ADDRESS_MAX', 8),
    clientPerAddressMax: positiveEnvInt('RELAY_CLIENT_HANDSHAKE_PER_ADDRESS_MAX', 32),
    jitter: () => Math.floor(Math.random() * 1_000),
  });
  const app = Fastify({ logger: false, trustProxy: TRUST_PROXY });

  await app.register(fastifyCors, { origin: corsOrigin, credentials: true });
  await app.register(fastifyWebsocket);
  registerSessionShareRoutes(app, { pool, publicIssuer });
  registerAttentionInboxRoutes(app, {
    pool,
    config: attentionConfig,
    repository: attentionRepository,
    recoveryRepository,
    service: attentionService,
    verifyAccessToken: (token, authPool) => verifyAccessTokenWithRevocation(token, authPool),
  });

  // ---- REST API: Auth ----

  // Register
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password, displayName, lang: bodyLang } = req.body as any;
    if (!email || !password) {
      reply.code(400); return { error: 'email and password are required' };
    }
    if (password.length < 6) {
      reply.code(400); return { error: 'password must be at least 6 characters' };
    }
    const normalizedEmail = email.trim().toLowerCase();
    const locale = resolveLanguage(bodyLang, req.headers['accept-language']);
    const existing = await getUserByEmail(pool, normalizedEmail);
    if (existing) {
      reply.code(409); return { error: 'email already registered' };
    }
    let user;
    try {
      user = await createUserWithWelcomeEmail(pool, normalizedEmail, hashPassword(password), displayName, locale);
    } catch (error: any) {
      if (error?.code === '23505') {
        reply.code(409); return { error: 'email already registered' };
      }
      throw error;
    }
    const accessToken = await signAccessToken(user.id, user.email);
    const refreshToken = await signRefreshToken(user.id);
    setRefreshCookie(reply, refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, phone: user.phone ?? null, display_name: user.display_name, plan: user.plan || 'free' },
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
    setRefreshCookie(reply, refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, phone: user.phone ?? null, display_name: user.display_name, plan: user.plan || 'free' },
      _warning: 'This endpoint is deprecated and will be removed. Use /api/auth/email/verify for email-based login.',
    };
  });

  // Refresh token (with rotation and breach detection)
  app.post('/api/auth/refresh', async (req, reply) => {
    const body = (req.body || {}) as any;
    const refresh_token = parseCookie(req.headers.cookie, REFRESH_COOKIE_NAME) || body.refresh_token;
    if (!refresh_token) {
      reply.code(400); return { error: 'refresh_token is required' };
    }
    const payload = verifyRefreshToken(refresh_token);
    if (!payload) {
      reply.code(401); return { error: 'invalid or expired refresh token' };
    }

    // Reuse detection: if this refresh token was already rotated, the client is
    // presenting a stale one (typically a daemon whose SaveAuth failed to
    // persist the last rotation). Tolerance policy: don't permanently breach —
    // that would lock the daemon out via authRejectStopThreshold (the m3-pro
    // incident). Audit + let the refresh proceed so the daemon self-heals.
    if (payload.jti) {
      try {
        const alreadyRevoked = await isTokenRevoked(pool, payload.jti);
        if (alreadyRevoked) {
          const block = await handleRefreshReuse(pool, payload.userId, payload.jti);
          if (block) {
            reply.code(401);
            return { error: 'invalid or expired refresh token' };
          }
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
    setRefreshCookie(reply, newRefreshToken);
    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      user: { id: user.id, email: user.email, phone: user.phone ?? null, display_name: user.display_name, plan: user.plan || 'free' },
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const body = (req.body || {}) as any;
    const refreshToken = parseCookie(req.headers.cookie, REFRESH_COOKIE_NAME) || body.refresh_token;
    if (refreshToken) {
      const payload = verifyRefreshToken(refreshToken);
      if (payload?.jti) revokeToken(pool, payload.jti, payload.userId, 'logout').catch(console.error);
    }
    clearRefreshCookie(reply);
    return { success: true };
  });

  // WebSocket ticket: browsers cannot set Authorization headers on native
  // WebSocket, so Web clients exchange a Bearer access token for a short-lived,
  // one-time ticket and use that ticket only during the WS handshake.
  app.post('/api/auth/ws-ticket', async (req, reply) => {
    const authHeader = req.headers['authorization'] as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    if (Math.random() < 0.01) wsTickets.gc();
    const { ticket, expiresIn } = wsTickets.create(payload);
    return { ticket, expires_in: expiresIn };
  });

  // Apple Sign In (Phase 3)

  // ---- REST API: Email Verification Code Auth ----

  // Send email verification code
  app.post('/api/auth/email/send', async (req, reply) => {
    const { email, lang: bodyLang } = req.body as any;
    if (!email) {
      reply.code(400); return { error: 'email is required' };
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
      reply.code(400); return { error: 'invalid email format' };
    }
    if (isConfiguredAppReviewEmail(normalizedEmail) && !isAppReviewEnabled()) {
      reply.code(403); return { error: 'App Review account is disabled' };
    }

    const lang = resolveLanguage(bodyLang, req.headers['accept-language']);

    // App Review account: the reviewer uses the fixed code documented in
    // App Store Connect. Do not send email or expose the code in the response.
    if (isAppReviewEmail(normalizedEmail)) {
      return { success: true, message: 'verification code sent' };
    }

    // Dev/test email shortcut: if DEV_EMAIL configured and matches, use fixed code (skip SES)
    // Works in any NODE_ENV — useful when SES unavailable (e.g. pre-ICP-filing)
    if (DEV_EMAIL && normalizedEmail === DEV_EMAIL.toLowerCase()) {
      if (hasPendingCode(normalizedEmail)) {
        reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
      }
      const devCode = DEV_EMAIL_CODE || '888888';
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
        await sendEmailCode(normalizedEmail, code, lang);
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
    const { email, code, lang: bodyLang } = req.body as any;
    if (!email || !code) {
      reply.code(400); return { error: 'email and code are required' };
    }
    const normalizedEmail = email.trim().toLowerCase();
    const locale = resolveLanguage(bodyLang, req.headers['accept-language']);
    if (isConfiguredAppReviewEmail(normalizedEmail) && !isAppReviewEnabled()) {
      reply.code(403); return { error: 'App Review account is disabled' };
    }
    if (!verifyAppReviewCode(normalizedEmail, code) && !verifyCode(normalizedEmail, code)) {
      reply.code(400); return { error: 'invalid or expired verification code' };
    }
    // Find or create user by email
    const displayName = normalizedEmail.split('@')[0];
    let user;
    try {
      user = await findOrCreateEmailUser(pool, normalizedEmail, displayName, locale);
    } catch (e: any) {
      reply.code(500); return { error: '创建用户失败' };
    }
    if (isAppReviewEmail(normalizedEmail)) {
      try {
        await ensureAppReviewDemoData(pool, user.id);
      } catch (e) {
        console.error('[app-review] failed to prepare demo data:', e);
        reply.code(500); return { error: '审核演示数据准备失败' };
      }
    }
    const accessToken = await signAccessToken(user.id, user.email, user.phone ?? undefined);
    const refreshToken = await signRefreshToken(user.id);
    setRefreshCookie(reply, refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: user.id, email: user.email, phone: user.phone, display_name: user.display_name, plan: user.plan || 'free' },
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

  // Get current user profile (including subscription plan)
  app.get('/api/user/profile', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const profile = await getUserProfile(pool, payload.userId);
    if (!profile) {
      reply.code(404); return { error: 'user not found' };
    }
    const { plan, whitelist } = await getUserPlanAndWhitelist(pool, payload.userId);
    const quota = await getQuotaSnapshot(pool, payload.userId, resolveEntitlements(plan, whitelist));
    return { ...profile, quota };
  });

  app.delete('/api/user/account', async (req, reply) => {
    return handleDeleteAccountRequest(req, reply, pool, router);
  });

  // Register device for push notifications
  app.post('/api/devices/register', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { token } = req.params as any;
    const ok = await removeDevice(pool, payload.userId, token);
    if (!ok) { reply.code(404); return { error: 'device not found' }; }
    return { success: true };
  });

  // Set daemon alias
  app.put('/api/daemons/:daemonId/alias', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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

    // Router has already completed the security-critical revoke/close path.
    // Request metadata is best-effort and must not hang an otherwise successful
    // force-kick response when audit storage is unavailable.
    void insertAuditLog(pool, payload.userId, 'force_kick', {
      daemon_id: daemonId,
    }, req.ip).catch((e) => console.error('force_kick request audit:', e));

    return { success: true };
  });

  // ---- Token Usage Tracking ----

  // User-level token usage summary: total / today / thisWeek / thisMonth
  app.get('/api/tokens/summary', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    if (!databaseReady) { reply.code(503); return { error: 'token accounting initializing' }; }
    if (!tokenFeatures.dashboardV2) return await getTokenSummary(pool, payload.userId);
    return (await getTokenDashboardV2(pool, payload.userId, null, 1)).summary;
  });

  // Daemon-level token usage: total / today / thisMonth + per-session breakdown
  app.get('/api/tokens/by-daemon/:daemonId', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    if (!databaseReady) { reply.code(503); return { error: 'token accounting initializing' }; }
    const { daemonId } = req.params as any;
    let data
    if (tokenFeatures.dashboardV2) {
      const [dashboard, byAgentToday] = await Promise.all([
        getTokenDashboardV2(pool, payload.userId, daemonId, 1),
        getTodayTokenUsageByAgentV2(pool, payload.userId, daemonId),
      ])
      data = await getTokensByDaemon(pool, payload.userId, daemonId, {
        summary: {
          total: dashboard.summary.total,
          today: dashboard.summary.today,
          thisMonth: dashboard.summary.thisMonth,
        },
        byAgentToday,
      })
    } else {
      data = await getTokensByDaemon(pool, payload.userId, daemonId)
    }
    if (!data) { reply.code(404); return { error: 'daemon not found or not owned' }; }
    return data;
  });

  // Token dashboard: legacy aggregation until cutover; V2 merges only sealed
  // historical rollups with current-UTC-day immutable facts. Supports host filtering.
  app.get('/api/tokens/dashboard', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    if (!databaseReady) { reply.code(503); return { error: 'token accounting initializing' }; }
    const daemon = ((req.query as any).daemon as string) || 'all';
    const days = Math.min(Math.max(parseInt((req.query as any).days as string) || 30, 1), 365);
    return await readTokenDashboard(
      tokenFeatures,
      async () => {
        const [summary, dailySeries, byModel, byDaemon] = await Promise.all([
          getTokenSummary(pool, payload.userId, daemon),
          getTokenDailySeries(pool, payload.userId, daemon, days),
          getTokenByModel(pool, payload.userId, daemon),
          getTokenByDaemon(pool, payload.userId),
        ])
        return { summary, dailySeries, byModel, byDaemon }
      },
      () => getTokenDashboardV2(pool, payload.userId, daemon, days),
      (observation) => {
        tokenUsageShadowComparisons.inc({ result: observation.status })
        if (observation.status === 'mismatch') {
          console.warn(
            `[tokens:v2] shadow mismatch values=${observation.differingValues}`
            + ` max_delta=${observation.maxAbsoluteDelta}`,
          )
        }
      },
    );
  });

  // Per-session daily token trend: legacy reads retained events; V2 reads only
  // sealed historical session rollups plus current-UTC-day immutable facts.
  app.get('/api/tokens/session/:sessionId/trend', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    if (!databaseReady) { reply.code(503); return { error: 'token accounting initializing' }; }
    const { sessionId } = req.params as any;
    const owned = await isSessionOwnedByUser(pool, payload.userId, sessionId);
    if (!owned) { reply.code(404); return { error: 'session not found or not owned' }; }
    const trend = tokenFeatures.dashboardV2
      ? await getSessionTokenTrendV2(pool, payload.userId, sessionId, 90)
      : await getSessionTokenTrend(pool, sessionId, 90);
    // Archived: the session predates the 90-day retention (events purged) → no trend.
    return { trend, archived: trend.length === 0 };
  });

  // Unregister (delete) a daemon — sessions preserved with daemon_id nulled (C4)
  app.delete('/api/daemons/:daemonId', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { daemonId } = req.params as any;
    const result = await router.handleDeleteDaemon(daemonId, payload.userId);
    if (!result.success) {
      reply.code(result.error === 'forbidden' ? 403 : 404);
      return { error: result.error || 'daemon not found or not owned' };
    }
    // Notify same-user clients to remove the daemon from their list
    router.broadcastToUser(payload.userId, { type: 'daemon_status', daemon_id: daemonId, status: 'unregistered' });
    return { success: true };
  });

  // Upgrade agent on a daemon (C4c): web → relay → daemon `claude update`. Async, result via upgrade_result event.
  app.post('/api/daemons/:daemonId/upgrade-agent', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    setRefreshCookie(reply, refreshToken);

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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
      setRefreshCookie(reply, refreshToken);
      reply.code(200);
      return {
        status: 'confirmed' as const,
        access_token: accessToken,
        refresh_token: refreshToken,
        user: { id: user.id, email: user.email, phone: user.phone, display_name: user.display_name, plan: user.plan || 'free' },
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
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    const relayBaseUrl = process.env.WEB_APP_URL || `http://${req.hostname}:${PORT}`;
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return deviceAuthPage(userCode, relayBaseUrl);
  });

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', async () => {
    const baseUrl = publicIssuer;
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
  // Get a single daemon's latest snapshot (for single-host refresh). Shares the
  // same assembly logic as the WS `list_daemons` so fields stay consistent.
  app.get('/api/daemons/:daemonId', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) { reply.code(401); return { error: 'invalid token' }; }
    const { daemonId } = req.params as any;
    // 单主机刷新的核心诉求是看真实状态:optimistic=false 关闭启动宽限期乐观 online,
    // 内存 map 里没有活跃连接时如实返回 offline。
    const daemon = await router.buildDaemonForUser(daemonId, payload.userId, false);
    if (!daemon) { reply.code(404); return { error: 'daemon not found or not owned' }; }
    return daemon;
  });

  app.post('/api/daemons/:daemonId/restart', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.code(401); return { error: 'authorization required' }; }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
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
    if (!databaseReady) return { status: 'not_ready', ...buildInfo, error: 'database schema initializing' };
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', ...buildInfo };
    } catch {
      return { status: 'degraded', ...buildInfo, error: 'db unreachable' };
    }
  });

  registerDurableIngressReadinessRoute(app, () => databaseReady, pool, buildInfo);
  registerRelayMetricsRoute(app, {
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    metrics: () => relayMetricsRegistry.metrics(),
  });

  // ---- WebSocket endpoint ----

  app.get('/ws', { websocket: true }, createRelayWebSocketHandler({
    getDatabaseReady: () => databaseReady,
    maxMessageSize: runtimeConfig.maxEventBytes,
    apiKey: API_KEY,
    trustProxy: TRUST_PROXY,
    random: Math.random,
    rateLimiter,
    connectionAdmission,
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    consumeTicket: (ticket) => consumeLiveUserWsTicket(wsTickets, ticket, pool),
    decodeToken,
    registerDaemon: registerDaemonConnection,
    createRegistrationDeadline: (onTimeout) => new RegistrationDeadline(
      DAEMON_REGISTRATION_DEADLINE_MS,
      {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      onTimeout,
    ),
    router,
    wsDaemonMap,
  }));

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' })
    const tListen = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    console.log(`pocketctl relay listening on port ${PORT} [${NODE_ENV}]`)
    console.log(`[startup] pool=${(tPool - tStart).toFixed(0)}ms initDB=${(tInit - tPool).toFixed(0)}ms listen=${(tListen - tInit).toFixed(0)}ms total=${(tListen - tStart).toFixed(0)}ms`)
  } catch (err) { console.error('failed to start:', err); process.exit(1) }

  // Graceful shutdown: tell peers we're restarting, then terminate every WS
  // immediately so the old process exits in <1s. The old code's `await
  // app.close()` blocked ~30s on ws's closeTimeout when a peer didn't ack the
  // close frame; terminate() bypasses that. A 2s race guards any stray conn.
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining...`);
    router.beginShutdown();
    await router.stopDurableIngress({ flushDeadlineMs: 1_500 });
    try {
      await realtimeOutboxConsumer.stop()
    } catch (e) {
      console.error('[shutdown] realtime outbox drain error:', e instanceof Error ? e.name : typeof e)
    }
    try {
      await attentionRuntime.stop()
    } catch (e) {
      console.error('[shutdown] attention inbox drain error:', e instanceof Error ? e.name : typeof e)
    }
    router.broadcastRelayRestarting();
    router.terminateAllConnections()
    await welcomeEmailWorker.stop()
    try {
      await Promise.race([app.close(), new Promise(r => setTimeout(r, 2000))])
    } catch (e) { console.error('[shutdown] close error:', e) }
    try { await closeRelayPools(pools) } catch (e) { console.error('[shutdown] pool.end error:', e) }
    router.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => { shutdown('SIGTERM') })
  process.on('SIGINT', () => { shutdown('SIGINT') })

  // Periodic cleanup: remove tombstones older than 30 days (every 6 hours)
  setInterval(async () => {
    try {
      const tombstoneCount = await cleanStaleTombstones(pool);
      const { accessPurged, refreshPurged } = await cleanRevokedTokens(pool);
      const totalPurged = tombstoneCount + accessPurged + refreshPurged;
      if (totalPurged > 0) console.log(`[cleanup] removed ${tombstoneCount} tombstones, ${accessPurged} access tokens, ${refreshPurged} refresh tokens`);
    } catch (err) { console.error('[cleanup] cleanup error:', (err as Error).message); }
  }, 6 * 60 * 60 * 1000);

  if (tokenFeatures.writeFacts) {
    // Every five minutes, retry all eligible UTC dates. The closer itself
    // enforces the 00:05 grace window, inbox terminality and reconciliation.
    setInterval(async () => {
      try {
        await runTokenUsageCloseSweep(
          pool,
          new Date(),
          (status) => tokenUsageDayClosures.inc({ result: status }),
        )
      } catch (err) {
        console.error('[tokens:v2] close sweep error:', (err as Error).message)
      }
    }, 5 * 60 * 1000)
  }

  // Old events retention stays hourly. Legacy rollup remains active only while
  // immutable fact writing is disabled.
  setInterval(async () => {
    try {
      if (!tokenFeatures.writeFacts) {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await aggregateDayIntoStats(pool, yesterday);
      }
      const purged = await cleanStaleEvents(pool);
      if (purged > 0) console.log(`[tokens] purged ${purged} events older than 90 days`);
    } catch (err) { console.error('[tokens] rollup error:', (err as Error).message); }
  }, 60 * 60 * 1000);

  // Pro-only token-usage report push (daily + weekly). Runs hourly and checks
  // whether the current UTC hour is inside the report window; the report_sent
  // table makes it idempotent across relay restarts and multi-instance deploys.
  //   - Daily: fires in the UTC 14:00 hour (22:00 Asia/Shanghai), reports the
  //     PREVIOUS UTC day's usage.
  //   - Weekly: fires in the UTC-Sunday 14:00 hour, reports the 7 days ending
  //     the previous Saturday (last complete week).
  // Both are Pro-gated (listProUserIds returns only plan!=free OR whitelist).
  setInterval(async () => {
    try {
      await maybeSendReportPushes(pool, tokenFeatures.dashboardV2);
    } catch (err) { console.error('[report] push error:', (err as Error).message); }
  }, 60 * 60 * 1000);
}

/**
 * Check whether the current hour is a report window and, if so, push daily
 * and/or weekly token reports to every Pro user. The report_sent table dedups:
 * once a (user, type, period) row exists, subsequent hourly runs skip it.
 */
async function maybeSendReportPushes(pool: any, useTokenAccountingV2 = false): Promise<void> {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0=Sunday

  // Daily report window: UTC 14:00-14:59 (22:00 Beijing).
  if (utcHour === 14) {
    // Report yesterday's (UTC) usage.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const periodKey = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD
    const dateLabel = zhDateLabel(yesterday);
    const proUsers = await listProUserIds(pool);
    for (const userId of proUsers) {
      const usage = useTokenAccountingV2
        ? await getUserDailyTokensV2(pool, userId, periodKey)
        : await getUserDailyTokens(pool, userId, periodKey);
      if (!usage) continue; // no usage that day — don't spam idle users
      const sent = await markReportSent(pool, userId, 'daily', periodKey);
      if (!sent) continue; // already pushed this period
      await notifyUser(pool, userId, dailyReportPush(dateLabel, usage.total, usage.requests)).catch(() => {});
      console.log(`[report] daily pushed to user ${userId}: ${usage.total} tokens, ${usage.requests} reqs`);
    }
  }

  // Weekly report window: UTC Sunday 14:00-14:59 (Beijing Sunday 22:00).
  if (utcDay === 0 && utcHour === 14) {
    // Report the last complete ISO week (Mon–Sun of the previous week).
    // periodKey = the Sunday of last week, the week's end boundary.
    const lastSunday = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Snap to that day's Sunday: getUTCDay may not be 0 after subtracting 7d
    // (it is the same weekday as today minus offset), so recompute.
    const offsetToSunday = (lastSunday.getUTCDay() + 7) % 7;
    lastSunday.setUTCDate(lastSunday.getUTCDate() - offsetToSunday);
    const periodKey = lastSunday.toISOString().slice(0, 10);
    const weekLabel = zhWeekLabel(lastSunday);
    const proUsers = await listProUserIds(pool);
    for (const userId of proUsers) {
      const usage = useTokenAccountingV2
        ? await getUserWeeklyTokensV2(pool, userId, periodKey)
        : await getUserWeeklyTokens(pool, userId, periodKey);
      if (!usage) continue;
      const sent = await markReportSent(pool, userId, 'weekly', periodKey);
      if (!sent) continue;
      await notifyUser(pool, userId, weeklyReportPush(weekLabel, usage.total, usage.requests)).catch(() => {});
      console.log(`[report] weekly pushed to user ${userId}: ${usage.total} tokens, ${usage.requests} reqs`);
    }
  }
}

/** Format a Date as a short Chinese day label: "7月1日". Uses UTC. */
function zhDateLabel(d: Date): string {
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** Format a week (ending on Sunday d) as a short range label: "6/24–6/30". Uses UTC. */
function zhWeekLabel(sunday: Date): string {
  const monday = new Date(sunday.getTime() - 6 * 24 * 60 * 60 * 1000);
  return `${monday.getUTCMonth() + 1}/${monday.getUTCDate()}–${sunday.getUTCMonth() + 1}/${sunday.getUTCDate()}`;
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
  const res = await fetch(RELAY + path, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include' });
  return { ok: res.ok, data: await res.json() };
}

async function sendCode() {
  hideError();
  const email = emailInput.value.trim();
  if (!email.includes('@')) { showError('请输入有效的邮箱地址'); return; }
  const { ok, data } = await api('/api/auth/email/send', { email, lang: 'zh' });
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
  const { ok, data } = await api('/api/auth/email/verify', { email, code, lang: 'zh' });
  if (!ok) { setLoading(loginBtn, false, '登录并授权'); showError(data.error || '验证失败'); return; }
  accessToken = data.access_token;
  userEmail = data.user.email;
  localStorage.removeItem('pocketctl_access_token');
  localStorage.removeItem('pocketctl_refresh_token');
  localStorage.setItem('pocketctl_user', JSON.stringify(data.user));
  setLoading(loginBtn, false, '登录并授权');
  await confirmAuth();
}

async function tryRefreshToken() {
  const savedRefresh = localStorage.getItem('pocketctl_refresh_token');
  const { ok, data } = await api('/api/auth/refresh', savedRefresh ? { refresh_token: savedRefresh } : {});
  localStorage.removeItem('pocketctl_access_token');
  localStorage.removeItem('pocketctl_refresh_token');
  if (!ok) {
    localStorage.removeItem('pocketctl_user');
    accessToken = '';
    return false;
  }
  accessToken = data.access_token;
  userEmail = data.user.email;
  localStorage.setItem('pocketctl_user', JSON.stringify(data.user));
  return true;
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
    // Token expired or invalid: try refresh, then fall back to login form
    if (data.error === 'invalid_token' || data.error === 'authentication_required') {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        await confirmAuth();
        return;
      }
      // Refresh failed — clear "already logged in" and show login form
      document.getElementById('step-already-logged-in').style.display = 'none';
      document.getElementById('step-login').style.display = 'block';
      document.getElementById('title').textContent = '登录以授权设备';
      showError('登录已过期，请重新验证');
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
document.addEventListener('DOMContentLoaded', async () => {
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

  // Check if already logged in. Tokens are memory-only; reload restores from the HttpOnly refresh cookie.
  const refreshed = await tryRefreshToken();
  if (refreshed) {
    try {
      const user = JSON.parse(localStorage.getItem('pocketctl_user') || '{}');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
