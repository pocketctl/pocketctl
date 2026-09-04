import type { WebSocket } from 'ws';
import {
  handleMemoryContextGrantMessage,
  handleMemoryCodegraphGrantMessage,
  handleMemoryMcpGrantMessage,
  handleSessionRegistrationMessage,
  type MemoryCodegraphGrantBroker,
  type MemoryContextGrantBroker,
  type MemoryMcpGrantBroker,
} from './extensions/grant-service.js';
import type pg from 'pg';
import type { RelayPools } from './db-pools.js';
import { randomUUID } from 'crypto';
import { isAppReviewDemoDaemon, isAppReviewDemoSession } from './config/app-review-demo.js';
import * as db from './db.js';
import { sanitizeJSONBPayload } from './jsonb-payload.js';
import { generateTitle, generateSubagentTitle } from './title.js';
import { notifyUser, daemonOfflinePush, daemonOnlinePush } from './push.js';
import { PushDeduper } from './push-deduper.js';
import { quotaEnforcementMode, resolveEntitlements } from './entitlements.js';
import {
  claimBoundDaemonSlot,
  getQuotaSnapshot,
  markQuotaReservationUncertain,
  QuotaReservationBindingError,
  reserveConcurrentSession,
  settleQuotaReservation,
  type QuotaReservationBinding,
  type QuotaSettlementReason,
} from './quota.js';
import { classifyDaemonEvent, normalizeSessionId } from './ingress/event-policy.js';
import type { PriorityClass } from './ingress/types.js';
import type { AckCheckpoint } from './ingress/types.js';
import { BoundedExecutor, ExecutorOverloadedError } from './ingress/bounded-executor.js';
import { AuthLeaseManager } from './ingress/auth-lease.js';
import type { AuthLeaseOptions } from './ingress/auth-lease.js';
import { InboxRepository } from './ingress/inbox-repository.js';
import { IngressController, type IngressTarget } from './ingress/controller.js';
import { EventMaterializer } from './materialization/event-materializer.js';
import { createExtensionJournalSinkFromEnv, type ExtensionJournalSink } from './extensions/journal.js';
import type {
  MaterializationContext,
  MaterializationInput,
  MaterializedDelivery,
} from './materialization/types.js';
import type {
  AttentionInteractionCommand,
  AttentionInteractionRouteResult,
} from './attention-inbox/types.js';
import {
  isCreateCapableAgentType,
  isObserverAgentType,
  isObserverSessionMessageAllowed,
  OBSERVER_READ_ONLY_CODE,
} from './session-observer-policy.js';

interface DaemonConnection { ws: WebSocket; daemonId: string; hostname: string; agents: any[]; userId: number | null; os?: string; ip?: string; port?: string; arch?: string; version?: string; startedAt?: number; registrationId: string; tokenJti?: string }
interface ClientConnection { ws: WebSocket; subscribedSessions: Set<string>; userId: number | null; locale: string }
interface OpenCodeRuntimeTelemetry { fallbackReasons: Record<string, number>; healthOK: number; healthFailed: number }
interface DaemonMetrics { cpuPct: number; memPct: number; diskPct: number; updatedAt: number; openCodeRuntime?: OpenCodeRuntimeTelemetry }

const openCodeFallbackCategories = new Set([
  'unsupported_arguments', 'daemon_unavailable', 'runtime_unavailable',
  'session_busy', 'invalid_request', 'native_response',
]);
const INITIAL_REPLAY_PAYLOAD_WARNING_BYTES = 1_048_576;
const INITIAL_REPLAY_DURATION_WARNING_MS = 1_000;

function nonNegativeCounter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function sanitizeOpenCodeRuntimeTelemetry(value: unknown): OpenCodeRuntimeTelemetry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const fallbackReasons: Record<string, number> = {};
  if (raw.fallback_reasons && typeof raw.fallback_reasons === 'object') {
    for (const [reason, count] of Object.entries(raw.fallback_reasons as Record<string, unknown>)) {
      if (openCodeFallbackCategories.has(reason)) fallbackReasons[reason] = nonNegativeCounter(count);
    }
  }
  return {
    fallbackReasons,
    healthOK: nonNegativeCounter(raw.health_ok),
    healthFailed: nonNegativeCounter(raw.health_failed),
  };
}
interface PendingSessionOperation {
  requestId: string;
  reservationId: string | null;
  daemonId: string;
  userId: number | null;
  sessionId: string | null;
  origin: WebSocket;
  operation: 'create' | 'resume';
  agentType: string;
  cwd: string;
  timeout?: ReturnType<typeof setTimeout>;
}

interface DaemonSeqState {
  startedAt: number;
  persistedHigh: number;
  pending: Set<number>;
  effects: Map<number, () => Promise<void> | void>;
  draining: boolean;
  drainPromise?: Promise<void>;
  inflight: Set<number>;
  baselineSet: boolean;
  accepting: boolean;
}

interface QueuedDaemonMessage {
  daemonId: string;
  msg: any;
  originWs: WebSocket;
  originStartedAt: number | undefined;
  bytes: number;
  receivedAt: Date;
}

interface DaemonRevocationGateState {
  promise: Promise<boolean>;
  queue: QueuedDaemonMessage[];
  queuedBytes: number;
  closed: boolean;
}

export interface RouterOptions {
  /** Session-bound context grant broker (Phase 2); absent disables the leg. */
  memoryContextGrantBroker?: MemoryContextGrantBroker;
  /** Agent MCP grant broker; absent disables the memory_mcp_grant leg. */
  memoryMcpGrantBroker?: MemoryMcpGrantBroker;
  /** Phase 4 source-sync grant broker; absent disables the memory_codegraph_grant leg. */
  memoryCodegraphGrantBroker?: MemoryCodegraphGrantBroker;
  observeIngressClass?: (daemonId: string, priority: PriorityClass) => void;
  authLeaseOptions?: AuthLeaseOptions;
  tokenUsageFactsAuthoritative?: boolean;
  writeTokenUsageFacts?: boolean;
  recoveryObserver?: AttentionRecoveryTransitionObserver;
  /** ADR-0003 Source Journal sink; undefined resolves from RELAY_EXTENSIONS. */
  extensionJournalSink?: ExtensionJournalSink | null;
  transport?: {
    maxEventBytes?: number;
    maxChunkBytes?: number;
    replayBatchMaxEvents?: number;
    replayBatchMaxBytes?: number;
  };
  durableIngress?: {
    mode?: 'off' | 'canary' | 'on';
    canaryDaemonIds?: Iterable<string>;
    eventWindow?: number;
    controller?: IngressController;
    repository?: Pick<InboxRepository, 'persistBatch' | 'seedCheckpoint'>;
  };
}

export interface AttentionRecoveryTransitionObserver {
  confirmedOffline(input: {
    userId: number
    daemonId: string
    registrationGeneration: string
    daemonDisplayName: string
  }): Promise<void>
  confirmedOnline(input: {
    userId: number
    daemonId: string
    registrationGeneration: string
  }): Promise<void>
}

export interface FlagConfig {
  mode: 'off' | 'canary' | 'on';
  daemonIds: Set<string>;
}

export function parseDurableIngressFlag(
  env: Record<string, string | undefined> = process.env,
): FlagConfig {
  const rawMode = env.RELAY_DURABLE_INGRESS ?? 'off';
  if (rawMode !== 'off' && rawMode !== 'canary' && rawMode !== 'on') {
    throw new Error(`invalid RELAY_DURABLE_INGRESS: ${rawMode}`);
  }
  return {
    mode: rawMode,
    daemonIds: new Set(
      (env.RELAY_DURABLE_INGRESS_DAEMONS ?? '')
        .split(',')
        .map((daemonId) => daemonId.trim())
        .filter(Boolean),
    ),
  };
}

export function resolveDurableIngressFlag(config: FlagConfig, daemonId: string): boolean {
  if (config.mode === 'off') return false;
  if (config.mode === 'on') return true;
  if (config.mode === 'canary') return config.daemonIds.has(daemonId);
  throw new Error(`invalid RELAY_DURABLE_INGRESS: ${String(config.mode)}`);
}

function isRelayPools(value: RelayPools | pg.Pool): value is RelayPools {
  return 'control' in value && 'ingest' in value && 'query' in value && 'worker' in value;
}

