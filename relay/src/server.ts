import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import type pg from 'pg';
import { initDB, parseDBUrl, getUserByEmail, getUserById, getUserPlanAndWhitelist, getUserProfile, userExists, deleteUserAccount, registerDevice, removeDevice, cleanStaleTombstones, upsertDaemonAlias, updateDisplayName, addToIOSWaitlist, revokeToken, isTokenRevoked, cleanRevokedTokens, insertAuditLog, bindTokenToDaemon, updateSessionTitle, isSessionOwnedByUser, getSessionAllEvents, getTokenSummary, getTokensByDaemon, backfillSessionTokens, backfillSessionModel, backfillTokenDailyStats, aggregateDayIntoStats, cleanStaleEvents, getTokenDailySeries, getTokenByModel, getTokenByDaemon, getSessionTokenTrend, listProUserIds, getUserDailyTokens, getUserWeeklyTokens, markReportSent, handleRefreshReuse, consumeEmailChallenge, upsertEmailChallenge, cleanExpiredEmailChallenges, cleanStaleAuthRateLimits, bindUserEmailWithChallenge } from './db.js';
import { closeRelayPools, createRelayPools } from './db-pools.js';
import { Router, parseDurableIngressFlag, type FlagConfig } from './router.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken, decodeToken, resolveRefreshMachineId, stableMachineId, verifyAccessTokenWithRevocation, verifyTokenForRevocation } from './auth.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush, dailyReportPush, weeklyReportPush } from './push.js';
import { sendEmailCode } from './config/email.js';
import {
  challengeKey,
  codeHmac,
  emailFingerprint,
  generateCode,
  normalizeEmailAddress,
} from './config/verification.js';
import { validateClient } from './config/clients.js';
import { createDeviceAuthSessionStore, DeviceAuthStoreCapacityError, type DeviceAuthSessionStore } from './config/auth-sessions.js';
import { createQrSessionStore, QrSessionStoreCapacityError, type QrSessionStore } from './config/qr-sessions.js';
import { resolveEntitlements, resolveQuotaEnforcementMode } from './entitlements.js';
import { getQuotaSnapshot } from './quota.js';
import { createPostgresWsTicketPersistence, createWsTicketStore, WsTicketStoreCapacityError } from './config/ws-tickets.js';
import type { WsTicketPayload } from './config/ws-tickets.js';
import { createHash } from 'crypto';
import { ConnectionRateLimiter } from './rate-limit.js';
import { explicitAppReviewCode, isAppReviewEmail, isAppReviewEnabled, isConfiguredAppReviewEmail } from './config/app-review-auth.js';
import { ensureAppReviewDemoData } from './config/app-review-demo.js';
import { resolveLanguage } from './config/language.js';
import { findOrCreateEmailUser } from './email-user.js';
export { findOrCreateEmailUser } from './email-user.js';
import { createWelcomeEmailWorker } from './welcome-email-worker.js';
import { pathToFileURL } from 'node:url';
import { registerDaemonConnection, type DaemonSocketIdentity } from './daemon-registration.js';
import { resolveAuthRateLimitConfig, resolveBuildInfo, resolveCorsOrigin, resolveEmailVerificationConfig, resolvePublicIssuer, resolveRelayListenHost, resolveTrustedProxyConfig, strictPositiveConfig } from './runtime-config.js';
import { createAuthRateLimiter, applyAuthRateLimitDecision } from './auth-rate-limit.js';
import { ConnectionAdmission } from './connection-admission.js';
import { RegistrationDeadline } from './registration-deadline.js';
import { canonicalClientAddress } from './remote-address.js';
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
import { resolveExtensionConfig } from './extensions/config.js';
import { initializeExtensionProviderCatalog } from './extensions/catalog.js';
import { registerExtensionInstallationRoutes } from './extensions/installation-routes.js';
import { registerExtensionScopeRoutes } from './extensions/scope-routes.js';
import { extensionV2ModeFromEnv } from './extensions/config.js';
import { registerV2Routes } from './extensions/v2-routes.js';
import { registerCapabilityV2GrantRoutes } from './extensions/capability-routes.js';
import { registerProviderTokenRoute } from './extensions/provider-auth-routes.js';
import { registerFeedRoutes } from './extensions/feed-routes.js';
import { registerSnapshotRoutes } from './extensions/snapshot-routes.js';
import { registerProviderInstallationRoutes } from './extensions/provider-installation-routes.js';
import { registerCapabilityRoutes } from './extensions/capability-routes.js';
import { resolveGrantKeyMaterial } from './extensions/capability-grant.js';
import { createMemoryContextGrantBroker, createMemoryMcpGrantBroker } from './extensions/grant-service.js';
import { registerStatusRoutes } from './extensions/status-routes.js';
import { registerUsageRoutes } from './extensions/usage-routes.js';
import { registerPurgeRoutes } from './extensions/purge-routes.js';
import { createExtensionRateLimiterSet } from './extensions/rate-limit.js';
import { resolveExtensionRateLimitConfig } from './runtime-config.js';
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

const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/pocketctl';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_CONNECTIONS = parseInt(process.env.RATE_LIMIT_MAX_CONNECTIONS || '30', 10);
const RATE_LIMIT_BURST_WINDOW_MS = parseInt(process.env.RATE_LIMIT_BURST_WINDOW_MS || '10000', 10);
const RATE_LIMIT_BURST_MAX = parseInt(process.env.RATE_LIMIT_BURST_MAX || '5', 10);
const RATE_LIMIT_AUTH_FAIL_THRESHOLD = parseInt(process.env.RATE_LIMIT_AUTH_FAIL_THRESHOLD || '3', 10);
const REFRESH_COOKIE_NAME = 'pocketctl_refresh_token';
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const DAEMON_REGISTRATION_DEADLINE_MS = 10_000;

const wsDaemonMap = new Map<any, DaemonSocketIdentity>();
// M-2: bounded temporary auth-session stores. Hard caps are the last line of
// defense behind the shared PostgreSQL rate limits; see config/*.ts factories.
const deviceAuthSessions = createDeviceAuthSessionStore();
const qrSessions = createQrSessionStore();

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
  /** M-3: max messages buffered per connection before authentication resolves. */
  preAuthMaxMessages: number;
  /** M-3: max total bytes buffered per connection before authentication resolves. */
  preAuthMaxBytes: number;
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
  const preAuthMaxMessages = strictPositiveConfig(env, 'RELAY_PREAUTH_MAX_MESSAGES', 4);
  const preAuthMaxBytes = strictPositiveConfig(env, 'RELAY_PREAUTH_MAX_BYTES', 2 * maxEventBytes);
  if (eventWindow > 65_536) {
    throw new Error('RELAY_DURABLE_INGRESS_WINDOW must be at most 65536');
  }
  if (maxChunkBytes > maxEventBytes) {
    throw new Error('MAX_CHUNK_BYTES must not exceed MAX_WS_MESSAGE_SIZE');
  }
  if (replayBatchMaxBytes > maxEventBytes) {
    throw new Error('REPLAY_BATCH_MAX_BYTES must not exceed MAX_WS_MESSAGE_SIZE');
  }
  if (preAuthMaxBytes > 2 * maxEventBytes) {
    throw new Error('RELAY_PREAUTH_MAX_BYTES must not exceed 2 x MAX_WS_MESSAGE_SIZE');
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
    preAuthMaxMessages,
    preAuthMaxBytes,
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
  store: { consume(ticket: string): Promise<WsTicketPayload | null> },
  ticket: string,
  pool: any,
): Promise<WsTicketPayload | null> {
  const payload = await store.consume(ticket);
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

export interface DeviceAuthorizeRouteDeps {
  store: Pick<DeviceAuthSessionStore, 'create'>;
  validateClient: (clientId: string) => { token_endpoint_auth_method: string } | null;
  webAppUrl: string | ((req: any) => string);
}

/** POST /api/auth/device/authorize — RFC 8628 §3.1 (M-2: bounded store). */
export async function handleDeviceAuthorizeRequest(
  req: any,
  reply: any,
  deps: DeviceAuthorizeRouteDeps,
): Promise<Record<string, unknown>> {
  const { client_id, code_challenge, code_challenge_method, machine_id } = req.body as any;

  if (!client_id) {
    reply.code(400);
    return { error: 'invalid_request', error_description: 'client_id is required' };
  }
  const client = deps.validateClient(client_id);
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

  let result: { device_code: string; user_code: string; expires_in: number; interval: number };
  try {
    result = deps.store.create(client_id, code_challenge, machine_id);
  } catch (error) {
    if (error instanceof DeviceAuthStoreCapacityError || (error as any)?.name === 'DeviceAuthStoreCapacityError') {
      reply.header('Retry-After', 10);
      reply.code(503);
      return { error: 'temporarily_unavailable', error_description: 'server busy, please retry later' };
    }
    throw error;
  }
  const base = typeof deps.webAppUrl === 'function' ? deps.webAppUrl(req) : deps.webAppUrl;
  const verificationUri = `${base}/login/cli`;
  reply.code(200);
  return {
    device_code: result.device_code,
    user_code: result.user_code,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?code=${result.user_code}`,
    expires_in: result.expires_in,
    interval: result.interval,
  };
}

export interface DeviceTokenRouteDeps {
  store: Pick<DeviceAuthSessionStore, 'getByDeviceCode' | 'registerPoll' | 'deleteSession'>;
  validateClient: (clientId: string) => { token_endpoint_auth_method: string } | null;
  getUserById(userId: number): Promise<{ id: number; email: string; phone: string | null } | null>;
  signAccessToken(userId: number, email: string, phone?: string, machineId?: string): Promise<string>;
  signRefreshToken(userId: number, machineId?: string): Promise<string>;
  insertAuditLog(...args: any[]): Promise<unknown>;
  setRefreshCookie(reply: any, token: string): void;
  rejectIfRateLimited(reply: any, ...specs: unknown[]): Promise<boolean>;
  pollIpMax: number;
}

/**
 * POST /api/auth/device/token — RFC 8628 §3.5.
 *
 * M-2/M-3: every poll on a live session is recorded before any pending/success
 * outcome; polls faster than the code's current interval answer slow_down and
 * increase that code's interval. The client_id must match the authorization
 * request, and unknown codes create no polling state.
 */
export async function handleDeviceTokenRequest(
  req: any,
  reply: any,
  deps: DeviceTokenRouteDeps,
): Promise<Record<string, unknown>> {
  const { grant_type, device_code, client_id, code_verifier } = req.body as any;

  if (grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
    reply.code(400);
    return { error: 'unsupported_grant_type' };
  }
  if (!device_code || !client_id) {
    reply.code(400);
    return { error: 'invalid_request' };
  }

  if (await deps.rejectIfRateLimited(reply, {
    scope: 'auth:device:token',
    windowMs: 60_000,
    ip: { value: canonicalClientAddress(req.ip), limit: deps.pollIpMax },
  })) return { error: 'too many requests, please retry later' };

  const client = deps.validateClient(client_id);
  if (!client) {
    reply.code(400);
    return { error: 'invalid_client' };
  }

  const session = deps.store.getByDeviceCode(device_code);
  if (!session) {
    reply.code(400);
    return { error: 'expired_token', error_description: 'device_code has expired' };
  }

  if (session.client_id !== client_id) {
    reply.code(400);
    return { error: 'invalid_grant', error_description: 'client_id does not match the authorization request' };
  }

  const poll = deps.store.registerPoll(device_code);
  if (poll.action === 'slow_down') {
    reply.code(400);
    return { error: 'slow_down', interval: poll.intervalSeconds };
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
  const user = await deps.getUserById(session.user_id!);
  if (!user) {
    reply.code(500);
    return { error: 'server_error', error_description: 'user not found' };
  }

  const machineId = stableMachineId(session.machine_id);
  const accessToken = await deps.signAccessToken(user.id, user.email, user.phone ?? undefined, machineId);
  const refreshToken = await deps.signRefreshToken(user.id, machineId);
  deps.setRefreshCookie(reply, refreshToken);

  // Clean up the session and its user-code index atomically with issuance.
  deps.store.deleteSession(device_code);

  deps.insertAuditLog(user.id, 'token_issued', {
    client_id,
    machine_id: machineId || 'unknown',
    grant_type: 'device_code',
  }, req.ip).catch(() => {});

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 86400,
  };
}

export interface TokenRevocationRouteDeps {
  pool: any;
  verifyCallerAccessToken(token: string): Promise<{ userId: number; email: string; jti: string; machine_id: string } | null>;
  verifyForRevocation(token: string): { type: 'access' | 'refresh'; userId: number; jti: string; exp: number } | null;
  revokeToken(
    pool: any,
    jti: string,
    userId: number,
    reason: string,
    options?: { tokenType?: 'access' | 'refresh'; expiresAt?: Date },
  ): Promise<void>;
  insertAuditLog(pool: any, userId: number | null, action: string, details: Record<string, unknown>, ip?: string): Promise<unknown>;
  pepper: string;
  rejectIfRateLimited(reply: any, ...specs: unknown[]): Promise<boolean>;
}

/**
 * POST /api/auth/revoke — RFC 7009 (M-5).
 *
 * The submitted token is verified cryptographically (signature, HS256-only,
 * exact type, positive userId, bounded jti) before anything is written, and
 * only the authenticated caller's own tokens are revoked. Invalid, forged or
 * third-party tokens answer an empty 200 — never 403 — so the endpoint is not
 * a token-validity oracle. Audits store only short peppered fingerprints.
 */
export async function handleTokenRevocationRequest(
  req: any,
  reply: any,
  deps: TokenRevocationRouteDeps,
): Promise<Record<string, unknown>> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401);
    return { error: 'authorization required' };
  }
  const caller = await deps.verifyCallerAccessToken(authHeader.slice(7));
  if (!caller) {
    reply.code(401);
    return { error: 'invalid token' };
  }

  const { token, token_type_hint } = (req.body || {}) as any;
  if (!token) {
    reply.code(400);
    return { error: 'invalid_request', error_description: 'token is required' };
  }

  if (await deps.rejectIfRateLimited(reply, {
    scope: 'auth:token-ops',
    windowMs: 60_000,
    ip: { value: canonicalClientAddress(req.ip), limit: 120 },
    identity: { value: token, limit: 30 },
  })) return { error: 'too many requests, please retry later' };

  const jtiFingerprint = (jti: string) =>
    createHash('sha256').update(`revocation:${jti}`).digest('hex').slice(0, 12);

  const claims = deps.verifyForRevocation(token);
  if (!claims) {
    await deps.insertAuditLog(deps.pool, caller.userId, 'token_revoke', {
      jti_fingerprint: null, outcome: 'invalid_token', token_type_hint: token_type_hint || 'unknown',
    }, canonicalClientAddress(req.ip)).catch(() => {});
    reply.code(200);
    return {};
  }
  if (claims.userId !== caller.userId) {
    await deps.insertAuditLog(deps.pool, caller.userId, 'token_revoke', {
      jti_fingerprint: jtiFingerprint(claims.jti), outcome: 'not_owner', token_type: claims.type,
    }, canonicalClientAddress(req.ip)).catch(() => {});
    reply.code(200);
    return {};
  }

  await deps.revokeToken(deps.pool, claims.jti, claims.userId, 'user_revoke', {
    tokenType: claims.type,
    expiresAt: new Date(claims.exp * 1000),
  });
  await deps.insertAuditLog(deps.pool, caller.userId, 'token_revoke', {
    jti_fingerprint: jtiFingerprint(claims.jti), outcome: 'revoked', token_type: claims.type,
  }, canonicalClientAddress(req.ip)).catch(() => {});

  reply.code(200);
  return {};
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
  preAuthMaxMessages: number;
  preAuthMaxBytes: number;
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

    // M-1: req.ip is the Fastify-authoritative client address. With
    // trustProxy: false | string[] a peer outside the explicit proxy list can
    // never inject X-Forwarded-For into it, so REST routes, WS admission and
    // the auth-failure ban share one canonical address.
    const clientIp = canonicalClientAddress(req.ip);

    const decision = dependencies.rateLimiter.check(clientIp);
    if (dependencies.random() < 0.01) dependencies.rateLimiter.gc();
    if (!decision.allowed) {
      socket.close(4029, decision.reason || 'rate limit exceeded');
      return;
    }

    const authHeader = req.headers['authorization'] as string | undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const ticket = query.ticket as string;
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
    // M-3: admission release must be idempotent — overflow, close, auth
    // failure, the registration deadline and successful registration can all
    // race on the same connection.
    let admissionReleased = false;
    const releaseAdmission = () => {
      if (admissionReleased) return;
      admissionReleased = true;
      admission.release();
    };

    const earlyMessages: Buffer[] = [];
    // M-3: hard bounds on pre-authentication buffering. Overflow closes the
    // socket immediately, drops every buffered reference, and marks the
    // connection so a later auth success can never feed the Router.
    let preAuthMessageCount = 0;
    let preAuthTotalBytes = 0;
    let preAuthTerminated = false;
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
        if (preAuthTerminated) return;
        if (
          raw.length > dependencies.preAuthMaxBytes
          || preAuthMessageCount + 1 > dependencies.preAuthMaxMessages
          || preAuthTotalBytes + raw.length > dependencies.preAuthMaxBytes
        ) {
          preAuthTerminated = true;
          earlyMessages.length = 0;
          registrationDeadline?.complete();
          releaseAdmission();
          if (socket.readyState === 1) socket.close(1009, 'message too large');
          return;
        }
        preAuthMessageCount += 1;
        preAuthTotalBytes += raw.length;
        earlyMessages.push(raw);
        return;
      }
      enqueueMessage(raw);
    });

    socket.on('close', () => {
      preAuthTerminated = true;
      earlyMessages.length = 0;
      preAuthMessageCount = 0;
      preAuthTotalBytes = 0;
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
      } else {
        // H-3: the legacy global API key identity is deleted. Any api_key
        // query parameter falls through here and is rejected exactly like a
        // missing credential.
        const banSec = dependencies.rateLimiter.recordAuthFailure(clientIp);
        console.log(`WS rejected: type=${connType} ip=${clientIp} reason=auth_required${banSec ? ` banned=${banSec}s` : ''}`);
        registrationDeadline?.complete();
        releaseAdmission();
        socket.close(4001, 'authentication required');
        return;
      }

      if (connType === 'daemon' && !registrationDeadline?.isActive()) return;

      // M-3: the pre-auth queue overflowed and already released admission and
      // closed the socket; authentication completing afterwards must not feed
      // the Router or re-register the connection.
      if (preAuthTerminated || socket.readyState !== 1) {
        registrationDeadline?.complete();
        return;
      }

      dependencies.rateLimiter.clearAuthFailure(clientIp);
      authDone = true;
      console.log(`WS connected: type=${connType} ip=${clientIp} user=${userId}`);

      if (connType !== 'daemon') {
        dependencies.router.registerClient(socket, userId);
        releaseAdmission();
      }

      if (!preAuthTerminated) {
        for (const raw of earlyMessages) enqueueMessage(raw);
      }
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
  // M-1: only explicitly listed reverse proxies may set forwarding headers.
  // Production fails closed when a non-loopback listener has no trust list.
  const trustedProxy = resolveTrustedProxyConfig(process.env)
  const listenHost = resolveRelayListenHost(process.env)
  // M-4: quota enforcement is fail-closed at startup — production SaaS must
  // run enforce; invalid or missing values abort the boot.
  resolveQuotaEnforcementMode(process.env)
  // Fails startup in production when AUTH_CODE_PEPPER is missing/short or any
  // DEV_EMAIL/DEV_EMAIL_CODE backdoor variable is present (H-1/H-4).
  const emailVerification = resolveEmailVerificationConfig(process.env)
  // M-2: shared PostgreSQL auth rate limiting with HMAC-fingerprinted keys.
  const authRateLimitPolicy = resolveAuthRateLimitConfig(process.env)
  const authRateLimiter = createAuthRateLimiter({ pepper: emailVerification.pepper })
  const runtimeConfig = resolveRelayRuntimeConfig(process.env)
  // ADR-0003: extension flag fails closed — invalid values or an
  // enabled production deployment without provider key material abort boot.
  const extensionConfig = resolveExtensionConfig(process.env)
  // Resolve capability signing material exactly once. In development the
  // fallback key is generated in memory, so resolving separately for the
  // HTTP route and daemon broker would produce grants that the published
  // JWKS cannot verify.
  const extensionGrantKeys = resolveGrantKeyMaterial(process.env, {
    strictProduction: extensionConfig.mode === 'enabled',
  })
  const tokenFeatures = tokenUsageFeatures(process.env)
  const attentionConfig = attentionInboxConfig(process.env)
  assertTokenUsageFeatureDependencies(tokenFeatures, runtimeConfig.durableIngress.mode)
  const pools = createRelayPools(parseDBUrl(DB_URL))
  const pool = pools.query
  const wsTickets = createWsTicketStore(createPostgresWsTicketPersistence(pools.control), 60_000)
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
    ...(extensionConfig.mode === 'enabled' ? {
      memoryMcpGrantBroker: createMemoryMcpGrantBroker({
        pool: pools.control,
        issuer: publicIssuer,
        mode: extensionConfig.mode,
        providerPublicOrigins: extensionConfig.providerPublicOrigins,
        grantKeys: extensionGrantKeys,
      }),
      memoryContextGrantBroker: createMemoryContextGrantBroker({
        pool: pools.control,
        issuer: publicIssuer,
        mode: extensionConfig.mode,
        providerPublicOrigins: extensionConfig.providerPublicOrigins,
        grantKeys: extensionGrantKeys,
      }),
    } : {}),
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
      const catalogReady = await initializeExtensionProviderCatalog(pools.query, extensionConfig.mode)
      if (!catalogReady) console.warn('[extensions] provider catalog unavailable while extensions are off')
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
  const app = Fastify({ logger: false, trustProxy: trustedProxy });

  /**
   * M-2: enforce shared auth rate-limit buckets for a request. Returns true
   * when the request was rejected (429/503 already set on the reply) — the
   * caller must return immediately with a generic, non-enumerating body.
   */
  const rejectIfRateLimited = async (
    reply: any,
    ...specs: Array<{ scope: string; windowMs: number; ip?: { value: string; limit: number }; identity?: { value: string; limit: number } }>
  ): Promise<boolean> => {
    for (const spec of specs) {
      const decision = await authRateLimiter.enforce(pool, spec)
      if (applyAuthRateLimitDecision(reply, decision)) return true
    }
    return false
  }

  await app.register(fastifyCors, { origin: corsOrigin, credentials: true });
  // M-3: the ws protocol layer enforces maxPayload before a huge frame is
  // ever assembled; the handler's pre-auth queue adds count/byte caps on top.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: runtimeConfig.maxEventBytes },
  });
  registerSessionShareRoutes(app, { pool, publicIssuer });
  registerAttentionInboxRoutes(app, {
    pool,
    config: attentionConfig,
    repository: attentionRepository,
    recoveryRepository,
    service: attentionService,
    verifyAccessToken: (token, authPool) => verifyAccessTokenWithRevocation(token, authPool),
  });
  // ADR-0003 extension user control plane. Catalog initialization is awaited
  // in the database readiness chain after initDB creates its schema.
  registerExtensionInstallationRoutes(app, {
    pool,
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    mode: extensionConfig.mode,
    cursorSecret: extensionConfig.cursorSecret || publicIssuer,
  });
  // ADR-0005 v2 scope administration. Independent flag (ADR-P3-13): flipping
  // RELAY_EXTENSION_V2 never changes v1 extension behavior.
  registerExtensionScopeRoutes(app, {
    pool,
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    v2Mode: extensionV2ModeFromEnv(),
  });
  const extensionRateLimits = createExtensionRateLimiterSet(
    resolveExtensionRateLimitConfig(process.env),
  )
  registerProviderTokenRoute(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    rateLimiter: extensionRateLimits.token,
  });
  registerFeedRoutes(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    cursorSecret: extensionConfig.cursorSecret || publicIssuer,
    leaseTtlSeconds: extensionConfig.leaseTtlSeconds,
    rateLimiter: extensionRateLimits.feed,
    ackRateLimiter: extensionRateLimits.ack,
  });
  registerV2Routes(app, {
    pool,
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    v2Mode: extensionV2ModeFromEnv(),
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    cursorSecret: extensionConfig.cursorSecret || publicIssuer,
    leaseTtlSeconds: extensionConfig.leaseTtlSeconds,
  });
  registerSnapshotRoutes(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    cursorSecret: extensionConfig.cursorSecret || publicIssuer,
    rateLimiter: extensionRateLimits.snapshot,
  });
  registerCapabilityRoutes(app, {
    pool,
    verifyAccessToken: (token, authPool) => verifyAccessTokenWithRevocation(token, authPool as typeof pool),
    mode: extensionConfig.mode,
    issuer: publicIssuer,
    rateLimiter: extensionRateLimits.grant,
    providerPublicOrigins: extensionConfig.providerPublicOrigins,
    grantKeys: extensionGrantKeys,
  });
  registerCapabilityV2GrantRoutes(app, {
    pool,
    verifyAccessToken: (token, authPool) => verifyAccessTokenWithRevocation(token, authPool as typeof pool),
    mode: extensionConfig.mode,
    v2Mode: extensionV2ModeFromEnv(),
    issuer: publicIssuer,
    ttlSeconds: 60,
    providerPublicOrigins: extensionConfig.providerPublicOrigins,
    grantKeys: extensionGrantKeys,
  });
  registerStatusRoutes(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    rateLimiter: extensionRateLimits.status,
  });
  registerUsageRoutes(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    verifyAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
    rateLimiter: extensionRateLimits.usage,
  });
  registerPurgeRoutes(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    rateLimiter: extensionRateLimits.purge,
    ackRateLimiter: extensionRateLimits.ack,
  });
  registerProviderInstallationRoutes(app, {
    pool,
    mode: extensionConfig.mode,
    providerJwtSecret: extensionConfig.providerJwtSecret,
    issuer: publicIssuer,
    cursorSecret: extensionConfig.cursorSecret || publicIssuer,
    rateLimiter: extensionRateLimits.installations,
  });

  // ---- REST API: Auth ----

  // Password registration cannot establish ownership of the supplied mailbox.
  // Keep an explicit terminal response for older clients instead of allowing
  // them to pre-claim an address that its owner may later use for code login.
  app.post('/api/auth/register', async (_req, reply) => {
    reply.code(410);
    return {
      error: 'password registration has been retired; verify the email address first',
      verification_endpoint: '/api/auth/email/send',
    };
  });

  // A password stored before email ownership became mandatory cannot prove who
  // owns that mailbox. Retire this path so pre-hijacked accounts cannot retain
  // access after the real owner authenticates with a one-time email code.
  app.post('/api/auth/login', async (_req, reply) => {
    reply.header('Deprecation', 'true');
    reply.header('Sunset', 'Sat, 01 Nov 2026 00:00:00 GMT');
    reply.code(410);
    return {
      error: 'password login has been retired; verify the email address instead',
      verification_endpoint: '/api/auth/email/send',
    };
  });

  // Refresh token (with rotation and breach detection)
  app.post('/api/auth/refresh', async (req, reply) => {
    const body = (req.body || {}) as any;
    const refresh_token = parseCookie(req.headers.cookie, REFRESH_COOKIE_NAME) || body.refresh_token;
    if (!refresh_token) {
      reply.code(400); return { error: 'refresh_token is required' };
    }
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:token-ops',
      windowMs: 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.tokenOps.ipMax },
      identity: { value: refresh_token, limit: authRateLimitPolicy.tokenOps.tokenMax },
    })) return { error: 'too many requests, please retry later' };
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

    const machineId = resolveRefreshMachineId(payload.machine_id, body.machine_id);
    const accessToken = await signAccessToken(user.id, user.email, user.phone, machineId);
    const newRefreshToken = await signRefreshToken(user.id, machineId);
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
    const logoutBuckets: Array<{ scope: string; windowMs: number; ip?: { value: string; limit: number }; identity?: { value: string; limit: number } }> = [{
      scope: 'auth:token-ops',
      windowMs: 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.tokenOps.ipMax },
    }]
    if (refreshToken) {
      logoutBuckets[0].identity = { value: refreshToken, limit: authRateLimitPolicy.tokenOps.tokenMax }
    }
    if (await rejectIfRateLimited(reply, ...logoutBuckets)) return { error: 'too many requests, please retry later' };
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
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:ws-ticket',
      windowMs: 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.wsTicket.ipMax },
      identity: { value: `user:${payload.userId}`, limit: authRateLimitPolicy.wsTicket.userMax },
    })) return { error: 'too many requests, please retry later' };
    let issued: { ticket: string; expiresIn: number };
    try {
      issued = await wsTickets.create(payload);
    } catch (error) {
      if (error instanceof WsTicketStoreCapacityError) {
        reply.header('Retry-After', 10);
        reply.code(503);
        return { error: 'server busy, please retry later' };
      }
      throw error;
    }
    return { ticket: issued.ticket, expires_in: issued.expiresIn };
  });

  // Apple Sign In (Phase 3)

  // ---- REST API: Email Verification Code Auth ----

  // Send email verification code
  app.post('/api/auth/email/send', async (req, reply) => {
    const { email, lang: bodyLang } = req.body as any;
    if (!email) {
      reply.code(400); return { error: 'email is required' };
    }
    const normalizedEmail = normalizeEmailAddress(email);
    if (!normalizedEmail) {
      reply.code(400); return { error: 'invalid email format' };
    }
    if (isConfiguredAppReviewEmail(normalizedEmail) && !isAppReviewEnabled()) {
      reply.code(403); return { error: 'App Review account is disabled' };
    }

    const lang = resolveLanguage(bodyLang, req.headers['accept-language']);
    const now = new Date();
    const fingerprint = emailFingerprint(normalizedEmail, emailVerification.pepper);
    const loginChallengeKey = challengeKey(emailVerification.pepper, 'login', normalizedEmail, null);

    // Database-backed per-IP / per-email send limits, shared across Relay
    // replicas (M-2: HMAC-fingerprinted keys, fail-closed on backend errors).
    // The 429 response never reveals whether the email exists.
    const clientIp = canonicalClientAddress(req.ip);
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:email:send',
      windowMs: 60 * 60_000,
      ip: { value: clientIp, limit: authRateLimitPolicy.emailSend.ipMax },
      identity: { value: normalizedEmail, limit: authRateLimitPolicy.emailSend.emailMax },
    })) return { error: 'too many requests, please retry later' };

    // App Review account: the reviewer's fixed code is issued through the
    // same challenge store (attempt budget, lockout and cooldown all apply)
    // and is never emailed or returned. The code must be configured
    // explicitly; the source-code default is gone.
    if (isAppReviewEmail(normalizedEmail)) {
      const appReviewCode = explicitAppReviewCode();
      if (!appReviewCode) {
        reply.code(403); return { error: 'App Review account is disabled' };
      }
      const decision = await upsertEmailChallenge(pool, {
        challengeKey: loginChallengeKey,
        purpose: 'login',
        normalizedEmail,
        userId: null,
        codeHmac: codeHmac(appReviewCode, emailVerification.pepper),
        now,
      });
      if (decision.status === 'cooldown') {
        reply.header('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
        reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
      }
      return { success: true, message: 'verification code sent' };
    }

    // Dev/test shortcut: only outside production and only when both
    // DEV_EMAIL and a 6-digit DEV_EMAIL_CODE are explicitly configured
    // (resolveEmailVerificationConfig fails startup otherwise).
    if (emailVerification.devShortcutEnabled && normalizedEmail === emailVerification.devEmail) {
      const decision = await upsertEmailChallenge(pool, {
        challengeKey: loginChallengeKey,
        purpose: 'login',
        normalizedEmail,
        userId: null,
        codeHmac: codeHmac(emailVerification.devCode!, emailVerification.pepper),
        now,
      });
      if (decision.status === 'cooldown') {
        reply.header('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
        reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
      }
      return { success: true, message: 'verification code sent', code: emailVerification.devCode };
    }

    // Dev mode without the DEV shortcut configured
    if (NODE_ENV !== 'production' && !emailVerification.devShortcutEnabled) {
      reply.code(400);
      return { error: '开发模式邮箱登录未配置，请设置 DEV_EMAIL 和 DEV_EMAIL_CODE 环境变量' };
    }

    // CSPRNG code stored only as a peppered HMAC digest
    const code = generateCode();
    const decision = await upsertEmailChallenge(pool, {
      challengeKey: loginChallengeKey,
      purpose: 'login',
      normalizedEmail,
      userId: null,
      codeHmac: codeHmac(code, emailVerification.pepper),
      now,
    });
    if (decision.status === 'cooldown') {
      reply.header('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
      reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
    }

    // Send via Tencent Cloud SES (production) or return code in dev
    if (NODE_ENV === 'production') {
      try {
        await sendEmailCode(normalizedEmail, code, lang);
      } catch (err: any) {
        // Never log the address or the code — fingerprint + error name only.
        console.error(`[email] send failed for ${fingerprint}:`, err instanceof Error ? err.name : 'unknown');
        reply.code(500);
        return { error: '验证码发送失败，请稍后重试' };
      }
      return { success: true, message: 'verification code sent' };
    }

    // Dev mode: return code in response for testing (never in production)
    return { success: true, message: 'verification code sent', code };
  });

  // Verify email code and login/register
  app.post('/api/auth/email/verify', async (req, reply) => {
    const { email, code, lang: bodyLang, machine_id: requestedMachineId } = req.body as any;
    if (!email || !code) {
      reply.code(400); return { error: 'email and code are required' };
    }
    const normalizedEmail = normalizeEmailAddress(email);
    if (!normalizedEmail || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      reply.code(400); return { error: 'invalid email or code format' };
    }
    const locale = resolveLanguage(bodyLang, req.headers['accept-language']);
    if (isConfiguredAppReviewEmail(normalizedEmail) && !isAppReviewEnabled()) {
      reply.code(403); return { error: 'App Review account is disabled' };
    }
    const now = new Date();
    // Per-IP verify throttle; the per-challenge attempt budget and lockout
    // are enforced transactionally inside consumeEmailChallenge.
    const clientIp = canonicalClientAddress(req.ip);
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:email:verify',
      windowMs: 15 * 60_000,
      ip: { value: clientIp, limit: authRateLimitPolicy.emailVerify.ipMax },
    })) return { error: 'too many attempts, please retry later' };
    const status = await consumeEmailChallenge(pool, {
      challengeKey: challengeKey(emailVerification.pepper, 'login', normalizedEmail, null),
      presentedCodeHmac: codeHmac(code, emailVerification.pepper),
      now,
    });
    if (status !== 'ok') {
      // Deliberately generic: locked, invalid and expired are indistinguishable.
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
    const machineId = stableMachineId(requestedMachineId);
    const accessToken = await signAccessToken(user.id, user.email, user.phone ?? undefined, machineId);
    const refreshToken = await signRefreshToken(user.id, machineId);
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
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:apple',
      windowMs: 15 * 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.apple.ipMax },
    })) return { error: 'too many requests, please retry later' };
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

  // Two-phase verified email binding (H-2): the target address must receive
  // a bind-scoped code before the account email can change.
  app.post('/api/user/email/send-code', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { email, lang: bodyLang } = req.body as any;
    const normalizedEmail = normalizeEmailAddress(email);
    if (!normalizedEmail) {
      reply.code(400); return { error: 'valid email is required' };
    }
    const now = new Date();
    const clientIp = canonicalClientAddress(req.ip);
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:bind:send',
      windowMs: 60 * 60_000,
      ip: { value: clientIp, limit: authRateLimitPolicy.bindSend.ipMax },
      identity: { value: normalizedEmail, limit: authRateLimitPolicy.bindSend.emailMax },
    })) return { error: 'too many requests, please retry later' };
    const bindChallengeKey = challengeKey(emailVerification.pepper, 'bind_email', normalizedEmail, payload.userId);
    // Refuse up front when the target already belongs to another account —
    // no code is mailed for an address the caller cannot obtain.
    const existing = await getUserByEmail(pool, normalizedEmail);
    if (existing && existing.id !== payload.userId) {
      reply.code(409); return { error: '该邮箱已被其他账号绑定' };
    }
    if (existing && existing.id === payload.userId) {
      reply.code(400); return { error: '该邮箱已是当前账号的邮箱' };
    }

    const code = generateCode();
    const decision = await upsertEmailChallenge(pool, {
      challengeKey: bindChallengeKey,
      purpose: 'bind_email',
      normalizedEmail,
      userId: payload.userId,
      codeHmac: codeHmac(code, emailVerification.pepper),
      now,
    });
    if (decision.status === 'cooldown') {
      reply.header('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
      reply.code(429); return { error: '请等待 60 秒后再重新获取验证码' };
    }
    if (NODE_ENV === 'production') {
      try {
        await sendEmailCode(normalizedEmail, code, resolveLanguage(bodyLang, req.headers['accept-language']));
      } catch (err: any) {
        const fingerprint = emailFingerprint(normalizedEmail, emailVerification.pepper);
        console.error(`[email] bind code send failed for ${fingerprint}:`, err instanceof Error ? err.name : 'unknown');
        reply.code(500);
        return { error: '验证码发送失败，请稍后重试' };
      }
      return { success: true, message: 'verification code sent' };
    }
    return { success: true, message: 'verification code sent', code };
  });

  // Bind email to user account (requires the bind-scoped verification code)
  app.put('/api/user/email', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401); return { error: 'authorization required' };
    }
    const payload = await verifyAccessTokenWithRevocation(authHeader.slice(7), pool);
    if (!payload) {
      reply.code(401); return { error: 'invalid token' };
    }
    const { email, code } = req.body as any;
    const normalizedEmail = normalizeEmailAddress(email);
    if (!normalizedEmail || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      reply.code(400); return { error: 'valid email and 6-digit code are required' };
    }
    const now = new Date();
    const clientIp = canonicalClientAddress(req.ip);
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:bind:verify',
      windowMs: 15 * 60_000,
      ip: { value: clientIp, limit: authRateLimitPolicy.bindVerify.ipMax },
    })) return { error: 'too many attempts, please retry later' };
    let result;
    try {
      result = await bindUserEmailWithChallenge(pool, {
        userId: payload.userId,
        email: normalizedEmail,
        presentedCodeHmac: codeHmac(code, emailVerification.pepper),
        challengeKey: challengeKey(emailVerification.pepper, 'bind_email', normalizedEmail, payload.userId),
        now,
      });
    } catch (err: any) {
      if (err.code === '23505') {
        reply.code(409); return { error: '该邮箱已被其他账号绑定' };
      }
      throw err;
    }
    const fingerprint = emailFingerprint(normalizedEmail, emailVerification.pepper);
    if (result === 'ok') {
      await insertAuditLog(pool, payload.userId, 'email_bind', { target_email_fingerprint: fingerprint, outcome: 'ok' }, clientIp);
      return { success: true };
    }
    if (result === 'conflict') {
      await insertAuditLog(pool, payload.userId, 'email_bind', { target_email_fingerprint: fingerprint, outcome: 'conflict' }, clientIp);
      reply.code(409); return { error: '该邮箱已被其他账号绑定' };
    }
    if (result === 'invalid_user') {
      reply.code(401); return { error: 'invalid token' };
    }
    await insertAuditLog(pool, payload.userId, 'email_bind', { target_email_fingerprint: fingerprint, outcome: 'invalid_code' }, clientIp);
    reply.code(400); return { error: 'invalid or expired verification code' };
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
    const clientIp = canonicalClientAddress(req.ip);
    if (await rejectIfRateLimited(reply,
      {
        scope: 'auth:device:authorize',
        windowMs: 60_000,
        ip: { value: clientIp, limit: authRateLimitPolicy.deviceAuthorize.perMinute },
      },
      {
        scope: 'auth:device:authorize:hourly',
        windowMs: 60 * 60_000,
        ip: { value: clientIp, limit: authRateLimitPolicy.deviceAuthorize.perHour },
      },
    )) return { error: 'too many requests, please retry later' };
    return handleDeviceAuthorizeRequest(req, reply, {
      store: deviceAuthSessions,
      validateClient,
      webAppUrl: (innerReq) => process.env.WEB_APP_URL || `http://${innerReq.hostname}:${PORT}`,
    });
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

    if (await rejectIfRateLimited(reply, {
      scope: 'auth:device:confirm',
      windowMs: 10 * 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.confirm.ipMax },
      identity: { value: `user:${payload.userId}`, limit: authRateLimitPolicy.confirm.userMax },
    })) return { error: 'too many requests, please retry later' };

    const ok = deviceAuthSessions.authorize(user_code, payload.userId);
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
    return handleDeviceTokenRequest(req, reply, {
      store: deviceAuthSessions,
      validateClient,
      getUserById: (userId: number) => getUserById(pool, userId),
      signAccessToken,
      signRefreshToken,
      insertAuditLog: (userId: number | null, action: string, details: Record<string, unknown>, ip?: string) =>
        insertAuditLog(pool, userId, action, details, ip),
      setRefreshCookie: (r: any, token: string) => setRefreshCookie(r, token),
      rejectIfRateLimited,
      pollIpMax: authRateLimitPolicy.poll.ipMax,
    });
  });

  // Token Revocation Endpoint (RFC 7009) — signature-verified (M-5)
  app.post('/api/auth/revoke', async (req, reply) => {
    return handleTokenRevocationRequest(req, reply, {
      pool,
      verifyCallerAccessToken: (token) => verifyAccessTokenWithRevocation(token, pool),
      verifyForRevocation: verifyTokenForRevocation,
      revokeToken,
      insertAuditLog,
      pepper: emailVerification.pepper,
      rejectIfRateLimited,
    });
  });

  // ---- QR Scan-Login (web displays QR → iOS scans → iOS confirms → web polls for token) ----

  // Web creates a QR login session and renders the QR payload
  app.post('/api/auth/qr/create', async (req, reply) => {
    const clientIp = canonicalClientAddress(req.ip);
    if (await rejectIfRateLimited(reply,
      {
        scope: 'auth:qr:create',
        windowMs: 60_000,
        ip: { value: clientIp, limit: authRateLimitPolicy.qrCreate.perMinute },
      },
      {
        scope: 'auth:qr:create:hourly',
        windowMs: 60 * 60_000,
        ip: { value: clientIp, limit: authRateLimitPolicy.qrCreate.perHour },
      },
    )) return { error: 'too many requests, please retry later' };
    let result: { qr_token: string; expires_in: number };
    try {
      result = qrSessions.create();
    } catch (error) {
      if (error instanceof QrSessionStoreCapacityError) {
        reply.header('Retry-After', 10);
        reply.code(503);
        return { error: 'temporarily_unavailable', error_description: 'server busy, please retry later' };
      }
      throw error;
    }
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
    if (await rejectIfRateLimited(reply, {
      scope: 'auth:qr:status',
      windowMs: 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.poll.ipMax },
    })) return { error: 'too many requests, please retry later' };
    const session = qrSessions.get(qr_token);
    if (!session) {
      reply.code(200);
      return { status: 'expired' as const };
    }

    // Once confirmed, issue JWTs and consume the session.
    if (session.status === 'confirmed' && session.user_id != null) {
      const user = await getUserById(pool, session.user_id);
      qrSessions.delete(qr_token); // single-use
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

    if (await rejectIfRateLimited(reply, {
      scope: 'auth:qr:confirm',
      windowMs: 10 * 60_000,
      ip: { value: canonicalClientAddress(req.ip), limit: authRateLimitPolicy.confirm.ipMax },
      identity: { value: `user:${payload.userId}`, limit: authRateLimitPolicy.confirm.userMax },
    })) return { error: 'too many requests, please retry later' };

    const ok = qrSessions.confirm(qr_token, payload.userId);
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
    preAuthMaxMessages: runtimeConfig.preAuthMaxMessages,
    preAuthMaxBytes: runtimeConfig.preAuthMaxBytes,
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
    await app.listen({ port: PORT, host: listenHost })
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
      const challengeCount = await cleanExpiredEmailChallenges(pool);
      const rateLimitCount = await cleanStaleAuthRateLimits(pool);
      const totalPurged = tombstoneCount + accessPurged + refreshPurged + challengeCount + rateLimitCount;
      if (totalPurged > 0) console.log(`[cleanup] removed ${tombstoneCount} tombstones, ${accessPurged} access tokens, ${refreshPurged} refresh tokens, ${challengeCount} email challenges, ${rateLimitCount} rate-limit windows`);
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