export class Router {
  private daemons = new Map<string, DaemonConnection>();
  private daemonMetrics = new Map<string, DaemonMetrics>();
  private memoryMcpGrantBroker?: MemoryMcpGrantBroker;
  private memoryContextGrantBroker?: MemoryContextGrantBroker;
  private memoryCodegraphGrantBroker?: MemoryCodegraphGrantBroker;
  private clients = new Map<WebSocket, ClientConnection>();
  private sessionToDaemon = new Map<string, string>();
  private pendingSessionCreate = new Map<string, WebSocket>();
  private pendingSessionMeta = new Map<string, { agent_type: string; cwd: string }>();
  private pendingSessionOperations = new Map<string, PendingSessionOperation>();
  private pendingInteractionClients = new Map<string, WebSocket[]>();
  private pendingOriginClient = new Map<string, WebSocket>(); // pending session_id → origin client (for session_id_changed 补发)
  private takeoverTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; newDaemonId: string; newHostname: string }>();
  // Pending offline-transition timers, keyed by daemonId. On WS close we defer
  // the offline side-effects (DB offline, push, broadcast) behind a grace window
  // so a relay restart or brief network blip doesn't flap the daemon offline.
  // A re-register for the same daemonId cancels the timer.
  private pendingOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Set during graceful shutdown to suppress offline pushes (the daemons are
  // about to reconnect to the new process — not genuinely offline).
  private shuttingDown = false;
  // Per-daemon event delivery cursor for at-least-once delivery. `persistedHigh`
  // is the highest *contiguous* seq that has been durably persisted; it is what
  // event_ack reports, so the daemon only trims its outbound buffer/spool once an
  // event is safely in the DB (ack-after-persist). `pending` holds out-of-order
  // persisted seqs above the mark; `effects` holds matching post-insert work.
  // Both drain contiguously so promise completion cannot reorder live delivery.
  // `startedAt` detects a daemon process restart (seq resets): when it changes we
  // reset the cursor. The DB row dedup is handled separately by the
  // events.event_hash unique index.
  private daemonSeq = new Map<string, DaemonSeqState>();
  private daemonRegistrationChains = new Map<string, Promise<void>>();
  private daemonRevocationGates = new Map<string, DaemonRevocationGateState>();
  private authLeases: AuthLeaseManager;
  private readonly observeIngressClass?: (daemonId: string, priority: PriorityClass) => void;
  private pool: pg.Pool;
  private controlPool: pg.Pool;
  private ingestPool: pg.Pool;
  private queryPool: pg.Pool;
  private workerPool: pg.Pool;
  private readonly durableIngress: IngressController;
  private readonly durableInbox: Pick<InboxRepository, 'persistBatch' | 'seedCheckpoint'>;
  private readonly durableIngressMode: 'off' | 'canary' | 'on';
  private readonly durableIngressCanaries: Set<string>;
  private readonly durableIngressEventWindow: number;
  private readonly maxEventBytes: number;
  private readonly maxChunkBytes: number;
  private readonly replayBatchMaxEvents: number;
  private readonly replayBatchMaxBytes: number;
  private legacyPersist = new BoundedExecutor({
    maxConcurrent: positiveInteger(process.env.RELAY_LEGACY_PERSIST_CONCURRENCY, 8),
    maxPending: nonNegativeInteger(process.env.RELAY_LEGACY_PERSIST_QUEUE_MAX, 1_024),
  });

  private interactionClientKey(sessionId: string, requestId: string, operation: string): string {
    return `${sessionId}\u0000${requestId}\u0000${operation}`;
  }

  private trackInteractionClient(sessionId: string, requestId: string, operation: string, ws: WebSocket): void {
    if (!requestId) return;
    const key = this.interactionClientKey(sessionId, requestId, operation);
    const pending = this.pendingInteractionClients.get(key) ?? [];
    pending.push(ws);
    this.pendingInteractionClients.set(key, pending);
  }

  private takeInteractionClient(sessionId: string, requestId: string, operation: string): WebSocket | undefined {
    const key = this.interactionClientKey(sessionId, requestId, operation);
    const pending = this.pendingInteractionClients.get(key);
    const origin = pending?.shift();
    if (!pending || pending.length === 0) this.pendingInteractionClients.delete(key);
    return origin;
  }

  // Grace window before a disconnected daemon is declared offline.
  private readonly offlineGraceMs = parseInt(process.env.DAEMON_OFFLINE_GRACE_MS || '30000', 10);
  private readonly offlineWriteTimeoutMs = parseInt(process.env.DAEMON_OFFLINE_WRITE_TIMEOUT_MS || '1000', 10);
  private readonly revocationCheckTimeoutMs = parseInt(process.env.DAEMON_REVOCATION_CHECK_TIMEOUT_MS || '1000', 10);
  private readonly revocationGateMaxMessages = Math.max(
    1, parseInt(process.env.DAEMON_REVOCATION_GATE_MAX_MESSAGES || '64', 10) || 64,
  );
  private readonly revocationGateMaxBytes = Math.max(
    1, parseInt(process.env.DAEMON_REVOCATION_GATE_MAX_BYTES || '1048576', 10) || 1_048_576,
  );

  // Process startup time. During the startup grace window below, daemons that
  // exist in the DB but haven't re-registered into memory yet (because this
  // process just restarted) are shown optimistically online so clients don't
  // see their host list flicker/empty during a relay restart.
  private readonly startedAt = Date.now()
  private readonly listGraceMs = parseInt(process.env.RELAY_LIST_GRACE_MS || '60000', 10)

  // Push dedup: same requestId pushed only once per TTL window. Guards the
  // ack-async / no-seq / persist-retry gaps that seq dedup can't cover for the
  // user-facing push side-effect.
  private pushDeduper = new PushDeduper();
  private readonly tokenUsageFactsAuthoritative: boolean;
  private readonly writeTokenUsageFacts: boolean;
  private readonly recoveryObserver?: AttentionRecoveryTransitionObserver;

  // Daemon ids that finalized a genuine offline (grace window elapsed). Used
  // to push "online" only on a real offline→online transition, not on every
  // WS reconnect (network flap / relay restart). In-memory, so a relay restart
  // naturally suppresses the first online push — desirable.
  private knownOffline = new Set<string>();
  private materializer: EventMaterializer;
  private readonly extensionJournalSink: ExtensionJournalSink | null;

  constructor(pools: RelayPools | pg.Pool, options: RouterOptions = {}) {
    this.tokenUsageFactsAuthoritative = options.tokenUsageFactsAuthoritative === true;
    this.writeTokenUsageFacts = options.writeTokenUsageFacts === true;
    this.recoveryObserver = options.recoveryObserver;
    const normalized = isRelayPools(pools) ? pools : {
      control: pools, ingest: pools, query: pools, worker: pools,
    };
    this.controlPool = normalized.control;
    this.memoryMcpGrantBroker = options.memoryMcpGrantBroker;
    this.memoryContextGrantBroker = options.memoryContextGrantBroker;
    this.memoryCodegraphGrantBroker = options.memoryCodegraphGrantBroker;
    this.ingestPool = normalized.ingest;
    this.queryPool = normalized.query;
    this.workerPool = normalized.worker;
    this.pool = normalized.query;
    this.maxEventBytes = this.positiveTransportOption(
      options.transport?.maxEventBytes, 1_048_576,
    );
    this.maxChunkBytes = this.positiveTransportOption(
      options.transport?.maxChunkBytes, 131_072,
    );
    this.replayBatchMaxEvents = this.positiveTransportOption(
      options.transport?.replayBatchMaxEvents, 50,
    );
    this.replayBatchMaxBytes = this.positiveTransportOption(
      options.transport?.replayBatchMaxBytes, 524_288,
    );
    this.extensionJournalSink = options.extensionJournalSink !== undefined
      ? options.extensionJournalSink
      : createExtensionJournalSinkFromEnv();
    this.materializer = new EventMaterializer({
      pool: this.ingestPool,
      effectPool: this.pool,
      writeTokenUsageFacts: this.writeTokenUsageFacts,
      extensionJournalSink: this.extensionJournalSink,
      hooks: {
        bindSession: (sessionId, daemonId) => this.sessionToDaemon.set(sessionId, daemonId),
        renameSession: (oldSessionId, sessionId, daemonId) => {
          this.sessionToDaemon.set(sessionId, daemonId);
          this.sessionToDaemon.delete(oldSessionId);
          for (const [, client] of this.clients) {
            if (client.subscribedSessions.delete(oldSessionId)) client.subscribedSessions.add(sessionId);
          }
          const origin = this.pendingOriginClient.get(oldSessionId);
          if (origin) {
            this.pendingOriginClient.set(sessionId, origin);
            this.pendingOriginClient.delete(oldSessionId);
          }
        },
        prepareSessionCreated: (sessionId, daemonId, requestId) => {
          const pending = this.findPendingSessionOperation(daemonId, requestId ?? undefined);
          const origin = pending?.origin ?? this.pendingSessionCreate.get(daemonId);
          if (!origin) return;
          this.clients.get(origin)?.subscribedSessions.add(sessionId);
          this.pendingOriginClient.set(sessionId, origin);
        },
        releasePendingOperation: async (identity) => {
          const pending = this.findPendingSessionOperation(
            identity.daemonId, identity.requestId, identity.userId,
          );
          if (!pending || pending.operation !== identity.operation
            || pending.reservationId !== identity.reservationId
            || (pending.operation === 'resume' && pending.sessionId !== identity.sessionId)) return;
          if (pending.timeout) clearTimeout(pending.timeout);
          await this.broadcastQuotaStatus(identity.userId);
          this.pendingSessionOperations.delete(this.pendingOperationKey(
            pending.userId, pending.daemonId, pending.requestId,
          ));
        },
        clearPendingSession: (daemonId) => {
          this.pendingSessionMeta.delete(daemonId);
          this.pendingSessionCreate.delete(daemonId);
        },
        broadcastQuota: (userId) => this.broadcastQuotaStatus(userId),
        shouldPush: (requestId) => this.pushDeduper.shouldPush(requestId),
        forgetPush: (requestId) => this.pushDeduper.forget(requestId),
        clearInteractionOrigin: (sessionId, requestId, operation) => {
          this.takeInteractionClient(sessionId, requestId, operation);
        },
      },
    });
    this.observeIngressClass = options.observeIngressClass;
    this.authLeases = new AuthLeaseManager(options.authLeaseOptions);
    const flag = options.durableIngress?.mode === undefined
      ? parseDurableIngressFlag()
      : {
        mode: options.durableIngress.mode,
        daemonIds: new Set(options.durableIngress.canaryDaemonIds ?? []),
      };
    this.durableIngressMode = flag.mode;
    this.durableIngressCanaries = flag.daemonIds;
    this.durableIngressEventWindow = options.durableIngress?.eventWindow ?? 128;
    this.durableInbox = options.durableIngress?.repository ?? new InboxRepository(this.ingestPool);
    this.durableIngress = options.durableIngress?.controller ?? new IngressController({
      repository: this.durableInbox,
      sendAck: (daemonId, checkpoint, window) => this.sendDurableAck(daemonId, checkpoint, window),
      sendFlowControl: (target, state) => this.sendDurableFlowControl(target, state),
      disconnectRetryable: (target, reason, retryAfterMs) => this.disconnectDurableIngress(target, reason, retryAfterMs),
    });
    this.pushDeduper.startSweeping();
  }

  private positiveTransportOption(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
  }

  private ownerLocale(sessionId: string): string | undefined {
    for (const [, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId) && client.userId) return client.locale;
    }
    return undefined;
  }

  private async generateSessionTitleDelivery(
    input: MaterializationInput,
  ): Promise<Record<string, unknown> | null> {
    const sessionId = input.sessionId ?? '';
    const userMessage = typeof input.payload.user_message === 'string' ? input.payload.user_message : '';
    const assistantMessage = typeof input.payload.assistant_message === 'string' ? input.payload.assistant_message : '';
    if (!userMessage || !assistantMessage || !await db.hasDefaultTitle(this.pool, sessionId)) return null;
    const title = await generateTitle(userMessage, assistantMessage, this.ownerLocale(sessionId));
    if (!title || !await db.updateTitleIfDefault(this.pool, sessionId, title)) return null;
    return { type: 'session_title_update', session_id: sessionId, title };
  }

  private async generateSubagentTitleDelivery(
    input: MaterializationInput,
  ): Promise<Record<string, unknown> | null> {
    const sessionId = input.sessionId ?? '';
    const agentId = typeof input.payload.agent_id === 'string' ? input.payload.agent_id : '';
    const userMessage = typeof input.payload.user_message === 'string' ? input.payload.user_message : '';
    const agentType = typeof input.payload.subagent_type === 'string' ? input.payload.subagent_type : '';
    if (!agentId || !userMessage || !await db.hasDefaultSubagentTitle(this.pool, sessionId, agentId)) return null;
    const title = await generateSubagentTitle(userMessage, agentType, this.ownerLocale(sessionId));
    if (!title || !await db.updateSubagentTitleIfDefault(this.pool, sessionId, agentId, title)) return null;
    return {
      type: 'subagent_title_update',
      session_id: sessionId,
      agent_id: agentId,
      parent_session_id: sessionId,
      title,
    };
  }

  private logBestEffortFailure(scope: string, error: unknown): void {
    const errorName = error instanceof Error ? error.name : typeof error;
    console.error(`[router] ${scope} failed`, { errorName });
  }

  /**
   * Title-related ephemeral events never reach the durable materializer, so
   * they authorize here: a missing or foreign session has no title read, no
   * generation call, no delivery, and no title-row mutation.
   */
  private async authorizeEphemeralTitleSession(daemonId: string, sessionId: string): Promise<boolean> {
    const daemon = this.daemons.get(daemonId);
    try {
      await db.assertDaemonSessionAccess(this.pool, {
        sessionId,
        daemonId,
        userId: daemon?.userId ?? null,
        policy: 'must_exist',
      });
      return true;
    } catch (error) {
      if (error instanceof db.SessionOwnershipViolationError
        || error instanceof db.UnknownDaemonSessionError) {
        console.error('[router] ephemeral title event rejected', {
          daemonId,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return false;
      }
      throw error;
    }
  }

  private runEphemeralTitleEffect(
    daemonId: string,
    msg: Record<string, unknown>,
    audience: 'user' | 'session',
    effect: (input: MaterializationInput) => Promise<Record<string, unknown> | null>,
  ): void {
    const sessionId = normalizeSessionId(msg.session_id);
    const input: MaterializationInput = {
      inboxId: 0,
      userId: this.daemons.get(daemonId)?.userId ?? null,
      daemonId,
      sessionId,
      eventType: String(msg.type ?? ''),
      payload: msg,
    };
    void effect(input)
      .then((payload) => {
        if (!payload) return;
        this.deliverMaterializedEvent({
          eventId: null,
          userId: input.userId,
          audience,
          sessionId,
          requestId: typeof msg.request_id === 'string' ? msg.request_id : null,
          ordinal: 0,
          deliveryKey: `ephemeral:${daemonId}:${String(msg.seq ?? '')}:${input.eventType}`,
          type: String(payload.type ?? input.eventType),
          payload,
        });
      })
      .catch((error) => this.logBestEffortFailure(input.eventType, error));
  }

  private applyRuntimeMutation(delivery: MaterializedDelivery): void {
    const sessionId = delivery.sessionId ?? '';
    const daemonId = delivery.daemonId ?? '';
    if (sessionId && daemonId && [
      'session_created',
      'session_discovered',
      'session_model_changed',
      'session_status',
      'subagent_discovered',
    ].includes(delivery.type)) {
      this.sessionToDaemon.set(sessionId, daemonId);
    }
    if (delivery.type === 'session_id_changed' && sessionId && daemonId) {
      const oldSessionId = typeof delivery.payload.old_session_id === 'string'
        ? delivery.payload.old_session_id
        : '';
      this.sessionToDaemon.set(sessionId, daemonId);
      if (oldSessionId) {
        this.sessionToDaemon.delete(oldSessionId);
        for (const [, client] of this.clients) {
          if (client.subscribedSessions.delete(oldSessionId)) client.subscribedSessions.add(sessionId);
        }
        const origin = this.pendingOriginClient.get(oldSessionId);
        if (origin) {
          this.pendingOriginClient.set(sessionId, origin);
          this.pendingOriginClient.delete(oldSessionId);
        }
      }
    }
    if (delivery.type === 'session_created' && sessionId) {
      const pending = this.findPendingSessionOperation(daemonId, delivery.requestId ?? undefined, delivery.userId);
      const origin = pending?.origin ?? this.pendingSessionCreate.get(daemonId);
      if (origin) {
        this.clients.get(origin)?.subscribedSessions.add(sessionId);
        this.pendingOriginClient.set(sessionId, origin);
      }
      if (pending?.timeout) clearTimeout(pending.timeout);
      if (pending) this.pendingSessionOperations.delete(this.pendingOperationKey(
        pending.userId, pending.daemonId, pending.requestId,
      ));
      this.pendingSessionMeta.delete(daemonId);
      this.pendingSessionCreate.delete(daemonId);
    }
    if (delivery.type === 'session_create_failed') {
      const pending = this.findPendingSessionOperation(
        daemonId, delivery.requestId ?? undefined, delivery.userId,
      );
      if (pending?.operation === 'create') {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pendingSessionOperations.delete(this.pendingOperationKey(
          pending.userId, pending.daemonId, pending.requestId,
        ));
        this.pendingSessionCreate.delete(daemonId);
        this.pendingSessionMeta.delete(daemonId);
      }
    }
    if (delivery.payload.reason !== 'resolved_elsewhere') {
      if (delivery.type === 'approval_resolved') {
        this.takeInteractionClient(sessionId, delivery.requestId ?? '', 'approval_response');
      } else if (delivery.type === 'question_resolved') {
        this.takeInteractionClient(
          sessionId,
          delivery.requestId ?? '',
          delivery.payload.rejected ? 'question_reject' : 'question_response',
        );
      }
    }
  }

  async deliverDurableMaterializedEvent(delivery: MaterializedDelivery): Promise<boolean> {
    if (delivery.inboxId && delivery.userId !== null
      && ['session_created', 'session_create_failed', 'session_discovered', 'session_status'].includes(delivery.type)) {
      // Standalone workers have no websocket maps. Recreate the Task 8
      // user-visible quota refresh at the Relay delivery boundary. This await
      // is part of the outbox disposition: a transient quota failure rolls the
      // claim back and retries without rerunning the completed business effect.
      await this.broadcastQuotaStatus(delivery.userId);
    }
    return this.deliverMaterializedEvent(delivery)
  }

  deliverMaterializedEvent(delivery: MaterializedDelivery): boolean {
    this.applyRuntimeMutation(delivery);
    if (delivery.audience === 'interaction-origin') {
      const operation = String(delivery.payload.operation ?? '');
      const origin = this.takeInteractionClient(
        delivery.sessionId ?? '', delivery.requestId ?? '', operation,
      );
      if (origin?.readyState === 1) {
        this.send(origin, delivery.payload);
        return true;
      }
      // The origin map is intentionally process-local. After a Relay restart,
      // recover to exactly one connected client belonging to the durable owner;
      // never acknowledge the outbox row merely because the original socket is
      // absent, and never cross the existing sameUser isolation boundary.
      for (const [clientWs, client] of this.clients) {
        if (clientWs.readyState !== 1 || !this.sameUser(client.userId, delivery.userId)) continue;
        this.send(clientWs, delivery.payload);
        return true;
      }
      return false;
    }
    for (const [clientWs, client] of this.clients) {
      if (clientWs.readyState !== 1) continue;
      const selected = delivery.audience === 'user'
        ? this.sameUser(client.userId, delivery.userId)
        : client.subscribedSessions.has(delivery.sessionId ?? '');
      if (!selected) continue;
      if (delivery.type === 'session_created' && delivery.sessionId) {
        client.subscribedSessions.add(delivery.sessionId);
      }
      this.send(clientWs, delivery.payload);
    }
    // Session/user broadcasts are snapshots: an empty current audience is an
    // explicit terminal condition and reconnect replay remains DB-driven.
    return true;
  }

  private pendingOperationKey(userId: number | null, daemonId: string, requestId: string): string {
    return JSON.stringify([userId, daemonId, requestId]);
  }

  private findPendingSessionOperation(
    daemonId: string,
    requestId?: string,
    userId?: number | null,
  ): PendingSessionOperation | undefined {
    if (!requestId) return undefined;
    const expectedUserId = userId !== undefined ? userId : this.daemons.get(daemonId)?.userId;
    if (expectedUserId === undefined) return undefined;
    const exact = this.pendingSessionOperations.get(this.pendingOperationKey(expectedUserId, daemonId, requestId));
    if (exact?.daemonId !== daemonId) return undefined;
    if (userId !== undefined && exact.userId !== userId) return undefined;
    return exact;
  }

  private materializationContext(
    daemonId: string,
    payload: Record<string, unknown>,
  ): MaterializationContext {
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : undefined;
    const userId = this.daemons.get(daemonId)?.userId ?? null;
    const pending = this.findPendingSessionOperation(daemonId, requestId, userId);
    const meta = this.pendingSessionMeta.get(daemonId);
    return {
      agentType: pending?.agentType ?? meta?.agent_type ?? '',
      cwd: pending?.cwd ?? meta?.cwd ?? '',
      requestId: pending?.requestId ?? requestId,
      reservationId: pending?.reservationId ?? null,
      quotaOperation: pending?.operation,
      hostname: this.daemons.get(daemonId)?.hostname ?? 'unknown',
    };
  }

  /**
   * M-4: closing a pending operation needs an explicit accounting outcome.
   * 'settled' frees the reservation for a confirmed reason (daemon-acknowledged
   * failure or a materialized success). 'uncertain' keeps the reservation
   * counted — a timed-out or vanished daemon gets no free slot it may still
   * be using; only audited reconciliation can settle it later.
   */
  private async settlePendingSessionOperation(
    pending: PendingSessionOperation | undefined,
    outcome: { kind: 'settled'; reason: QuotaSettlementReason } | { kind: 'uncertain'; reason: string },
  ): Promise<void> {
    if (!pending) return;
    if (pending.reservationId) {
      if (pending.userId === null) return;
      const binding: QuotaReservationBinding = {
        reservationId: pending.reservationId,
        userId: pending.userId,
        daemonId: pending.daemonId,
        requestId: pending.requestId,
        operation: pending.operation,
        sessionId: pending.sessionId,
      };
      let matched: boolean;
      if (outcome.kind === 'settled') {
        matched = (await settleQuotaReservation(this.pool, binding, outcome.reason)).matched;
      } else {
        matched = (await markQuotaReservationUncertain(this.pool, binding, outcome.reason)).matched;
      }
      if (!matched) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      await this.broadcastQuotaStatus(pending.userId);
    } else if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingSessionOperations.delete(this.pendingOperationKey(
      pending.userId, pending.daemonId, pending.requestId,
    ));
  }

  private trackPendingSessionOperation(pending: PendingSessionOperation, expiresAt: number | null): void {
    if (expiresAt) {
      const timeout = setTimeout(() => {
        const current = this.pendingSessionOperations.get(this.pendingOperationKey(
          pending.userId, pending.daemonId, pending.requestId,
        ));
        if (current !== pending) return;
        if (pending.origin.readyState === 1) {
          if (pending.operation === 'create') {
            this.send(pending.origin, { type: 'session_create_failed', request_id: pending.requestId, reason: 'timeout', error: 'session start quota reservation expired' });
          } else {
            this.send(pending.origin, { type: 'user_message_nack', request_id: pending.requestId, reason: 'timeout' });
          }
        }
        void this.settlePendingSessionOperation(pending, { kind: 'uncertain', reason: 'grant_timeout' })
          .catch((e) => console.error('mark quota reservation uncertain:', e));
      }, Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now())));
      timeout.unref?.();
      pending.timeout = timeout;
    }
    this.pendingSessionOperations.set(this.pendingOperationKey(
      pending.userId, pending.daemonId, pending.requestId,
    ), pending);
  }

  async broadcastQuotaStatus(userId: number): Promise<void> {
    const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
    const quota = await getQuotaSnapshot(this.pool, userId, resolveEntitlements(plan, whitelist));
    this.broadcastToUser(userId, { type: 'quota_status', plan, ...quota });
  }

  /** Mark the relay as shutting down so offline pushes are suppressed. */
  beginShutdown(): void { this.shuttingDown = true; }

  async stopDurableIngress(options: { flushDeadlineMs: number }): Promise<void> {
    await this.durableIngress.stop(options);
  }

  private durableIngressEnabledFor(daemonId: string): boolean {
    return resolveDurableIngressFlag({
      mode: this.durableIngressMode,
      daemonIds: this.durableIngressCanaries,
    }, daemonId);
  }

  private sendDurableAck(daemonId: string, checkpoint: AckCheckpoint, window: number): void {
    const daemon = this.daemons.get(daemonId);
    if (!daemon || daemon.ws.readyState !== 1 || daemon.startedAt !== checkpoint.daemonGeneration) return;
    this.send(daemon.ws, {
      type: 'event_ack', up_to_seq: checkpoint.ackSeq,
      event_window: Math.min(window, this.durableIngressEventWindow),
      daemon_generation: checkpoint.daemonGeneration,
    });
  }

  private sendDurableFlowControl(target: IngressTarget, state: import('./ingress/types.js').FlowControlState): void {
    const daemon = this.activeDurableTarget(target);
    if (!daemon || daemon.ws.readyState !== 1) return;
    this.send(daemon.ws, {
      type: 'flow_control', window: state.window,
      retry_after_ms: state.retryAfterMs, reason: state.reason,
      ...(state.blockedSeq === undefined ? {} : { blocked_seq: state.blockedSeq }),
      daemon_generation: target.daemonGeneration,
    });
  }

  private disconnectDurableIngress(target: IngressTarget, reason: string, retryAfterMs: number): void {
    const daemon = this.activeDurableTarget(target);
    if (!daemon || daemon.ws.readyState !== 1) return;
    this.send(daemon.ws, {
      type: 'disconnect', reason, retryable: true, retry_after_ms: retryAfterMs,
      daemon_generation: target.daemonGeneration,
    });
    daemon.ws.close(1013, reason);
  }

  private activeDurableTarget(target: IngressTarget): DaemonConnection | undefined {
    const daemon = this.daemons.get(target.daemonId);
    if (!daemon
      || daemon.registrationId !== target.registrationId
      || daemon.startedAt !== target.daemonGeneration) return undefined;
    return daemon;
  }

  /** Release background resources (push dedup sweeper). Call on shutdown. */
  stop(): void { this.pushDeduper.stop(); }

  /**
   * Push only to Pro/whitelisted users. Reads plan and skips free users.
   * Used for Pro-gated pushes (daemon online, high-risk warning, reports).
   * Regular approval/session-status pushes bypass this (free users get those).
   */
  private async maybePushToPro(userId: number, payload: import('./push.js').PushPayload): Promise<void> {
    const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
    if (!whitelist && plan === 'free') return;
    await notifyUser(this.pool, userId, payload);
  }

  /** Notify all connected daemons AND clients that the relay is restarting
   *  (expected disconnect). Daemons use it as a fast-reconnect trigger; clients
   *  currently ignore the unknown message type (silently dropped) — this is
   *  forward-compatible plumbing for a future client-side fast path. */
  broadcastRelayRestarting(): void {
    for (const [, daemon] of this.daemons) {
      if (daemon.ws.readyState === 1) this.send(daemon.ws, { type: 'relay_restarting' });
    }
    for (const [clientWs] of this.clients) {
      if (clientWs.readyState === 1) this.send(clientWs, { type: 'relay_restarting' });
    }
  }

  /**
   * Force-terminate every daemon and client WebSocket immediately — no close
   * frame, no 30s closeTimeout wait. Used during graceful shutdown so the old
   * process exits in <1s instead of blocking on ws.close() drain when a peer
   * doesn't promptly ack the close (half-open socket, nginx not relaying the
   * close frame, etc.). ws.terminate() destroys the underlying socket at once.
   */
  terminateAllConnections(): void {
    for (const [, daemon] of this.daemons) {
      const ws = daemon.ws as any
      if (typeof ws.terminate === 'function') ws.terminate()
    }
    for (const [clientWs] of this.clients) {
      const ws = clientWs as any
      if (typeof ws.terminate === 'function') ws.terminate()
    }
  }

  /** Close and unregister every live socket belonging to one deleted user. */
  terminateUserConnections(userId: number, code = 4001, reason = 'account deleted'): void {
    for (const [clientWs, client] of [...this.clients]) {
      if (!this.sameUser(client.userId, userId)) continue;
      this.clients.delete(clientWs);
      if (clientWs.readyState === 1) clientWs.close(code, reason);
    }
    for (const [daemonId, daemon] of [...this.daemons]) {
      if (!this.sameUser(daemon.userId, userId)) continue;
      this.daemons.delete(daemonId);
      this.daemonMetrics.delete(daemonId);
      this.knownOffline.delete(daemonId);
      const offlineTimer = this.pendingOfflineTimers.get(daemonId);
      if (offlineTimer) clearTimeout(offlineTimer);
      this.pendingOfflineTimers.delete(daemonId);
      if (daemon.ws.readyState === 1) daemon.ws.close(code, reason);
    }
  }

  registerDaemon(ws: WebSocket, msg: any, userId: number | null, tokenJti?: string, machineId?: string): Promise<boolean> {
    const daemonId = msg.daemon_id;
    return this.withDaemonRegistrationLock(daemonId, () =>
      this.registerDaemonLocked(ws, msg, userId, tokenJti, machineId));
  }

  private withDaemonRegistrationLock<T>(daemonId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.daemonRegistrationChains.get(daemonId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.daemonRegistrationChains.set(daemonId, tail);
    void tail.finally(() => {
      if (this.daemonRegistrationChains.get(daemonId) === tail) this.daemonRegistrationChains.delete(daemonId);
    });
    return result;
  }

  private async registerDaemonLocked(ws: WebSocket, msg: any, userId: number | null, tokenJti?: string, machineId?: string): Promise<boolean> {
    const daemonId = msg.daemon_id;
    const hostname = msg.hostname || 'unknown';
    const previousDaemon = this.daemons.get(daemonId);

    // H-3: daemons must register with a real authenticated user. The legacy
    // null-user (global API key) identity is gone; no owner recovery from
    // persisted daemon rows, no activation, no socket replacement.
    if (!userId) {
      this.send(ws, { type: 'register_rejected', reason: 'auth_required', retryable: false, message: 'daemon registration requires user authentication' });
      ws.close(4001, 'authentication required');
      return false;
    }

    // Authentication may have completed before this socket waited behind a
    // force-kick in the per-daemon chain. Recheck the same JTI inside the lock,
    // before quota admission or any activation mutation.
    if (tokenJti) {
      try {
        if (await db.isTokenRevoked(this.controlPool, tokenJti)) {
          this.send(ws, { type: 'register_rejected', reason: 'token_revoked', retryable: false });
          ws.close(4001, 'token revoked');
          return false;
        }
      } catch (e) {
        console.error('registration token recheck:', e);
        this.send(ws, { type: 'disconnect', reason: 'token_check_unavailable', retryable: true });
        ws.close(1011, 'token check unavailable');
        return false;
      }
    }

    // Cancel any pending offline transition — the daemon reconnected within the
    // grace window, so it must not be flapped offline (no push, no broadcast).
    const pendingOffline = this.pendingOfflineTimers.get(daemonId);
    if (pendingOffline) { clearTimeout(pendingOffline); this.pendingOfflineTimers.delete(daemonId); }
    // Compose agents as [{type, version, latest, manageable}] objects.
    const agentTypes: string[] = msg.agents || [];
    const agentVersions: Record<string, string> = msg.agent_versions || {};
    const agentLatests: Record<string, string> = msg.agent_latests || {};
    const agentManageable: Record<string, boolean> = msg.agent_manageable || {};
    const agents = agentTypes.map((t: string) => ({
      type: t,
      version: agentVersions[t] || '',
      latest: agentLatests[t] || '',
      manageable: agentManageable[t] !== false, // 缺省 true，兼容旧 daemon
    }));

    const daemonOS = msg.os || 'unknown';
    const daemonIP = msg.ip || 'unknown';
    const daemonPort = msg.port || '';
    const daemonArch = msg.arch || '';
    const daemonVersion = msg.version || '';
    const daemonStartedAt = msg.started_at || 0;
    const registrationId = randomUUID();

    // Count every persisted binding, including offline hosts. Claiming the row
    // and checking the limit share a user-scoped transaction, closing the race
    // where two machines try to take the final slot simultaneously.
    if (userId) {
      try {
        const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.controlPool, userId);
        const entitlements = resolveEntitlements(plan, whitelist);
        const enforcement = quotaEnforcementMode();
        if (enforcement === 'enforce' && msg.supports_quota_grant !== true) {
          this.send(ws, {
            type: 'register_rejected', reason: 'upgrade_required', retryable: false,
            message: '当前 daemon 版本不支持会话额度协议，请升级 pocketctl 后重试',
          });
          ws.close(4009, 'upgrade_required');
          return false;
        }
        const decision = await claimBoundDaemonSlot(this.controlPool, {
          userId, daemonId, machineId, hostname, agents,
          arch: daemonArch, version: daemonVersion, startedAt: daemonStartedAt,
          limit: enforcement === 'enforce' ? entitlements.maxBoundDaemons : null,
        });
        if (!decision.allowed) {
          this.send(ws, {
            type: 'register_rejected',
            reason: decision.reason,
            resource: 'bound_hosts',
            plan,
            used: decision.used,
            limit: decision.limit,
            retryable: false,
            message: decision.reason === 'host_quota_exceeded'
              ? `免费版最多连接 ${decision.limit} 台主机`
              : decision.reason === 'machine_already_online'
                ? '该设备已有在线 daemon，请先停止另一实例后重试'
                : '该主机已绑定其他账号',
          });
          ws.close(4008, decision.reason);
          return false;
        }
        if (enforcement === 'observe' && entitlements.maxBoundDaemons !== null && !decision.reconnect && decision.used > entitlements.maxBoundDaemons) {
          db.insertAuditLog(this.controlPool, userId, 'quota_would_reject', {
            resource: 'bound_hosts', operation: 'register', used: decision.used - 1,
            limit: entitlements.maxBoundDaemons, daemon_id: daemonId,
          }).catch(console.error);
        }
      } catch (e) {
        console.error('daemon quota check:', e);
        this.send(ws, { type: 'register_rejected', reason: 'quota_check_failed', retryable: true, message: '主机额度检查失败' });
        ws.close(4011, 'quota check failed');
        return false;
      }
    }

    // The server installs a provisional socket identity before awaiting us. A
    // close during quota admission must not activate a dead socket.
    if (ws.readyState !== 1) return false;

    let activationSnapshot: db.DaemonRegistrationSnapshot | null;
    try {
      activationSnapshot = await db.activateDaemonRegistration(this.controlPool, {
        daemonId, userId, hostname, agents, arch: daemonArch, version: daemonVersion,
        startedAt: daemonStartedAt, tokenJti, machineId, registrationId,
      });
    } catch (e) {
      console.error('activateDaemonRegistration:', e);
      if (e instanceof db.TokenRevokedDuringActivationError) {
        this.send(ws, { type: 'register_rejected', reason: 'token_revoked', retryable: false });
        ws.close(4001, 'token revoked');
        return false;
      }
      if (e instanceof db.MachineAlreadyOnlineError) {
        this.send(ws, {
          type: 'register_rejected', reason: 'machine_already_online', retryable: false,
          message: '该设备已有在线 daemon，请先停止另一实例后重试',
        });
        ws.close(4008, 'machine already online');
        return false;
      }
      this.send(ws, { type: 'register_rejected', reason: 'activation_failed', retryable: true });
      ws.close(4011, 'activation failed');
      return false;
    }
    const restoreActivation = async (): Promise<db.DaemonRegistrationRestoreResult> => {
      let result: db.DaemonRegistrationRestoreResult = { status: 'sql_failure', error: new Error('not attempted') };
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await db.restoreDaemonRegistration(this.controlPool, daemonId, registrationId, activationSnapshot);
        if (result.status !== 'sql_failure') return result;
        console.error('restoreDaemonRegistration:', result.error);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
      return result;
    };
    const failClosedLocalGenerations = (reason: string) => {
      const current = this.daemons.get(daemonId);
      if (previousDaemon && current?.ws === previousDaemon.ws && current.registrationId === previousDaemon.registrationId) {
        this.cancelDaemonRevocationGate(previousDaemon.registrationId);
        this.daemons.delete(daemonId);
        this.daemonMetrics.delete(daemonId);
        const oldCursor = this.daemonSeq.get(daemonId);
        if (oldCursor) oldCursor.accepting = false;
        this.daemonSeq.delete(daemonId);
      }
      if (previousDaemon?.ws.readyState === 1) previousDaemon.ws.close(4013, reason);
      if (ws.readyState === 1) ws.close(4013, reason);
    };
    const compensateActivation = async (): Promise<boolean> => {
      const result = await restoreActivation();
      if (result.status === 'confirmed_restored') return true;
      // CAS miss proves another generation won in the DB; SQL failure leaves
      // DB state unknown. In both cases this relay must stop its old/contender
      // generations without touching an identity-guarded local successor.
      failClosedLocalGenerations(result.status === 'stale_successor'
        ? 'registration superseded'
        : 'activation compensation failed');
      return false;
    };
    if (ws.readyState !== 1) {
      await compensateActivation();
      return false;
    }
    const durableIngressEnabled = this.durableIngressEnabledFor(daemonId);
    if (durableIngressEnabled) {
      try {
        await this.durableInbox.seedCheckpoint(
          daemonId,
          Math.max(0, Number(daemonStartedAt) || 0),
          Math.max(0, Number(msg.acked_seq) || 0),
        );
      } catch (e) {
        console.error('seed durable ingress checkpoint:', e);
        await compensateActivation();
        this.send(ws, { type: 'register_rejected', reason: 'durable_ingress_unavailable', retryable: true });
        ws.close(1011, 'durable ingress unavailable');
        return false;
      }
    }
    db.cleanStaleSessions(this.controlPool).catch(console.error);

    // Initialise/reset the event delivery cursor. A changed started_at means the
    // daemon process restarted (its seq counter reset to 0), so we reset `high`;
    // a plain reconnect of the same process keeps the cursor so replayed events
    // are still recognised as duplicates.
    const prevSeq = this.daemonSeq.get(daemonId);
    if (!prevSeq || prevSeq.startedAt !== daemonStartedAt) {
      // New daemon incarnation (non-graceful restart / rebuild / fresh install):
      // seqCtr resets to 0. We deliberately do NOT clear subagent_usage_seen here —
      // dedup is now keyed on content (usage_hash), not seq, so replayed usage from
      // a from-scratch child-JSONL re-tail is correctly recognised as already-counted.
      // Clearing the table here was the amplifier behind the subagents.token_* runaway.
      // Seed the persisted mark from the daemon's reported durable baseline. A
      // daemon that reconnects (after the grace window dropped our entry) or
      // restarts from its spool replays only its unacked tail; without this the
      // contiguous mark would stall on the phantom gap before that tail.
      const baseline = Math.max(0, Number(msg.acked_seq) || 0);
      if (prevSeq) {
        // Stop old persistence completions from joining this incarnation. If an
        // old effect is already running, let it settle before installing the
        // new cursor so it cannot overwrite newer state. A failed effect
        // resolves the drain and remains pending in the DB ledger for replay.
        prevSeq.accepting = false;
        if (prevSeq.drainPromise) {
          const retireMs = Math.max(100, Number(process.env.DAEMON_CURSOR_RETIRE_MS) || 5_000);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const retired = await Promise.race([
            prevSeq.drainPromise.then(() => true),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), retireMs); timer.unref?.(); }),
          ]);
          if (timer) clearTimeout(timer);
          if (!retired) {
            const restored = await compensateActivation();
            if (restored) {
              prevSeq.accepting = true;
              if (!prevSeq.draining && prevSeq.pending.has(prevSeq.persistedHigh + 1)) {
                prevSeq.drainPromise = this.drainPersisted(daemonId, prevSeq);
                void prevSeq.drainPromise;
              }
            }
            this.send(ws, { type: 'register_rejected', reason: 'previous_effect_draining', retryable: true });
            ws.close(4012, 'previous effect still draining');
            return false;
          }
        }
        if (ws.readyState !== 1) {
          const restored = await compensateActivation();
          if (restored) {
            prevSeq.accepting = true;
            if (!prevSeq.draining && prevSeq.pending.has(prevSeq.persistedHigh + 1)) {
              prevSeq.drainPromise = this.drainPersisted(daemonId, prevSeq);
              void prevSeq.drainPromise;
            }
          }
          return false;
        }
        prevSeq.pending.clear();
        prevSeq.effects.clear();
        prevSeq.inflight.clear();
      }
      this.daemonSeq.set(daemonId, {
        startedAt: daemonStartedAt, persistedHigh: baseline, pending: new Set(), effects: new Map(),
        draining: false, inflight: new Set(), baselineSet: baseline > 0, accepting: true,
      });
    }

    try {
      await db.consolidateOfflineMachineDaemons(this.controlPool, { userId, daemonId, machineId });
    } catch (e) {
      console.error('consolidate offline machine daemons:', e);
      await compensateActivation();
      this.send(ws, { type: 'register_rejected', reason: 'machine_consolidation_failed', retryable: true });
      ws.close(1011, 'machine consolidation failed');
      return false;
    }

    if (previousDaemon && previousDaemon.ws !== ws) {
      this.cancelDaemonRevocationGate(previousDaemon.registrationId);
    }
    this.daemons.set(daemonId, { ws, daemonId, hostname, agents, userId, os: daemonOS, ip: daemonIP, port: daemonPort, arch: daemonArch, version: daemonVersion, startedAt: daemonStartedAt, registrationId, tokenJti });
    if (tokenJti) this.authLeases.confirm(registrationId);
    console.log('[ws] daemon registered', daemonId, 'agents:', JSON.stringify(agents), 'userId:', userId);
    if (previousDaemon && previousDaemon.ws !== ws) {
      const reason = previousDaemon.startedAt === daemonStartedAt
        ? 'replaced by reconnect'
        : 'replaced by new incarnation';
      previousDaemon.ws.close(4009, reason);
    }

    // Advertise at-least-once delivery support so the daemon retains an unacked
    // buffer and trims it on our event_ack (rather than legacy trim-on-write).
    const streamTransport = {
      max_event_bytes: this.maxEventBytes,
      max_chunk_bytes: this.maxChunkBytes,
    };
    this.send(ws, durableIngressEnabled
      ? {
        type: 'register_ack', status: 'ok', connection_id: daemonId, supports_event_ack: true,
        capabilities: ['durable_inbox', 'ack_watermark', 'flow_control', 'tool_output_stream_v1'],
        event_window: this.durableIngressEventWindow,
        daemon_generation: Math.max(0, Number(daemonStartedAt) || 0),
        ...streamTransport,
      }
      : {
        type: 'register_ack', status: 'ok', connection_id: daemonId, supports_event_ack: true,
        capabilities: ['tool_output_stream_v1'],
        ...streamTransport,
      });
    if (userId) this.broadcastQuotaStatus(userId).catch(console.error);
    if (userId && this.recoveryObserver) {
      void this.recoveryObserver.confirmedOnline({
        userId,
        daemonId,
        registrationGeneration: registrationId,
      }).catch((e) => console.error('[attention-inbox] recovery online projection:', e));
    }

    // Rebuild the session→daemon routing table for this daemon. The in-memory
    // map is volatile (lost on relay restart; stale entries survive disconnects),
    // so historical sessions owned by this daemon would otherwise be unroutable
    // until a fresh session_status/session_discovered event re-registers them.
    // Two sources: (1) the active session IDs the daemon just reported in its
    // register message, and (2) the DB-backed sessions.daemon_id column, which
    // covers sessions created before this connection.
    this.rebuildSessionRoutes(daemonId, msg.active_session_ids).catch((e) => {
      console.error('rebuildSessionRoutes:', e);
    });

    // Reconcile zombie sessions: the daemon's reported live set is authoritative.
    // Any running/busy DB row this daemon owns but no longer has (agent ended
    // mid-turn without a terminal status) gets closed and pushed to clients.
    // Guard on Array so legacy daemons (no active_session_ids) are left untouched.
    if (Array.isArray(msg.active_session_ids)) {
      db.reconcileDaemonSessions(this.controlPool, daemonId, msg.active_session_ids, registrationId)
        .then((closed) => {
          const active = this.daemons.get(daemonId);
          if (!active || active.ws !== ws || active.registrationId !== registrationId) return;
          if (!closed.length) return;
          console.log(`[router] reconciled ${closed.length} zombie session(s) for daemon ${daemonId}`);
          for (const sid of closed) {
            for (const [clientWs, client] of this.clients) {
              if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
                this.send(clientWs, { type: 'session_status', session_id: sid, status: 'completed' });
              }
            }
          }
        })
        .catch((e) => console.error('reconcileDaemonSessions:', e));
    }

    // Activation and register_ack above are the registration commit point.
    // Alias lookup/broadcast is best-effort and must never reject or hang the
    // per-daemon registration chain after that point.
    void db.getDaemonAlias(this.controlPool, daemonId).then((alias) => {
      const active = this.daemons.get(daemonId);
      if (!active || active.ws !== ws || active.registrationId !== registrationId) return;
      for (const [clientWs, client] of this.clients) {
        if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
          this.send(clientWs, { type: 'daemon_status', daemon_id: daemonId, status: 'online', hostname, agents, alias, os: daemonOS, ip: daemonIP });
        }
      }
    }).catch((e) => console.error('getDaemonAlias:', e));

    // Push "online" only on a genuine offline→online transition. A flap
    // reconnect inside the grace window never ran finalize, so knownOffline
    // has no entry → no push. A relay restart loses this set, so the first
    // reconnect after restart also doesn't push (desirable — daemons aren't
    // "back", they just reconnected to the new process). Pro-only.
    const wasOffline = this.knownOffline.delete(daemonId);
    if (wasOffline && userId && !this.shuttingDown) {
      this.maybePushToPro(userId, daemonOnlinePush(hostname, daemonId)).catch(console.error);
    }
    return true;
  }

  /**
   * Unregister a daemon. `closedWs` is the WebSocket whose 'close' event
   * triggered this. We compare it against the registered connection BEFORE
   * deleting: when a daemon reconnects (new socket registers the same
   * daemonId), the OLD socket's delayed 'close' event must NOT evict the NEW
   * connection — otherwise the relay permanently marks the daemon offline
   * even though it is alive, because the daemon never re-sends register.
   */
  unregisterDaemon(daemonId: string, closedWs?: WebSocket): void {
    const daemon = this.daemons.get(daemonId);
    // A close for a socket that no longer owns this daemonId belongs to a
    // stale/previous connection — ignore it entirely.
    if (closedWs && daemon && daemon.ws !== closedWs) {
      return;
    }
    if (!daemon) return;
    this.cancelDaemonRevocationGate(daemon.registrationId);

    // Clean up any pending takeover timer
    const takeover = this.takeoverTimers.get(daemonId);
    if (takeover) {
      clearTimeout(takeover.timer);
      this.takeoverTimers.delete(daemonId);
    }

    // Immediate (not deferred): an in-flight session_create on this daemon has
    // failed — the origin client must not wait out the grace window for it.
    this.pendingSessionCreate.delete(daemonId);
    this.pendingSessionMeta?.delete(daemonId);
    for (const pending of [...this.pendingSessionOperations.values()]) {
      if (pending.daemonId !== daemonId) continue;
      if (pending.origin.readyState === 1) {
        if (pending.operation === 'create') {
          this.send(pending.origin, { type: 'session_create_failed', request_id: pending.requestId, reason: 'daemon_offline', error: 'daemon disconnected' });
        } else {
          this.send(pending.origin, { type: 'user_message_nack', request_id: pending.requestId, reason: 'daemon_offline' });
        }
      }
      void this.settlePendingSessionOperation(pending, { kind: 'uncertain', reason: 'daemon_offline' })
        .catch((e) => console.error('mark quota reservation uncertain:', e));
    }

    // Defer the offline declaration behind the grace window. The daemon entry
    // stays in this.daemons (holding the dead socket; routing no-ops via the
    // readyState guard) so a reconnect within the window restores it without a
    // visible offline→online flap. registerDaemon cancels this timer on reconnect.
    if (this.pendingOfflineTimers.has(daemonId)) return;
    // The socket whose closure we're reacting to. When called without an explicit
    // closedWs, fall back to the entry's current socket so the reconnect check
    // below still works (a reconnect swaps in a different socket object).
    const closedSocket = closedWs ?? daemon.ws;
    const timer = setTimeout(() => {
      this.pendingOfflineTimers.delete(daemonId);
      // If the daemon reconnected on a new socket, the entry now holds a live
      // socket different from the one that closed — do not declare it offline.
      const current = this.daemons.get(daemonId);
      if (current && current.ws !== closedSocket) return;
      void this.finalizeDaemonOffline(daemonId, daemon);
    }, this.offlineGraceMs);
    this.pendingOfflineTimers.set(daemonId, timer);
  }

  /**
   * Finalize the offline transition for a daemon whose grace window elapsed
   * without a reconnect: remove it from the map, persist offline, push (unless
   * shutting down), broadcast offline, and drop/notify its routed sessions.
   */
  private async finalizeDaemonOffline(daemonId: string, daemon: DaemonConnection): Promise<void> {
    const current = this.daemons.get(daemonId);
    if (!current || current.ws !== daemon.ws || current.registrationId !== daemon.registrationId) return;
    const hostname = daemon.hostname || 'unknown';
    const userId = daemon.userId ?? null;
    this.cancelDaemonRevocationGate(daemon.registrationId);
    this.daemons.delete(daemonId);
    this.daemonSeq.delete(daemonId);
    this.daemonMetrics.delete(daemonId);

    const markedOffline = await this.setDaemonOfflineWithRetry(daemonId, daemon.registrationId);
    // A registration may have won after the captured generation was removed
    // from memory but before its DB CAS ran. Never publish stale offline state.
    if (!markedOffline || this.daemons.has(daemonId)) return;

    if (userId && this.recoveryObserver && !this.shuttingDown) {
      void this.recoveryObserver.confirmedOffline({
        userId,
        daemonId,
        registrationGeneration: daemon.registrationId,
        daemonDisplayName: hostname,
      }).catch((e) => console.error('[attention-inbox] recovery offline projection:', e));
    }

    // Push notification for daemon offline — suppressed during relay shutdown
    // (the daemon is about to reconnect to the new process, not truly offline).
    if (userId && !this.shuttingDown) {
      notifyUser(this.pool, userId, daemonOfflinePush(hostname, daemonId)).catch(console.error);
    }
    // Mark as genuinely offline so a subsequent reconnect can push "online".
    // Only set when finalize actually ran — a grace-window flap reconnect
    // never reaches here, so it won't trigger an online push (no false "back").
    this.knownOffline.add(daemonId);

    // Broadcast offline status with alias (async fetch)
    db.getDaemonAlias(this.pool, daemonId).then((alias) => {
      if (this.daemons.has(daemonId)) return;
      for (const [clientWs, client] of this.clients) {
        if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
          this.send(clientWs, { type: 'daemon_status', daemon_id: daemonId, status: 'offline', hostname, last_seen_at: new Date().toISOString(), alias });
        }
      }
    }).catch(console.error);

    const affectedSessions: string[] = [];
    for (const [sessionId, dId] of this.sessionToDaemon) {
      if (dId === daemonId) affectedSessions.push(sessionId);
    }
    for (const sessionId of affectedSessions) {
      // Drop now-unroutable entries: the daemon is gone, so leaving them would
      // point future messages at a dead socket (resolved to "daemon offline").
      // A daemon reconnect (or the DB fallback) repopulates them when needed.
      // Clients receive daemon_status for this connectivity change; preserving
      // the last session_status keeps transport loss separate from lifecycle.
      this.sessionToDaemon.delete(sessionId);
    }
  }

  /**
   * A daemon can explicitly announce a graceful local stop before its socket
   * closes. In that case clients should see offline immediately instead of
   * waiting for the reconnect grace window used for network flaps.
   */
  private finalizeDaemonShutdown(daemonId: string): void {
    const daemon = this.daemons.get(daemonId);
    if (!daemon) return;

    const timer = this.pendingOfflineTimers.get(daemonId);
    if (timer) {
      clearTimeout(timer);
      this.pendingOfflineTimers.delete(daemonId);
    }

    void this.finalizeDaemonOffline(daemonId, daemon);
  }

  private async setDaemonOfflineWithRetry(daemonId: string, registrationId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.setDaemonOfflineWithTimeout(
          this.controlPool, daemonId, registrationId, this.offlineWriteTimeoutMs,
        );
      } catch (e) {
        console.error('setDaemonOffline:', e);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    console.error(`[router] generation-bound offline failed permanently: daemon=${daemonId} registration=${registrationId}`);
    return false;
  }

  /**
   * Rebuild session→daemon routing entries for a freshly (re)connected daemon.
   * Merges two sources: the active session IDs the daemon reported in its
   * register message, and every session the DB still attributes to this daemon.
   * Idempotent — only adds entries, never removes unrelated ones.
   */
  private async rebuildSessionRoutes(daemonId: string, reportedIds?: string[]): Promise<void> {
    const sessionIds = new Set<string>(reportedIds || []);
    try {
      const rows = await this.pool.query(
        `SELECT session_id FROM sessions WHERE daemon_id = $1 AND session_id NOT LIKE 'pending-%'`,
        [daemonId]
      );
      for (const r of rows.rows) sessionIds.add(r.session_id);
    } catch (e) {
      console.error('rebuildSessionRoutes query:', e);
    }
    let added = 0;
    for (const sid of sessionIds) {
      if (!this.sessionToDaemon.has(sid)) {
        this.sessionToDaemon.set(sid, daemonId);
        added++;
      }
    }
    if (added) console.log(`[router] rebuilt routes for daemon ${daemonId}: +${added} sessions`);
  }

  registerClient(ws: WebSocket, userId: number | null): void {
    // Idempotent: a client is now registered on auth success (server.ts) AND
    // re-registered on its first message (processMessage). Preserve the
    // existing subscribedSessions/locale so a re-entry doesn't wipe the
    // client's active session subscriptions.
    const existing = this.clients.get(ws);
    this.clients.set(ws, {
      ws,
      subscribedSessions: existing?.subscribedSessions ?? new Set(),
      userId,
      locale: existing?.locale ?? 'zh',
    });
  }
  unregisterClient(ws: WebSocket): void { this.clients.delete(ws); }

  /**
   * Advance the per-daemon ack water-mark to the highest *contiguous* persisted
   * seq. event_ack reports this, so the daemon trims its outbound buffer/spool
   * only once an event is durably stored. Out-of-order completions wait in
   * `pending` until the gap before them fills. A missing seq has no watermark
   * effect, but its durable callback runs immediately for legacy daemons.
   */
  private markPersisted(daemonId: string, seq?: number, effect?: () => Promise<void> | void, state?: DaemonSeqState): void {
    if (!seq) {
      if (effect) void Promise.resolve(effect()).catch((e) => {
        if (e instanceof QuotaReservationBindingError) {
          console.error('[router] quota outcome permanently rejected', { daemonId, code: e.code });
          this.rejectDaemonConnection(daemonId, e.code);
          return;
        }
        console.error('durable effect:', e);
      });
      return;
    }
    const st = state ?? this.daemonSeq.get(daemonId);
    if (!st || !st.accepting || this.daemonSeq.get(daemonId) !== st) return;
    if (seq <= st.persistedHigh) {
      st.inflight.delete(seq);
      return;
    }
    st.pending.add(seq);
    if (effect) st.effects.set(seq, effect);
    if (!st.draining) {
      st.drainPromise = this.drainPersisted(daemonId, st);
      void st.drainPromise;
    }
  }

  private async drainPersisted(daemonId: string, st: DaemonSeqState): Promise<void> {
    if (st.draining) return;
    st.draining = true;
    try {
      while (st.accepting && st.pending.has(st.persistedHigh + 1)) {
        const seq = st.persistedHigh + 1;
        const durableEffect = st.effects.get(seq);
        if (durableEffect) {
          try {
            await durableEffect();
          } catch (e) {
            if (e instanceof QuotaReservationBindingError
              || e instanceof db.SessionOwnershipViolationError
              || e instanceof db.UnknownDaemonSessionError) {
              // The ledger is durable but the claimed quota outcome is
              // permanently contradictory, or the post-fence mutation found
              // a permanent ownership violation. Advance exactly this poison
              // sequence, ACK it, then close so replay cannot pin the spool.
              st.pending.delete(seq);
              st.effects.delete(seq);
              st.persistedHigh = seq;
              st.inflight.delete(seq);
              const reason = e instanceof QuotaReservationBindingError
                ? e.code
                : 'session_ownership_violation';
              console.error('[router] daemon effect permanently rejected', {
                daemonId, errorName: e.name, code: e.code,
              });
              const daemon = this.daemons.get(daemonId);
              if (daemon?.ws.readyState === 1) {
                this.send(daemon.ws, { type: 'event_ack', up_to_seq: st.persistedHigh });
              }
              this.rejectDaemonConnection(daemonId, reason);
              return;
            }
            // Keep pending/effect at this seq and withhold the contiguous ack.
            // Clearing in-flight permits a replay to refresh and retry it.
            st.inflight.delete(seq);
            console.error('durable effect:', e);
            return;
          }
        }
        st.pending.delete(seq);
        st.effects.delete(seq);
        st.persistedHigh = seq;
        st.inflight.delete(seq);
      }
    } finally {
      st.draining = false;
      st.drainPromise = undefined;
    }
  }

  /**
   * Persist a daemon event and advance the ack water-mark ONLY on durable
   * success. If persistEvent exhausts its retries it rejects — we then withhold
   * the ack so the daemon keeps the event buffered and replays it on reconnect
   * (where it is re-persisted), rather than acking-then-losing it.
   *
   * Ownership violations are permanent security rejections: the sequence is
   * marked permanently handled (so the contiguous ACK keeps progressing and
   * the daemon spool is not poisoned) and the offending connection is closed
   * without revealing whether the target session exists.
   */
  private persistAndAck(
    daemonId: string,
    seq: number | undefined,
    sessionId: string,
    type: string,
    payload: any,
    originatingState?: DaemonSeqState,
    receivedAt: Date = new Date(),
  ): void {
    const state = originatingState ?? this.daemonSeq.get(daemonId);
    const runMaterialize = (): Promise<import('./materialization/types.js').MaterializationResult> =>
      this.legacyPersist.run(daemonId, () => this.materializer.materialize({
        inboxId: 0,
        userId: this.daemons.get(daemonId)?.userId ?? null,
        daemonId,
        sessionId,
        eventType: type,
        payload,
        receivedAt,
        context: this.materializationContext(daemonId, payload),
      }, undefined, { deferEffects: true }));
    const settle = (result: import('./materialization/types.js').MaterializationResult): void => {
      const applyAndDeliver = async () => {
        await result.applyEffects?.();
        if (result.eventId !== null && !result.inserted && result.completed) return;
        for (const delivery of result.deliveries) this.deliverMaterializedEvent(delivery);
        await result.finalizeEffect?.();
      };
      if (!state && result.eventId === null) {
        void applyAndDeliver().catch((e) => console.error('durable effect:', e));
        return;
      }
      this.markPersisted(daemonId, seq, applyAndDeliver, state);
    };
    const failWith = (e: unknown): void => {
      if (e instanceof ExecutorOverloadedError) {
        this.sendRetryableDisconnect(daemonId, 'relay_overloaded', 500);
        return;
      }
      if (e instanceof db.SessionOwnershipViolationError || e instanceof db.UnknownDaemonSessionError
        || e instanceof QuotaReservationBindingError) {
        // Structured security audit without payload, session, or owner details.
        console.error('[router] daemon event permanently rejected', {
          daemonId,
          errorName: e.name,
          code: (e as { code?: string }).code,
        });
        const permanentState = state ?? this.daemonSeq.get(daemonId);
        const reason = e instanceof QuotaReservationBindingError
          ? e.code
          : 'session_ownership_violation';
        const rejectAfterAck = (ackSeq?: number) => {
          const activeDaemon = this.daemons.get(daemonId);
          if (ackSeq && activeDaemon?.ws.readyState === 1) {
            this.send(activeDaemon.ws, { type: 'event_ack', up_to_seq: ackSeq });
          }
          this.rejectDaemonConnection(daemonId, reason);
        };
        if (!seq || !permanentState || this.daemonSeq.get(daemonId) !== permanentState
          || !permanentState.accepting || seq <= permanentState.persistedHigh) {
          rejectAfterAck(seq && permanentState ? permanentState.persistedHigh : undefined);
          return;
        }
        // Queue the permanent rejection at its contiguous sequence instead of
        // closing early while a lower durable effect is still in flight.
        this.markPersisted(daemonId, seq, () => {
          // This terminal effect runs only after every lower sequence has
          // completed, so acknowledging this poison sequence is now safe.
          rejectAfterAck(seq);
        }, permanentState);
        return;
      }
      console.error('persistAndAck:', e);
    };
    const first = runMaterialize();
    this.trackPersistInflight(daemonId, seq, first);
    first.then(settle, (e) => {
      if (seq) state?.inflight.delete(seq);
      if (e instanceof db.UnknownDaemonSessionError && seq) {
        // The legacy inline path materializes same-daemon events concurrently,
        // so a lower-seq lifecycle event (e.g. session_created) can still be
        // in flight when this event probes the session. Wait for it and retry
        // once before classifying the session as permanently unknown.
        const earlier = this.pendingEarlierPersists(daemonId, seq);
        if (earlier) {
          void earlier.then(() => {
            const retry = runMaterialize();
            this.trackPersistInflight(daemonId, seq, retry);
            retry.then(settle, failWith);
          });
          return;
        }
      }
      failWith(e);
    });
  }

  /** In-flight inline materializations per daemon, keyed by transport seq. */
  private persistInflight = new Map<string, Map<number, Promise<unknown>>>();

  private trackPersistInflight(daemonId: string, seq: number | undefined, promise: Promise<unknown>): void {
    if (!seq) return;
    let bySeq = this.persistInflight.get(daemonId);
    if (!bySeq) {
      bySeq = new Map();
      this.persistInflight.set(daemonId, bySeq);
    }
    const tracked = bySeq;
    // The tracked promise only gates later unknown-session retries; it must
    // never surface the settlement (or rejection) itself.
    const settled = Promise.resolve(promise).then(() => undefined, () => undefined);
    tracked.set(seq, settled.finally(() => { tracked.delete(seq); }));
  }

  private pendingEarlierPersists(daemonId: string, seq: number): Promise<unknown[]> | null {
    const bySeq = this.persistInflight.get(daemonId);
    if (!bySeq) return null;
    const earlier = [...bySeq.entries()]
      .filter(([inflightSeq]) => inflightSeq < seq)
      .map(([, promise]) => promise);
    if (earlier.length === 0) return null;
    return Promise.allSettled(earlier);
  }

  /** Policy-close a daemon connection for a security rejection. */
  private rejectDaemonConnection(daemonId: string, reason: string): void {
    const daemon = this.daemons.get(daemonId);
    if (!daemon || daemon.ws.readyState !== 1) return;
    this.send(daemon.ws, { type: 'kicked', reason, retryable: false });
    daemon.ws.close(1008, reason);
  }

  private sendRetryableDisconnect(daemonId: string, reason: string, retryAfterMs: number): void {
    const daemon = this.daemons.get(daemonId);
    if (!daemon || daemon.ws.readyState !== 1) return;
    this.send(daemon.ws, { type: 'relay_overloaded', reason, retryable: true, retry_after_ms: retryAfterMs });
    daemon.ws.close(1013, reason);
  }

  private cancelDaemonRevocationGate(registrationId: string): void {
    this.authLeases.remove(registrationId);
    const state = this.daemonRevocationGates.get(registrationId);
    if (!state) return;
    state.closed = true;
    state.queue.length = 0;
    state.queuedBytes = 0;
    if (this.daemonRevocationGates.get(registrationId) === state) {
      this.daemonRevocationGates.delete(registrationId);
    }
  }

  private failClosedDaemonRevocationGate(
    daemonId: string,
    daemon: DaemonConnection,
    state: DaemonRevocationGateState,
    code: number,
    closeReason: string,
    kickedReason: string,
    messageType: 'kicked' | 'disconnect' = 'kicked',
  ): void {
    if (state.closed) return;
    this.cancelDaemonRevocationGate(daemon.registrationId);
    const current = this.daemons.get(daemonId);
    if (!current || current.ws !== daemon.ws || current.registrationId !== daemon.registrationId) return;
    const cursor = this.daemonSeq.get(daemonId);
    if (cursor) cursor.accepting = false;
    this.send(daemon.ws, { type: messageType, reason: kickedReason, retryable: messageType === 'disconnect' });
    daemon.ws.close(code, closeReason);
    void this.finalizeDaemonOffline(daemonId, daemon)
      .catch((e) => console.error('heartbeat fail-closed cleanup:', e));
  }

  private failClosedExpiredAuthLease(daemonId: string, daemon: DaemonConnection): void {
    const current = this.daemons.get(daemonId);
    if (!current || current.ws !== daemon.ws || current.registrationId !== daemon.registrationId) return;
    this.cancelDaemonRevocationGate(daemon.registrationId);
    const cursor = this.daemonSeq.get(daemonId);
    if (cursor) cursor.accepting = false;
    this.send(daemon.ws, { type: 'disconnect', reason: 'token_check_unavailable', retryable: true });
    daemon.ws.close(1011, 'token check unavailable');
    void this.finalizeDaemonOffline(daemonId, daemon)
      .catch((e) => console.error('expired auth lease cleanup:', e));
  }

  private settleDaemonRevocationGate(
    daemonId: string,
    daemon: DaemonConnection,
    state: DaemonRevocationGateState,
    admitted: boolean,
  ): void {
    if (state.closed) return;
    const current = this.daemons.get(daemonId);
    if (!admitted || !current || current.ws !== daemon.ws || current.registrationId !== daemon.registrationId) {
      this.cancelDaemonRevocationGate(daemon.registrationId);
      return;
    }
    const queued = state.queue.splice(0);
    state.queuedBytes = 0;
    state.closed = true;
    if (this.daemonRevocationGates.get(daemon.registrationId) === state) {
      this.daemonRevocationGates.delete(daemon.registrationId);
    }
    for (const item of queued) {
      this.handleDaemonMessage(
        item.daemonId, item.msg, item.originWs, item.originStartedAt, true, item.receivedAt,
      );
    }
  }

  private startDaemonRevocationGate(daemonId: string, daemon: DaemonConnection): DaemonRevocationGateState {
    const state: DaemonRevocationGateState = {
      promise: Promise.resolve(false), queue: [], queuedBytes: 0, closed: false,
    };
    state.promise = db.isTokenRevokedWithTimeout(
      this.controlPool, daemon.tokenJti!, this.revocationCheckTimeoutMs,
    ).then((revoked) => {
      const current = this.daemons.get(daemonId);
      if (!current || current.ws !== daemon.ws || current.registrationId !== daemon.registrationId) return false;
      if (revoked) {
        this.failClosedDaemonRevocationGate(
          daemonId, daemon, state, 4001, 'token revoked', 'token_revoked',
        );
        return false;
      }
      this.authLeases.confirm(daemon.registrationId);
      return true;
    }).catch((e) => {
      console.error('heartbeat token recheck:', e);
      if (this.authLeases.onLookupUnavailable(daemon.registrationId) === 'keep') return true;
      this.failClosedDaemonRevocationGate(
        daemonId, daemon, state, 1011, 'token check unavailable', 'token_check_unavailable', 'disconnect',
      );
      return false;
    });
    this.daemonRevocationGates.set(daemon.registrationId, state);
    void state.promise.then((admitted) => {
      this.settleDaemonRevocationGate(daemonId, daemon, state, admitted);
    }).catch((e) => console.error('daemon revocation gate settle:', e));
    return state;
  }

  private enqueueDaemonRevocationGate(
    daemonId: string,
    daemon: DaemonConnection,
    state: DaemonRevocationGateState,
    msg: any,
    originWs: WebSocket,
    originStartedAt: number | undefined,
    receivedAt: Date,
  ): void {
    if (state.closed) return;
    let bytes = this.revocationGateMaxBytes + 1;
    try { bytes = Buffer.byteLength(JSON.stringify(msg), 'utf8'); } catch { /* overflow below */ }
    if (state.queue.length >= this.revocationGateMaxMessages
      || state.queuedBytes + bytes > this.revocationGateMaxBytes) {
      this.failClosedDaemonRevocationGate(
        daemonId, daemon, state, 1011, 'revocation gate overflow', 'token_check_overflow',
      );
      return;
    }
    state.queue.push({ daemonId, msg, originWs, originStartedAt, bytes, receivedAt });
    state.queuedBytes += bytes;
  }

  private acceptDaemonHeartbeat(daemonId: string, daemon: DaemonConnection, msg: any): void {
    const current = this.daemons.get(daemonId);
    const cursor = this.daemonSeq.get(daemonId);
    if (!current || current.ws !== daemon.ws || current.registrationId !== daemon.registrationId || !cursor?.accepting) return;
    this.send(daemon.ws, { type: 'pong' });
    db.updateHeartbeat(this.controlPool, daemonId).catch(console.error);
    const openCodeRuntime = sanitizeOpenCodeRuntimeTelemetry(msg.opencode_runtime);
    if (msg.cpu_pct !== undefined || openCodeRuntime) {
      const previous = this.daemonMetrics.get(daemonId);
      this.daemonMetrics.set(daemonId, {
        cpuPct: msg.cpu_pct ?? previous?.cpuPct ?? 0,
        memPct: msg.mem_pct ?? previous?.memPct ?? 0,
        diskPct: msg.disk_pct ?? previous?.diskPct ?? 0,
        updatedAt: Date.now(),
        openCodeRuntime: openCodeRuntime ?? previous?.openCodeRuntime,
      });
    }
    if (cursor.persistedHigh > 0) this.send(daemon.ws, { type: 'event_ack', up_to_seq: cursor.persistedHigh });
    this.markPersisted(daemonId, msg.seq);
  }

  handleDaemonMessage(
    daemonId: string,
    msg: any,
    originWs?: WebSocket,
    originStartedAt?: number,
    revocationAdmitted = false,
    receivedAt: Date = new Date(),
  ): void {
    let originDaemon: DaemonConnection | undefined;
    if (originWs) {
      const daemon = this.daemons.get(daemonId);
      const cursor = this.daemonSeq.get(daemonId);
      if (!daemon || daemon.ws !== originWs || daemon.startedAt !== originStartedAt
        || !cursor || cursor.startedAt !== originStartedAt || !cursor.accepting) return;
      originDaemon = daemon;
    }
    if (!revocationAdmitted && originDaemon?.tokenJti
      && !this.authLeases.isUsable(originDaemon.registrationId)) {
      this.failClosedExpiredAuthLease(daemonId, originDaemon);
      return;
    }
    // A ping creates one shared per-generation revocation gate before any seq
    // admission. Messages arriving behind that check are replayed in arrival
    // order only on success; failure admits none and therefore leaves no gap.
    if (!revocationAdmitted && originDaemon?.tokenJti) {
      const pending = this.daemonRevocationGates.get(originDaemon.registrationId);
      if (pending || (msg.type === 'ping' && this.authLeases.shouldRefresh(originDaemon.registrationId))) {
        const gate = pending ?? this.startDaemonRevocationGate(daemonId, originDaemon);
        this.enqueueDaemonRevocationGate(
          daemonId, originDaemon, gate, msg, originWs!, originStartedAt, receivedAt,
        );
        return;
      }
    }
    msg = sanitizeJSONBPayload(msg);
    if (this.writeTokenUsageFacts
      && msg.type === 'agent_text'
      && msg.usage != null
      && (!Number.isSafeInteger(msg.seq) || msg.seq <= 0)) {
      this.sendRetryableDisconnect(daemonId, 'token_usage_requires_seq', 5_000);
      return;
    }
    const policy = classifyDaemonEvent(msg);
    let durableIngressOwnsAck = false;
    if (msg.seq) {
      try {
        this.observeIngressClass?.(daemonId, policy.priority);
      } catch (e) {
        console.error('observe ingress class:', e);
      }
      // Durable ingress takes ownership before the legacy in-flight cursor and
      // persist-and-effect path. This is deliberately an early return: running
      // both paths would produce two independent persistence/ack side effects.
      if (this.durableIngressEnabledFor(daemonId)) {
        const daemon = originDaemon ?? this.daemons.get(daemonId);
        if (daemon) {
          const target: IngressTarget = {
            daemonId,
            registrationId: daemon.registrationId,
            userId: daemon.userId,
            daemonGeneration: Math.max(0, Number(daemon.startedAt) || 0),
          };
          const accepted = this.durableIngress.accept(
            target, msg, this.materializationContext(daemonId, msg),
          );
          if (accepted.kind === 'accepted') {
            durableIngressOwnsAck = true;
            if (policy.durable) return;
          }
          if (accepted.kind === 'backpressured') {
            this.sendDurableFlowControl(target, accepted.state);
            if (accepted.state.reason !== 'event_too_large') {
              this.disconnectDurableIngress(
                target, accepted.state.reason, accepted.state.retryAfterMs,
              );
            }
            return;
          }
        }
      }
    }
    // At-least-once dedup keyed on the *persisted* water-mark: a seq at or below
    // it has already been durably stored, so a reconnect replay of it is a
    // duplicate — drop it. A seq above the mark (received before but its persist
    // failed, or genuinely new) is (re)processed; the events.event_hash unique
    // index independently prevents duplicate DB rows. The mark advances only via
    // markPersisted (after the DB write), never synchronously on receipt.
    let messageState: DaemonSeqState | undefined;
    if (msg.seq && !durableIngressOwnsAck) {
      const st = this.daemonSeq.get(daemonId);
      if (st) {
        if (msg.seq <= st.persistedHigh) return;
        if (st.inflight.has(msg.seq)) return;
        // Establish the contiguity floor from the FIRST seq seen on a fresh entry
        // (set synchronously, in receive order, so it's the lowest). This covers
        // legacy daemons that don't report acked_seq and any daemon that replays
        // only its unacked tail (seq > 1) — without it the mark would stall on the
        // phantom gap below that tail. Guarded by baselineSet so a burst arriving
        // before the first persist can't mis-floor past an unpersisted seq.
        if (!st.baselineSet) { st.persistedHigh = msg.seq - 1; st.baselineSet = true; }
        st.inflight.add(msg.seq);
        messageState = st;
      }
    }

    if (msg.type === 'ping') {
      const daemon = this.daemons.get(daemonId);
      if (daemon) this.acceptDaemonHeartbeat(daemonId, daemon, msg);
      return;
    }

    if (msg.type === 'daemon_shutdown') {
      if (!durableIngressOwnsAck) this.markPersisted(daemonId, msg.seq);
      this.finalizeDaemonShutdown(daemonId);
      return;
    }

    // Agent MCP grant brokerage: control-plane only, derived entirely from
    // the authenticated daemon connection; never persisted to events.
    if (msg.type === 'memory_mcp_grant') {
      const daemon = originDaemon ?? this.daemons.get(daemonId);
      const broker = this.memoryMcpGrantBroker;
      if (!daemon || !broker || !originWs) return;
      void handleMemoryMcpGrantMessage(
        broker, daemon, msg, (payload) => { if (originWs.readyState === originWs.OPEN) originWs.send(payload) },
      ).catch((error) => this.logBestEffortFailure?.('memory_mcp_grant', error));
      return;
    }

    // Handle cancel_takeover: old daemon confirms it has stopped
    // Phase 2 session-bound context grant brokerage: same control-plane
    // rules as memory_mcp_grant — identity from the authenticated daemon,
    // session ownership verified inside the broker's SQL boundary.
    if (msg.type === 'memory_context_grant') {
      const daemon = originDaemon ?? this.daemons.get(daemonId);
      const broker = this.memoryContextGrantBroker;
      if (!daemon || !broker || !originWs) return;
      void handleMemoryContextGrantMessage(
        broker, daemon, msg, (payload) => { if (originWs.readyState === originWs.OPEN) originWs.send(payload) },
      ).catch(() => undefined);
      return;
    }

    // Phase 4 least-privilege source-sync grant brokerage: identity derives
    // from the authenticated daemon; the payload may never carry repository
    // content, paths, or commit facts (strict request allowlist).
    if (msg.type === 'memory_codegraph_grant') {
      const daemon = originDaemon ?? this.daemons.get(daemonId);
      const broker = this.memoryCodegraphGrantBroker;
      if (!daemon || !broker || !originWs) return;
      void handleMemoryCodegraphGrantMessage(
        broker, daemon, msg, (payload) => { if (originWs.readyState === originWs.OPEN) originWs.send(payload) },
      ).catch(() => undefined);
      return;
    }

    // Two-phase managed-session registration ack (Phase 2): durable session
    // row first, then a bounded ready ack. Never an authorization token.
    if (msg.type === 'session_registration') {
      const daemon = originDaemon ?? this.daemons.get(daemonId);
      if (!daemon || daemon.userId === null || !originWs) return;
      void handleSessionRegistrationMessage(
        { pool: this.pool }, { userId: daemon.userId, daemonId }, msg,
        (payload) => { if (originWs.readyState === originWs.OPEN) originWs.send(payload) },
      ).catch(() => undefined);
      return;
    }

    if (msg.type === 'cancel_takeover') {
      const takeover = this.takeoverTimers.get(daemonId);
      if (takeover) {
        clearTimeout(takeover.timer);
        this.takeoverTimers.delete(daemonId);
        console.log(`[router] takeover cancelled by ${daemonId} — new daemon ${takeover.newDaemonId} accepted immediately`);
      }
      if (!durableIngressOwnsAck) this.markPersisted(daemonId, msg.seq);
      return;
    }

    const sessionId = normalizeSessionId(msg.session_id);
    if (sessionId && msg.type === 'generate_title_request') {
      if (!durableIngressOwnsAck) this.markPersisted(daemonId, msg.seq);
      void this.authorizeEphemeralTitleSession(daemonId, sessionId).then((allowed) => {
        if (!allowed) return;
        this.runEphemeralTitleEffect(
          daemonId, msg, 'user', (input) => this.generateSessionTitleDelivery(input),
        );
      }).catch((error) => this.logBestEffortFailure('generate_title_request authorization', error));
      return;
    }
    if (sessionId && msg.type === 'generate_subagent_title_request') {
      if (!durableIngressOwnsAck) this.markPersisted(daemonId, msg.seq);
      void this.authorizeEphemeralTitleSession(daemonId, sessionId).then((allowed) => {
        if (!allowed) return;
        this.runEphemeralTitleEffect(
          daemonId, msg, 'session', (input) => this.generateSubagentTitleDelivery(input),
        );
      }).catch((error) => this.logBestEffortFailure('generate_subagent_title_request authorization', error));
      return;
    }
    if (sessionId && msg.type === 'session_title_update') {
      if (!durableIngressOwnsAck) this.markPersisted(daemonId, msg.seq);
      void this.authorizeEphemeralTitleSession(daemonId, sessionId).then((allowed) => {
        if (!allowed) return;
        this.deliverMaterializedEvent({
          eventId: null,
          userId: this.daemons.get(daemonId)?.userId ?? null,
          audience: 'user',
          sessionId,
          requestId: typeof msg.request_id === 'string' ? msg.request_id : null,
          ordinal: 0,
          deliveryKey: `ephemeral:${daemonId}:${String(msg.seq ?? '')}:session_title_update`,
          type: 'session_title_update',
          payload: msg,
        });
        void this.pool.query(
          `UPDATE sessions SET title = $1
           WHERE session_id = $2 AND (title LIKE 'Terminal Session-%' OR title IS NULL)`,
          [String(msg.title ?? ''), sessionId],
        ).catch((error) => this.logBestEffortFailure('session_title_update', error));
      }).catch((error) => this.logBestEffortFailure('session_title_update authorization', error));
      return;
    }
    if (!sessionId) {
      if (msg.type === 'session_create_failed') {
        this.persistAndAck(daemonId, msg.seq, '', msg.type, msg, messageState, receivedAt);
        return;
      }
      // model_list (host-level response, no session_id): broadcast to the daemon owner's clients
      if (msg.type === 'model_list') {
        const daemon = this.daemons.get(daemonId);
        if (daemon?.userId) this.broadcastToUser(daemon.userId, { ...msg, daemon_id: daemonId });
        this.markPersisted(daemonId, msg.seq);
        return;
      }
      if (msg.type === 'error') {
        const pendingClient = this.pendingSessionCreate.get(daemonId);
        if (pendingClient && pendingClient.readyState === 1) {
          this.send(pendingClient, msg);
        }
      }
      // upgrade_result: broadcast to same-user clients (no session_id)
      if (msg.type === 'upgrade_result') {
        const d = this.daemons.get(daemonId);
        const uid = d?.userId ?? null;
        for (const [clientWs, client] of this.clients) {
          if (clientWs.readyState === 1 && this.sameUser(client.userId, uid)) this.send(clientWs, msg);
        }
      }
      // These control/forward messages aren't persisted; ack the seq immediately
      // (no-op if they carry none) so the daemon's buffer can't stall on them.
      if (!durableIngressOwnsAck) this.markPersisted(daemonId, msg.seq);
      return;
    }
    this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg, messageState, receivedAt);
  }

  async handleClientMessage(clientWs: WebSocket, msg: any): Promise<void> {
    const client = this.clients.get(clientWs);
    if (!client) return;
    const sessionId = typeof msg.session_id === 'string' && msg.session_id
      ? msg.session_id
      : null;
    const needsControlFence = sessionId !== null
      && msg.type !== 'local_command_log'
      && !isObserverSessionMessageAllowed(msg.type);
    if (!needsControlFence || client.userId === null) {
      await this.handleClientMessageWithRuntimePolicy(clientWs, msg, null);
      return;
    }
    try {
      await db.withSessionMaterializationFence(this.controlPool, sessionId, async (lockedClient) => {
        const policy = await db.getSessionRuntimePolicy(
          lockedClient as unknown as pg.Pool,
          sessionId,
          client.userId!,
        );
        if (!policy) {
          this.send(clientWs, {
            type: 'error', session_id: sessionId, error: 'session not found or not owned',
          });
          return;
        }
        await this.handleClientMessageWithRuntimePolicy(clientWs, msg, policy);
      });
    } catch {
      this.send(clientWs, {
        type: 'error', session_id: sessionId, error: 'session not found or not owned',
      });
    }
  }

  private async handleClientMessageWithRuntimePolicy(
    clientWs: WebSocket,
    msg: any,
    sessionRuntimePolicy: db.SessionRuntimePolicy | null,
  ): Promise<void> {
    const client = this.clients.get(clientWs);
    if (!client) return;
    // Authorization chokepoint: every client message that references an existing
    // session_id must be owned by the requesting user. This single gate closes
    // both the replay IDOR (越权读历史对话) and the generic client→daemon routing
    // bypass (越权注入/控制他人会话) — previously authorization was scattered per
    // command and the generic fall-through route checked nothing at all.
    // Subscription is also deferred until after the check, so a non-owner can't
    // silently attach to another user's live event stream.
    if (msg.session_id) {
      if (client.userId == null) {
        // Anonymous/API-key connections (userId=null) may not act on a specific
        // session. Real clients always carry a userId (prod requires a token).
        this.send(clientWs, { type: 'error', session_id: msg.session_id, error: 'forbidden' });
        return;
      }
      sessionRuntimePolicy = sessionRuntimePolicy ?? await db.getSessionRuntimePolicy(
        this.pool, msg.session_id, client.userId,
      ).catch(() => null);
      if (!sessionRuntimePolicy) {
        this.send(clientWs, { type: 'error', session_id: msg.session_id, error: 'session not found or not owned' });
        return;
      }
      if (isObserverAgentType(sessionRuntimePolicy.agentType)
        && !isObserverSessionMessageAllowed(msg.type)) {
        if (msg.type === 'user_message') {
          this.send(clientWs, {
            type: 'user_message_nack',
            session_id: msg.session_id,
            request_id: msg.request_id,
            msg_id: msg.msg_id,
            reason: OBSERVER_READ_ONLY_CODE,
            retryable: false,
          });
        } else {
          this.send(clientWs, {
            type: 'error',
            session_id: msg.session_id,
            request_id: msg.request_id,
            operation: msg.type,
            code: OBSERVER_READ_ONLY_CODE,
            reason: OBSERVER_READ_ONLY_CODE,
            error: 'observer session is read-only',
          });
        }
        return;
      }
      client.subscribedSessions.add(msg.session_id);
    }
    if (msg.type === 'replay') { this.handleReplay(clientWs, msg.session_id, msg.last_seq, msg.req_id, msg.direction, msg.limit); return; }
    if (msg.type === 'replay_subagent') { this.handleReplaySubagent(clientWs, msg.session_id, msg.agent_id, msg.last_seq, msg.req_id, msg.limit, msg.direction); return; }
    if (msg.type === 'list_sessions') { this.handleListSessions(clientWs, client.userId, msg); return; }
    if (msg.type === 'list_daemons') { console.log('[router] list_daemons from user', client.userId, 'daemons in map:', this.daemons.size); this.handleListDaemons(clientWs, client.userId); return; }
    if (msg.type === 'set_locale') {
      if (msg.locale) { client.locale = msg.locale; }
      return;
    }

    if (msg.type === 'local_command_log') {
      // Locally-handled slash command (/model, /cost, /status): the user msg + receipt
      // are built client-side (no daemon round-trip). Persist both as owned events so
      // they survive refresh, then broadcast to OTHER same-user clients for
      // multi-device sync. Origin already rendered both locally, so skip echoing
      // back to avoid duplicates. Broadcast happens only after BOTH rows (and
      // their extension journal appends) have committed durably.
      const sessionId = msg.session_id;
      if (!sessionId || client.userId == null) return;
      const userEvt = { type: 'user_text', session_id: sessionId, text: msg.user_text };
      const receiptEvt = { type: 'command_receipt', session_id: sessionId, command: msg.command, receipt_status: msg.receipt_status, message: msg.message };
      try {
        await db.persistOwnedLocalCommandPair(
          this.ingestPool,
          client.userId,
          sessionId,
          userEvt,
          receiptEvt,
          this.extensionJournalSink,
        );
      } catch (error) {
        if (error instanceof db.ClientEventObserverReadOnlyError) {
          this.send(clientWs, {
            type: 'error',
            session_id: sessionId,
            request_id: msg.request_id,
            operation: msg.type,
            code: OBSERVER_READ_ONLY_CODE,
            reason: OBSERVER_READ_ONLY_CODE,
            error: 'observer session is read-only',
          });
          return;
        }
        if (error instanceof db.ClientEventOwnershipError) {
          this.send(clientWs, {
            type: 'error', session_id: sessionId, error: 'session not found or not owned',
          });
          return;
        }
        console.error('[router] local_command_log persistence failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return;
      }
      for (const [ws, c] of this.clients) {
        if (ws === clientWs || ws.readyState !== 1) continue;
        if (this.sameUser(c.userId, client.userId)) {
          this.send(ws, userEvt);
          this.send(ws, receiptEvt);
        }
      }
      return;
    }

    if (msg.type === 'session_delete') {
      const sessionId = msg.session_id;
      if (!sessionId) { this.send(clientWs, { type: 'error', error: 'session_id required' }); return; }
      // Ownership check, then delete under the session fence. The deletion
      // transaction also clears extension feed/journal content and journals a
      // tombstone (ADR-0003), so the broadcast only happens after commit.
      db.isSessionOwnedByUser(this.pool, client.userId!, sessionId).then(async (owned) => {
        if (!owned) { this.send(clientWs, { type: 'error', error: 'session not found or not owned' }); return; }
        try {
          await db.deleteSession(this.pool, sessionId, {
            usageFactsAuthoritative: this.tokenUsageFactsAuthoritative,
            writeUsageFacts: this.writeTokenUsageFacts,
            extensionMode: this.extensionJournalSink === null ? 'off' : 'enabled',
          });
        } catch (error) {
          console.error('[router] session delete failed', {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          return;
        }
        this.sessionToDaemon.delete(sessionId);
        for (const [ws, c] of this.clients) {
          if (ws.readyState === 1 && this.sameUser(c.userId, client.userId)) {
            c.subscribedSessions.delete(sessionId);
            this.send(ws, { type: 'session_deleted', session_id: sessionId });
          }
        }
      }).catch(console.error);
      return;
    }

    if (msg.type === 'session_pin') {
      const sessionId = msg.session_id;
      if (!sessionId) { this.send(clientWs, { type: 'error', error: 'session_id required' }); return; }
      const pinned = !!msg.pinned;
      db.setSessionPin(this.pool, client.userId!, sessionId, pinned).then((ok) => {
        if (!ok) { this.send(clientWs, { type: 'error', error: 'session not found or not owned' }); return; }
        for (const [ws, c] of this.clients) {
          if (ws.readyState === 1 && this.sameUser(c.userId, client.userId)) {
            this.send(ws, { type: 'session_pinned', session_id: sessionId, pinned });
          }
        }
      }).catch(console.error);
      return;
    }

    if (msg.type === 'daemon_restart') {
      const daemonId = msg.daemon_id;
      if (!daemonId) { this.send(clientWs, { type: 'error', error: 'daemon_id required' }); return; }
      const daemon = this.daemons.get(daemonId);
      if (!daemon || !this.sameUser(daemon.userId, client.userId)) {
        this.send(clientWs, { type: 'error', error: 'daemon not found or not owned' });
        return;
      }
      // Send restart command to daemon
      this.send(daemon.ws, { type: 'daemon_restart' });
      // Update status to reconnecting
      db.setDaemonReconnecting?.(this.pool, daemonId).catch(() => {});
      this.broadcastToUser(client.userId!, { type: 'daemon_status', daemon_id: daemonId, status: 'reconnecting' });
      return;
    }

    if (msg.type === 'list_models') {
      // Host-level query (no session_id): route to the target daemon by daemon_id.
      // The reply (model_list) is broadcast back to the owner's clients below.
      const daemonId = msg.daemon_id;
      if (!daemonId) return;
      const daemon = this.daemons.get(daemonId);
      if (daemon && daemon.ws.readyState === 1 && this.sameUser(daemon.userId, client.userId)) {
        this.send(daemon.ws, msg);
      }
      return;
    }

    if (msg.type === 'session_create') {
      const requestId = typeof msg.request_id === 'string' && msg.request_id
        ? msg.request_id
        : randomUUID();
      if (isAppReviewDemoDaemon(msg.daemon_id)) {
        this.send(clientWs, {
          type: 'session_create_failed',
          request_id: requestId,
          reason: 'demo_read_only',
          error: 'App Review 演示数据为只读模式',
        });
        return;
      }
      if (isObserverAgentType(msg.agent)) {
        this.send(clientWs, {
          type: 'session_create_failed',
          request_id: requestId,
          reason: OBSERVER_READ_ONLY_CODE,
          retryable: false,
          error: 'observer agents are read-only',
        });
        return;
      }
      const createAgentType = msg.agent === '' || msg.agent == null
        ? 'claude-code'
        : msg.agent;
      if (!isCreateCapableAgentType(createAgentType)) {
        this.send(clientWs, {
          type: 'session_create_failed',
          request_id: requestId,
          reason: 'unsupported_agent',
          retryable: false,
          error: 'unsupported agent',
        });
        return;
      }
      // Precise routing: prefer msg.daemon_id, validate ownership; fallback to first online same-user daemon
      let targetDaemon: { id: string; daemon: DaemonConnection } | null = null;
      if (msg.daemon_id) {
        const d = this.daemons.get(msg.daemon_id);
        if (d && d.ws.readyState === 1 && this.sameUser(client.userId, d.userId)) {
          targetDaemon = { id: msg.daemon_id, daemon: d };
        }
      }
      if (!targetDaemon) {
        for (const [dId, d] of this.daemons) {
          if (d.ws.readyState === 1 && this.sameUser(client.userId, d.userId)) {
            targetDaemon = { id: dId, daemon: d };
            break;
          }
        }
      }
      if (!targetDaemon) {
        this.send(clientWs, {
          type: 'session_create_failed', request_id: requestId,
          reason: 'daemon_offline', error: 'no daemons available',
        });
        return;
      }
      const { id: daemonId } = targetDaemon;
      const existingPending = this.findPendingSessionOperation(daemonId, requestId, client.userId);
      if (existingPending?.daemonId === daemonId && existingPending.operation === 'create') {
        return;
      }
      let reservationId: string | null = null;
      let expiresAt: number | null = null;
      let reusedReservation = false;
      if (client.userId !== null) {
        const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, client.userId);
        const entitlements = resolveEntitlements(plan, whitelist);
        const enforcement = quotaEnforcementMode();
        if (enforcement === 'observe' && entitlements.maxConcurrentSessions !== null) {
          const snapshot = await getQuotaSnapshot(this.pool, client.userId, entitlements);
          const usage = snapshot.resources.concurrent_sessions;
          if (usage.used + (usage.reserved || 0) >= entitlements.maxConcurrentSessions) {
            db.insertAuditLog(this.pool, client.userId, 'quota_would_reject', {
              resource: 'concurrent_sessions', operation: 'create', used: usage.used,
              reserved: usage.reserved || 0, limit: entitlements.maxConcurrentSessions,
              daemon_id: daemonId, request_id: requestId,
            }).catch(console.error);
          }
        }
        const decision = await reserveConcurrentSession(this.pool, {
          userId: client.userId,
          requestId,
          operation: 'create',
          daemonId,
          agentType: createAgentType,
          cwd: msg.cwd || '',
          limit: enforcement === 'enforce' ? entitlements.maxConcurrentSessions : null,
        });
        if (!decision.allowed) {
          if (decision.reason === 'quota_reservation_binding_conflict'
            || decision.reason === 'quota_request_already_finalized') {
            this.send(clientWs, {
              type: 'session_create_failed', request_id: requestId,
              reason: decision.reason, retryable: false,
              error: decision.reason === 'quota_request_already_finalized'
                ? 'request_id already reached a terminal quota outcome'
                : 'request_id is already bound to another quota operation',
            });
            return;
          }
          this.send(clientWs, {
            type: 'session_create_failed',
            request_id: requestId,
            reason: decision.reason,
            resource: 'concurrent_sessions',
            plan,
            used: decision.used,
            reserved: decision.reserved,
            limit: decision.limit,
            retryable: true,
            error: `免费版最多同时运行 ${decision.limit} 个会话`,
          });
          return;
        }
        reservationId = decision.reservationId;
        expiresAt = decision.expiresAt;
        reusedReservation = decision.reused;
      }
      this.trackPendingSessionOperation({
        requestId,
        reservationId,
        daemonId,
        userId: client.userId,
        sessionId: null,
        origin: clientWs,
        operation: 'create',
        agentType: createAgentType,
        cwd: msg.cwd || '',
      }, expiresAt);
      if (client.userId !== null) this.broadcastQuotaStatus(client.userId).catch(console.error);
      this.pendingSessionCreate.set(daemonId, clientWs);
      this.pendingSessionMeta = this.pendingSessionMeta || new Map();
      this.pendingSessionMeta.set(daemonId, { agent_type: createAgentType, cwd: msg.cwd || '' });
      if (reusedReservation) {
        // The durable row proves this exact request was already admitted, but
        // cannot prove whether the pre-crash Relay delivered the command.
        // Choose at-most-once execution: attach this client to the existing
        // outcome and never make an official daemon reject a duplicate grant.
        this.send(clientWs, {
          type: 'session_create_pending', request_id: requestId,
          reason: 'request_in_progress', retryable: true,
        });
        return;
      }
      this.send(targetDaemon.daemon.ws, {
        ...msg,
        agent: createAgentType,
        request_id: requestId,
        quota_grant: {
          reservation_id: reservationId ?? `unlimited-${requestId}`,
          expires_at: expiresAt ?? (Date.now() + 20_000),
          operation: 'create',
        },
      });
      return;
    }

    if (msg.session_id) {
      if (isAppReviewDemoSession(msg.session_id)) {
        if (msg.type === 'user_message') {
          this.send(clientWs, {
            type: 'user_message_nack', msg_id: msg.msg_id,
            reason: 'demo_read_only', error: 'App Review 演示数据为只读模式',
          });
        } else {
          this.send(clientWs, {
            type: 'error', session_id: msg.session_id,
            code: 'demo_read_only', error: 'App Review 演示数据为只读模式',
          });
        }
        return;
      }
      // Route to the owning daemon. The in-memory sessionToDaemon map is the
      // fast path, but it is volatile (cleared on relay restart, stale after a
      // daemon reconnect with a new id, never pruned on disconnect). Fall back
      // to the DB-backed daemon_id so historical sessions remain routable.
      let daemonId = sessionRuntimePolicy?.daemonId
        ?? this.sessionToDaemon.get(msg.session_id)
        ?? null;
      if (!daemonId) {
        try { daemonId = await db.getSessionDaemonId(this.pool, msg.session_id); }
        catch (e) { console.error('getSessionDaemonId:', e); }
        if (daemonId) {
          // Warm the cache so subsequent messages skip the DB round-trip.
          this.sessionToDaemon.set(msg.session_id, daemonId);
        }
      }
      if (daemonId) {
        const daemon = this.daemons.get(daemonId);
        if (daemon && daemon.ws.readyState === 1) {
          let outbound = msg;
          if (msg.type === 'user_message' && client.userId !== null) {
            const status = sessionRuntimePolicy?.status
              ?? await db.getSessionStatus(this.pool, msg.session_id);
            const isActive = ['running', 'busy', 'retry', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(status || '');
            const requestId = typeof msg.request_id === 'string' && msg.request_id
              ? msg.request_id
              : (typeof msg.msg_id === 'string' && msg.msg_id ? msg.msg_id : randomUUID());
            if (!isActive) {
              const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, client.userId);
              const entitlements = resolveEntitlements(plan, whitelist);
              const enforcement = quotaEnforcementMode();
              if (enforcement === 'observe' && entitlements.maxConcurrentSessions !== null) {
                const snapshot = await getQuotaSnapshot(this.pool, client.userId, entitlements);
                const usage = snapshot.resources.concurrent_sessions;
                if (usage.used + (usage.reserved || 0) >= entitlements.maxConcurrentSessions) {
                  db.insertAuditLog(this.pool, client.userId, 'quota_would_reject', {
                    resource: 'concurrent_sessions', operation: 'resume', used: usage.used,
                    reserved: usage.reserved || 0, limit: entitlements.maxConcurrentSessions,
                    daemon_id: daemonId, request_id: requestId, session_id: msg.session_id,
                  }).catch(console.error);
                }
              }
              const decision = await reserveConcurrentSession(this.pool, {
                userId: client.userId,
                requestId,
                operation: 'resume',
                daemonId,
                sessionId: msg.session_id,
                limit: enforcement === 'enforce' ? entitlements.maxConcurrentSessions : null,
              });
              if (!decision.allowed) {
                if (decision.reason === 'quota_reservation_binding_conflict'
                  || decision.reason === 'quota_request_already_finalized') {
                  this.send(clientWs, {
                    type: 'user_message_nack', msg_id: msg.msg_id, request_id: requestId,
                    reason: decision.reason, retryable: false,
                  });
                  return;
                }
                this.send(clientWs, {
                  type: 'user_message_nack',
                  msg_id: msg.msg_id,
                  request_id: requestId,
                  reason: decision.reason,
                  resource: 'concurrent_sessions',
                  plan,
                  used: decision.used,
                  reserved: decision.reserved,
                  limit: decision.limit,
                  retryable: true,
                });
                return;
              }
              this.trackPendingSessionOperation({
                requestId,
                reservationId: decision.reservationId,
                daemonId,
                userId: client.userId,
                sessionId: msg.session_id,
                origin: clientWs,
                operation: 'resume',
                agentType: '',
                cwd: '',
              }, decision.expiresAt);
              this.broadcastQuotaStatus(client.userId).catch(console.error);
              if (decision.reused) {
                this.send(clientWs, {
                  type: 'user_message_nack', msg_id: msg.msg_id, request_id: requestId,
                  reason: 'request_in_progress', retryable: false,
                });
                return;
              }
              outbound = {
                ...msg,
                request_id: requestId,
                quota_grant: {
                  reservation_id: decision.reservationId ?? `unlimited-${requestId}`,
                  expires_at: decision.expiresAt ?? (Date.now() + 20_000),
                  operation: 'resume',
                },
              };
            } else {
              outbound = {
                ...msg,
                request_id: requestId,
                quota_grant: {
                  reservation_id: `active-session-${requestId}`,
                  expires_at: Date.now() + 20_000,
                  operation: 'resume',
                },
              };
            }
          }
          if (['approval_response', 'question_response', 'question_reject'].includes(msg.type) && typeof msg.request_id === 'string') {
            this.trackInteractionClient(msg.session_id, msg.request_id, msg.type, clientWs);
          }
          this.send(daemon.ws, outbound);
          // L2 (web-post-send-feedback): ack so the web client clears its ack-timeout.
          if (msg.type === 'user_message' && msg.msg_id) {
            this.send(clientWs, { type: 'user_message_ack', msg_id: msg.msg_id });
          }
          return;
        }
        // daemon_id 已知但 daemon WS 不在线 → daemon 不可达(可重试/等待重连)。
        // user_message 走 nack 让 web 回滚乐观 UI;其它命令回带 code 的 error。
        if (msg.type === 'user_message' && msg.msg_id) {
          this.send(clientWs, { type: 'user_message_nack', msg_id: msg.msg_id, reason: 'daemon_offline' });
        } else {
          this.send(clientWs, {
            type: 'error', session_id: msg.session_id,
            code: 'daemon_unreachable',
            error: 'daemon offline or reconnecting',
          });
        }
        return;
      }
      // daemon_id 查不到 → 会话不存在(历史已清/ID 错误),无需重试。
      if (msg.type === 'user_message' && msg.msg_id) {
        this.send(clientWs, { type: 'user_message_nack', msg_id: msg.msg_id, reason: 'session_not_found' });
      } else {
        this.send(clientWs, {
          type: 'error', session_id: msg.session_id,
          code: 'session_not_found',
          error: 'session not found',
        });
      }
      return;
    }
    this.send(clientWs, { type: 'error', error: 'session not found or daemon offline' });
  }

  /**
   * Submit a normalized Attention Inbox response through the same live daemon
   * connection used by existing WebSocket clients. This deliberately does not
   * register a synthetic client or track an interaction origin: final state is
   * still driven by the daemon's durable resolution event.
   */
  async submitAttentionInboxInteraction(
    userId: number,
    command: AttentionInteractionCommand,
  ): Promise<AttentionInteractionRouteResult> {
    try {
      return await db.withSessionMaterializationFence(
        this.controlPool,
        command.session_id,
        async (lockedClient): Promise<AttentionInteractionRouteResult> => {
          const policy = await db.getSessionRuntimePolicy(
            lockedClient as unknown as pg.Pool,
            command.session_id,
            userId,
          ).catch(() => null);
          if (!policy) return { accepted: false, code: 'session_not_found' };
          if (isObserverAgentType(policy.agentType)) {
            return { accepted: false, code: OBSERVER_READ_ONLY_CODE };
          }
          if (!['approval_response', 'question_response', 'question_reject'].includes(command.type)) {
            return { accepted: false, code: 'interaction_unsupported' };
          }

          const daemonId = policy.daemonId;
          if (daemonId) this.sessionToDaemon.set(command.session_id, daemonId);
          if (!daemonId) return { accepted: false, code: 'daemon_unreachable' };

          const daemon = this.daemons.get(daemonId);
          if (!daemon || daemon.ws.readyState !== 1 || daemon.userId !== userId) {
            return { accepted: false, code: 'daemon_unreachable' };
          }

          // Rebuild the outbound object so API-only or caller-controlled fields can
          // never leak into the daemon protocol.
          if (command.type === 'approval_response') {
            this.send(daemon.ws, {
              type: command.type,
              session_id: command.session_id,
              request_id: command.request_id,
              action: command.action,
            });
          } else if (command.type === 'question_response') {
            this.send(daemon.ws, {
              type: command.type,
              session_id: command.session_id,
              request_id: command.request_id,
              answers: command.answers,
            });
          } else {
            this.send(daemon.ws, {
              type: command.type,
              session_id: command.session_id,
              request_id: command.request_id,
            });
          }
          return { accepted: true };
        },
      );
    } catch {
      return { accepted: false, code: 'daemon_unreachable' };
    }
  }

  private async handleReplay(clientWs: WebSocket, sessionId: string, lastSeq: number, reqId?: number, direction?: string, limit?: number): Promise<void> {
    const startedAt = Date.now();
    const withReq = (obj: any) => reqId !== undefined ? { ...obj, req_id: reqId } : obj;
    // Explicit forward/backward requests are paginated by complete logical
    // streams. Direction-less forward replay remains the legacy unbounded path.
    const isBackward = direction === 'backward';
    const isPagedForward = direction === 'forward' && limit !== undefined && limit > 0;
    const lim = (isBackward || isPagedForward) && limit && limit > 0 ? limit : 100;
    try {
      const runtime = await db.getSessionRuntime(this.pool, sessionId);
      const currentStatus = runtime.status;
      let events: any[];
      let logicalCount = 0;
      let replayLastSeq = lastSeq;
      let replayNewestSeq = lastSeq ?? 0;
      let hasMore = false;
      if (isBackward) {
        const page = await db.getCompleteBackwardReplayPage(
          this.pool,
          sessionId,
          lastSeq && lastSeq > 0 ? lastSeq : undefined,
          lim,
        );
        events = page.events;
        logicalCount = page.logicalCount;
        replayLastSeq = page.oldestId;
        replayNewestSeq = page.events.length > 0 ? page.events[page.events.length - 1].id : (lastSeq ?? 0);
        hasMore = page.hasMore;
        if (!lastSeq || lastSeq <= 0) {
          const latestPlan = await db.getLatestAgentPlan(this.pool, sessionId);
          if (latestPlan && !events.some(event => event.id === latestPlan.id)) {
            events = [...events, latestPlan].sort((left, right) => left.id - right.id);
          }
        }
      } else if (isPagedForward) {
        const page = await db.getCompleteForwardReplayPage(
          this.pool,
          sessionId,
          lastSeq ?? 0,
          lim,
        );
        events = page.events;
        logicalCount = page.logicalCount;
        replayLastSeq = page.newestId;
        replayNewestSeq = page.newestId;
        hasMore = page.hasMore;
      } else {
        events = await db.getEventsAfter(this.pool, sessionId, lastSeq ?? 0);
        replayNewestSeq = events.length > 0 ? events[events.length - 1].id : (lastSeq ?? 0);
      }
      if (events.length === 0) {
        this.observeInitialReplayPage({
          sessionId, isInitialPage: isBackward && (!lastSeq || lastSeq <= 0),
          eventCount: 0, logicalCount: 0, batchCount: 0, payloadBytes: 0,
          durationMs: Date.now() - startedAt, hasMore,
        });
        this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, count: 0, logical_count: 0, last_seq: replayLastSeq, newest_seq: replayNewestSeq, has_more: hasMore, status: currentStatus, turn_started_at: runtime.turnStartedAt, last_activity_at: runtime.lastActivityAt }));
        return;
      }
      replayNewestSeq = events.reduce((newest, event) => Math.max(newest, event.id), replayNewestSeq);
      // Both forward and complete backward pages are ASC, including across
      // replay batches, so stream assemblers always receive chunk zero first.
      const batches = this.buildReplayBatches(events, (slice) => withReq({
          type: 'replay_batch',
          session_id: sessionId,
          events: slice.map(e => e.payload),
          last_seq: isBackward ? slice[0].id : slice[slice.length - 1].id,
          direction: direction || 'forward',
      }));
      const payloadBytes = batches.reduce(
        (total, batch) => total + Buffer.byteLength(JSON.stringify(batch), 'utf8'),
        0,
      );
      this.observeInitialReplayPage({
        sessionId, isInitialPage: isBackward && (!lastSeq || lastSeq <= 0),
        eventCount: events.length, logicalCount, batchCount: batches.length,
        payloadBytes, durationMs: Date.now() - startedAt, hasMore,
      });
      for (const batch of batches) {
        this.send(clientWs, batch);
      }
      this.send(clientWs, withReq({
        type: 'replay_end',
        session_id: sessionId,
        count: events.length,
        logical_count: logicalCount,
        last_seq: isBackward ? replayLastSeq : events[events.length - 1].id,
        newest_seq: replayNewestSeq,
        has_more: hasMore,
        status: currentStatus,
        turn_started_at: runtime.turnStartedAt,
        last_activity_at: runtime.lastActivityAt,
      }));
    } catch (err) {
      console.error('replay error:', err);
      // Always send replay_end so the client doesn't hang on isLoading
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq, has_more: false }));
    }
  }

  private observeInitialReplayPage(metrics: {
    sessionId: string;
    isInitialPage: boolean;
    eventCount: number;
    logicalCount: number;
    batchCount: number;
    payloadBytes: number;
    durationMs: number;
    hasMore: boolean;
  }): void {
    if (!metrics.isInitialPage) return;
    if (metrics.payloadBytes < INITIAL_REPLAY_PAYLOAD_WARNING_BYTES
      && metrics.durationMs < INITIAL_REPLAY_DURATION_WARNING_MS) return;
    const { isInitialPage: _isInitialPage, ...observed } = metrics;
    console.warn('[history-replay] initial page threshold exceeded', observed);
  }

  private async handleReplaySubagent(clientWs: WebSocket, sessionId: string, agentId: string, lastSeq?: number, reqId?: number, limit?: number, direction?: string): Promise<void> {
    const withReq = (obj: any) => reqId !== undefined ? { ...obj, req_id: reqId } : obj;
    const lim = limit && limit > 0 ? limit : 100;
    const isPagedForward = direction === 'forward' && limit !== undefined && limit > 0;
    if (!agentId) {
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, agent_id: agentId, count: 0, logical_count: 0, last_seq: lastSeq ?? 0, newest_seq: lastSeq ?? 0, has_more: false }));
      return;
    }
    try {
      const page = isPagedForward
        ? await db.getCompleteForwardReplayPage(this.pool, sessionId, lastSeq ?? 0, lim, agentId)
        : await db.getCompleteBackwardReplayPage(
            this.pool,
            sessionId,
            lastSeq && lastSeq > 0 ? lastSeq : undefined,
            lim,
            agentId,
          );
      const events = page.events;
      const pageOldestId = page.oldestId;
      const pageNewestId = 'newestId' in page
        ? page.newestId
        : (events.length > 0 ? events[events.length - 1].id : (lastSeq ?? 0));
      if (events.length === 0) {
        this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, agent_id: agentId, count: 0, logical_count: 0, last_seq: isPagedForward ? pageNewestId : pageOldestId, newest_seq: pageNewestId, has_more: page.hasMore }));
        return;
      }
      const batches = this.buildReplayBatches(events, (slice) => withReq({
          type: 'replay_batch',
          session_id: sessionId,
          agent_id: agentId,
          events: slice.map(e => e.payload),
          last_seq: isPagedForward ? slice[slice.length - 1].id : slice[0].id,
          direction: isPagedForward ? 'forward' : 'backward',
      }));
      for (const batch of batches) {
        this.send(clientWs, batch);
      }
      this.send(clientWs, withReq({
        type: 'replay_end',
        session_id: sessionId,
        agent_id: agentId,
        count: events.length,
        logical_count: page.logicalCount,
        last_seq: isPagedForward ? pageNewestId : pageOldestId,
        newest_seq: pageNewestId,
        has_more: page.hasMore,
      }));
    } catch (err) {
      console.error('replay_subagent error:', err);
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, agent_id: agentId, count: 0, last_seq: lastSeq ?? 0, has_more: false }));
    }
  }

  private buildReplayBatches<T>(events: T[], envelope: (batch: T[]) => any): any[] {
    const result: any[] = [];
    let pending: T[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      result.push(envelope(pending));
      pending = [];
    };

    for (const event of events) {
      if (pending.length >= this.replayBatchMaxEvents) flush();
      const candidate = [...pending, event];
      const bytes = Buffer.byteLength(JSON.stringify(envelope(candidate)), 'utf8');
      if (pending.length > 0 && bytes > this.replayBatchMaxBytes) flush();
      pending.push(event);
    }
    flush();
    return result;
  }

  private async handleListSessions(clientWs: WebSocket, userId: number | null, msg: any = {}): Promise<void> {
    try {
      // H-3: a null user (legacy identity) must never enumerate sessions.
      // Fail closed for both the global and per-daemon listings.
      if (userId == null) {
        this.send(clientWs, { type: 'error', error: 'authentication required' });
        return;
      }
      if (typeof msg.daemon_id === 'string' && msg.daemon_id.length > 0) {
        const page = await db.listSessionsPageByDaemon(this.pool, {
          userId: userId ?? undefined,
          daemonId: msg.daemon_id,
          limit: Number.isFinite(Number(msg.limit)) ? Number(msg.limit) : 30,
          cursor: typeof msg.cursor === 'string' ? msg.cursor : null,
        });
        this.send(clientWs, {
          type: 'session_list',
          sessions: page.sessions,
          daemon_id: msg.daemon_id,
          has_more: page.hasMore,
          next_cursor: page.nextCursor,
        });
        return;
      }
      const sessions = await db.listSessionsByUser(this.pool, userId);
      this.send(clientWs, { type: 'session_list', sessions });
    } catch (err) { console.error('list_sessions error:', err); this.send(clientWs, { type: 'error', error: 'failed to list sessions' }); }
  }

  /** Check if two user IDs match (both null = legacy, same ID = same user) */
  private async handleListDaemons(clientWs: WebSocket, userId: number | null): Promise<void> {
    try {
      const daemonList: any[] = [];
      const seenIds = new Set<string>();

      // 在线主机:遍历内存 map,逐个用 buildDaemonForUser 组装(保证与单主机
      // HTTP 接口返回字段完全一致)。userId 为 null(未认证)时跳过。
      if (userId) {
        for (const [daemonId, daemon] of this.daemons) {
          if (!this.sameUser(daemon.userId, userId)) continue;
          const entry = await this.buildDaemonForUser(daemonId, userId);
          if (entry) { daemonList.push(entry); seenIds.add(daemonId); }
        }

        // 离线主机:补 DB 里该用户名下、不在内存 map 中的 daemon。
        // 启动宽限期内乐观置 online,避免 relay 刚重启时列表闪烁/清空。
        try {
          const result = await this.pool.query(
            `SELECT daemon_id FROM daemons WHERE user_id = $1`,
            [userId]
          )
          for (const row of result.rows) {
            if (seenIds.has(row.daemon_id)) continue
            const entry = await this.buildDaemonForUser(row.daemon_id, userId)
            if (entry) daemonList.push(entry)
          }
        } catch (e) { console.error('list_daemons db:', e) }
      }

      console.log('[router] list_daemons sending', daemonList.length, 'daemons to user', userId);
    this.send(clientWs, { type: 'daemon_list', daemons: daemonList });
    } catch (err) { console.error('list_daemons error:', err); }
  }

  /**
   * 组装单个 daemon 的快照对象,供 WS 的 list_daemons 与 HTTP 单主机查询共用。
   * 在线(内存 map 里有)→ 带完整字段含 cpu/mem/disk 指标;
   * 离线(仅 DB 里有)→ 字段较少。
   * optimistic=true(默认,WS 全量列表用):relay 启动宽限期内乐观置 online,
   *   防止 relay 刚重启时整页列表闪烁/清空;
   * optimistic=false(HTTP 单主机刷新用):如实返回 DB 记录的真实 status——
   *   能走到离线分支说明内存 map 里没有活跃连接,该主机此刻就是离线的,
   *   单卡刷新的核心诉求是看真实状态,乐观值反而会误导。
   * 返回 null 表示该 daemon 不存在或不属于该用户(调用方据此回 404)。
   */
  async buildDaemonForUser(daemonId: string, userId: number, optimistic = true): Promise<any | null> {
    // 1) 在线:走内存 map,字段最全
    const conn = this.daemons.get(daemonId);
    if (conn && this.sameUser(conn.userId, userId)) {
      const alias = await db.getDaemonAlias(this.pool, daemonId);
      const metrics = this.daemonMetrics.get(daemonId);
      const countsRow = await this.pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('running','busy','retry'))::int AS active
         FROM sessions
         WHERE user_id = $1 AND daemon_id = $2 AND session_id NOT LIKE 'pending-%'`,
        [userId, daemonId]
      );
      const counts = countsRow.rows[0];
      return {
        daemon_id: conn.daemonId,
        hostname: conn.hostname,
        agents: conn.agents,
        daemon_online: true,
        daemon_alias: alias,
        status: 'online',
        os: conn.os || 'unknown',
        ip: conn.ip || 'unknown',
        port: conn.port || '',
        arch: conn.arch || '',
        version: conn.version || '',
        started_at: conn.startedAt || 0,
        last_heartbeat: Date.now(),
        cpu_pct: metrics?.cpuPct ?? null,
        mem_pct: metrics?.memPct ?? null,
        disk_pct: metrics?.diskPct ?? null,
        active_sessions: counts?.active ?? 0,
        total_sessions: counts?.total ?? 0,
      };
    }

    // 2) 离线:查 DB,校验归属,启动宽限期内乐观 online
    try {
      const result = await this.pool.query(
        `SELECT daemon_id, hostname, agents, alias, status, last_heartbeat, user_id
         FROM daemons WHERE daemon_id = $1`,
        [daemonId]
      );
      const row = result.rows[0];
      if (!row || row.user_id !== userId) return null;

      const countsRow = await this.pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('running','busy','retry'))::int AS active
         FROM sessions
         WHERE user_id = $1 AND daemon_id = $2 AND session_id NOT LIKE 'pending-%'`,
        [userId, daemonId]
      );
      const counts = countsRow.rows[0];
      // 乐观:仅 WS 全量列表在启动宽限期内用,防列表闪烁;
      // 单主机刷新如实返回真实 status(走到这里 = 内存无活跃连接 = 已离线)。
      const inStartupWindow = (Date.now() - this.startedAt) < this.listGraceMs;
      const optimisticOnline = optimistic && inStartupWindow;
      // 非乐观模式下以 DB 记录的 status 为准;乐观模式下被乐观值覆盖。
      const dbOnline = row.status === 'online';
      const demoOnline = isAppReviewDemoDaemon(row.daemon_id);
      const isOnline = demoOnline || optimisticOnline || (!optimistic && dbOnline);
      return {
        daemon_id: row.daemon_id,
        hostname: row.hostname,
        agents: row.agents || [],
        daemon_online: isOnline,
        daemon_alias: row.alias,
        status: isOnline ? 'online' : 'offline',
        last_seen_at: row.last_heartbeat,
        active_sessions: counts?.active ?? 0,
        total_sessions: counts?.total ?? 0,
      };
    } catch (e) {
      console.error('buildDaemonForUser db:', e);
      return null;
    }
  }

  /** Force-kick a daemon from the Web settings page. */
  // C4c: forward agent upgrade request to daemon. Result pushed back via upgrade_result event.
  async handleUpgrade(daemonId: string, userId: number, agent: string): Promise<{ success: boolean; error?: string }> {
    const daemon = this.daemons.get(daemonId);
    if (!daemon || daemon.userId !== userId) {
      return { success: false, error: 'forbidden' };
    }
    if (daemon.ws.readyState !== 1) {
      return { success: false, error: 'daemon offline' };
    }
    this.send(daemon.ws, { type: 'upgrade_agent', agent: agent || 'claude-code' });
    return { success: true };
  }

  async handleForceKick(daemonId: string, userId: number): Promise<{ success: boolean; error?: string }> {
    return this.withDaemonRegistrationLock(daemonId, () => this.handleForceKickLocked(daemonId, userId));
  }

  private async handleForceKickLocked(daemonId: string, userId: number): Promise<{ success: boolean; error?: string }> {
    const daemon = this.daemons.get(daemonId);
    if (!daemon) {
      return { success: false, error: 'daemon not found or offline' };
    }
    if (daemon.userId !== userId) {
      return { success: false, error: 'forbidden' };
    }

    // Revoke the token captured with this exact in-memory generation. Reading
    // daemons.active_token_jti after an await could revoke a replacement token.
    let revoked = !daemon.tokenJti;
    if (daemon.tokenJti) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await db.revokeToken(this.controlPool, daemon.tokenJti, userId, 'force_kick');
          revoked = true;
          break;
        } catch (e) {
          console.error('force_kick revoke:', e);
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    }
    if (!revoked) {
      // Keep the existing generation online and usable: claiming success after
      // a failed revoke would let the still-valid token reconnect immediately.
      return { success: false, error: 'token revocation failed' };
    }

    // Audit is observability, not the security commit. Never keep the daemon
    // alive or hold the registration chain while waiting for audit storage.
    void db.insertAuditLog(this.pool, userId, 'force_kick', {
      daemon_id: daemonId,
      hostname: daemon.hostname,
      registration_id: daemon.registrationId,
    }).catch((e) => console.error('force_kick audit:', e));

    // Cancel any pending takeover timer only after the revoke security commit.
    const takeover = this.takeoverTimers.get(daemonId);
    if (takeover) {
      clearTimeout(takeover.timer);
      this.takeoverTimers.delete(daemonId);
    }

    if (daemon.ws.readyState === 1) {
      this.send(daemon.ws, {
        type: 'kicked',
        reason: 'force_kick',
        message: '管理员已强制下线此设备',
        grace_period_seconds: 0,
      });
      daemon.ws.close();
    }

    // Unregister only the generation captured before the awaits. Registration
    // shares this lock, but identity guards also protect cross-relay successors.
    const current = this.daemons.get(daemonId);
    if (current?.ws === daemon.ws && current.registrationId === daemon.registrationId) {
      this.cancelDaemonRevocationGate(daemon.registrationId);
      this.daemons.delete(daemonId);
      this.daemonSeq.delete(daemonId);
      this.daemonMetrics.delete(daemonId);
    }
    const offlineTimer = this.pendingOfflineTimers.get(daemonId);
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      this.pendingOfflineTimers.delete(daemonId);
    }
    // Cleanup is not part of the revoke/close security commit. Keep it outside
    // the registration chain; bounded attempts and the generation CAS make a
    // late completion harmless to a replacement.
    void this.setDaemonOfflineWithRetry(daemonId, daemon.registrationId)
      .catch((e) => console.error('force_kick offline cleanup:', e));

    return { success: true };
  }

  async handleDeleteDaemon(daemonId: string, userId: number): Promise<{ success: boolean; error?: string }> {
    const daemon = this.daemons.get(daemonId);
    if (daemon && daemon.userId !== userId) {
      return { success: false, error: 'forbidden' };
    }

    if (daemon) this.cancelDaemonRevocationGate(daemon.registrationId);

    if (daemon?.ws.readyState === 1) {
      this.send(daemon.ws, {
        type: 'kicked',
        reason: 'host_unbound',
        message: '该主机已从账号中删除，请重新登录后再连接',
        grace_period_seconds: 0,
      });
      daemon.ws.close();
    }

    const takeover = this.takeoverTimers.get(daemonId);
    if (takeover) {
      clearTimeout(takeover.timer);
      this.takeoverTimers.delete(daemonId);
    }
    const offlineTimer = this.pendingOfflineTimers.get(daemonId);
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      this.pendingOfflineTimers.delete(daemonId);
    }

    try {
      await db.revokeDaemonToken(this.controlPool, daemonId, userId, 'user_revoke');
      const deleted = await db.deleteDaemon(this.controlPool, userId, daemonId);
      if (!deleted) return { success: false, error: 'daemon not found or not owned' };
    } catch (e) {
      console.error('delete daemon:', e);
      return { success: false, error: 'failed to delete daemon' };
    }

    this.daemons.delete(daemonId);
    this.daemonMetrics.delete(daemonId);
    this.knownOffline.delete(daemonId);
    this.broadcastQuotaStatus(userId).catch(console.error);
    return { success: true };
  }

  /** Broadcast a message to all clients of the given user. */
  broadcastToUser(userId: number, data: any): void {
    for (const [ws, c] of this.clients) {
      if (ws.readyState === 1 && this.sameUser(c.userId, userId)) {
        this.send(ws, data);
      }
    }
  }

  private sameUser(a: number | null, b: number | null): boolean {
    if (a === null && b === null) return true;  // both legacy
    return a === b;
  }

  private send(ws: WebSocket, data: any): void {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(data));
  }
}
