import type { WebSocket } from 'ws';
import type pg from 'pg';
import { randomUUID } from 'crypto';
import { isAppReviewDemoDaemon, isAppReviewDemoSession } from './config/app-review-demo.js';
import * as db from './db.js';
import { generateTitle, generateSubagentTitle } from './title.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush, daemonOnlinePush, approvalPush, interactivePush, questionPush, summarizeToolInput, highRiskPush, isHighRiskCommand } from './push.js';
import { PushDeduper } from './push-deduper.js';
import { quotaEnforcementMode, resolveEntitlements } from './entitlements.js';
import { claimBoundDaemonSlot, getQuotaSnapshot, releaseQuotaReservation, reserveConcurrentSession } from './quota.js';

interface DaemonConnection { ws: WebSocket; daemonId: string; hostname: string; agents: any[]; userId: number | null; os?: string; ip?: string; port?: string; arch?: string; version?: string; startedAt?: number }
interface ClientConnection { ws: WebSocket; subscribedSessions: Set<string>; userId: number | null; locale: string }
interface DaemonMetrics { cpuPct: number; memPct: number; diskPct: number; updatedAt: number }
interface PendingSessionOperation {
  requestId: string;
  reservationId: string | null;
  daemonId: string;
  origin: WebSocket;
  operation: 'create' | 'resume';
  agentType: string;
  cwd: string;
  timeout?: ReturnType<typeof setTimeout>;
}

export class Router {
  private daemons = new Map<string, DaemonConnection>();
  private daemonMetrics = new Map<string, DaemonMetrics>();
  private clients = new Map<WebSocket, ClientConnection>();
  private sessionToDaemon = new Map<string, string>();
  private pendingSessionCreate = new Map<string, WebSocket>();
  private pendingSessionMeta = new Map<string, { agent_type: string; cwd: string }>();
  private pendingSessionOperations = new Map<string, PendingSessionOperation>();
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
  // persisted seqs above the mark, drained contiguously by markPersisted.
  // `startedAt` detects a daemon process restart (seq resets): when it changes we
  // reset the cursor. The DB row dedup is handled separately by the
  // events.event_hash unique index.
  private daemonSeq = new Map<string, { startedAt: number; persistedHigh: number; pending: Set<number>; baselineSet: boolean }>();
  private pool: pg.Pool;

  // Grace window before a disconnected daemon is declared offline.
  private readonly offlineGraceMs = parseInt(process.env.DAEMON_OFFLINE_GRACE_MS || '30000', 10);

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

  // Daemon ids that finalized a genuine offline (grace window elapsed). Used
  // to push "online" only on a real offline→online transition, not on every
  // WS reconnect (network flap / relay restart). In-memory, so a relay restart
  // naturally suppresses the first online push — desirable.
  private knownOffline = new Set<string>();

  constructor(pool: pg.Pool) {
    this.pool = pool;
    this.pushDeduper.startSweeping();
  }

  private findPendingSessionOperation(daemonId: string, requestId?: string): PendingSessionOperation | undefined {
    if (requestId) {
      const exact = this.pendingSessionOperations.get(requestId);
      if (exact?.daemonId === daemonId) return exact;
    }
    return [...this.pendingSessionOperations.values()].find((pending) => pending.daemonId === daemonId);
  }

  private settlePendingSessionOperation(pending: PendingSessionOperation | undefined): void {
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingSessionOperations.delete(pending.requestId);
    if (pending.reservationId) {
      releaseQuotaReservation(this.pool, pending.reservationId)
        .then(() => {
          const daemon = this.daemons.get(pending.daemonId);
          if (daemon?.userId) this.broadcastQuotaStatus(daemon.userId).catch(console.error);
        })
        .catch((e) => console.error('release quota reservation:', e));
    }
  }

  private trackPendingSessionOperation(pending: PendingSessionOperation, expiresAt: number | null): void {
    if (expiresAt) {
      const timeout = setTimeout(() => {
        const current = this.pendingSessionOperations.get(pending.requestId);
        if (current !== pending) return;
        if (pending.origin.readyState === 1) {
          if (pending.operation === 'create') {
            this.send(pending.origin, { type: 'session_create_failed', request_id: pending.requestId, reason: 'timeout', error: 'session start quota reservation expired' });
          } else {
            this.send(pending.origin, { type: 'user_message_nack', request_id: pending.requestId, reason: 'timeout' });
          }
        }
        this.settlePendingSessionOperation(pending);
      }, Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now())));
      timeout.unref?.();
      pending.timeout = timeout;
    }
    this.pendingSessionOperations.set(pending.requestId, pending);
  }

  async broadcastQuotaStatus(userId: number): Promise<void> {
    const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
    const quota = await getQuotaSnapshot(this.pool, userId, resolveEntitlements(plan, whitelist));
    this.broadcastToUser(userId, { type: 'quota_status', plan, ...quota });
  }

  /** Mark the relay as shutting down so offline pushes are suppressed. */
  beginShutdown(): void { this.shuttingDown = true; }

  /** Release background resources (push dedup sweeper). Call on shutdown. */
  stop(): void { this.pushDeduper.stop(); }

  /**
   * Push only to Pro/whitelisted users. Reads plan and skips free users.
   * Used for Pro-gated pushes (daemon online, high-risk warning, reports).
   * Regular approval/session-status pushes bypass this (free users get those).
   */
  private async maybePushToPro(userId: number, payload: import('./push.js').PushPayload): Promise<void> {
    try {
      const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
      if (!whitelist && plan === 'free') return;
      await notifyUser(this.pool, userId, payload);
    } catch (e) {
      console.error('maybePushToPro:', e);
    }
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

  async registerDaemon(ws: WebSocket, msg: any, userId: number | null, tokenJti?: string, machineId?: string): Promise<void> {
    const daemonId = msg.daemon_id;
    const hostname = msg.hostname || 'unknown';

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

    // Count every persisted binding, including offline hosts. Claiming the row
    // and checking the limit share a user-scoped transaction, closing the race
    // where two machines try to take the final slot simultaneously.
    let daemonClaimedForUser = false;
    if (userId) {
      try {
        const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
        const entitlements = resolveEntitlements(plan, whitelist);
        const enforcement = quotaEnforcementMode();
        if (enforcement === 'enforce' && msg.supports_quota_grant !== true) {
          this.send(ws, {
            type: 'register_rejected', reason: 'upgrade_required', retryable: false,
            message: '当前 daemon 版本不支持会话额度协议，请升级 pocketctl 后重试',
          });
          ws.close(4009, 'upgrade_required');
          return;
        }
        const decision = await claimBoundDaemonSlot(this.pool, {
          userId, daemonId, hostname, agents,
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
              : '该主机已绑定其他账号',
          });
          ws.close(4008, decision.reason);
          return;
        }
        if (enforcement === 'observe' && entitlements.maxBoundDaemons !== null && !decision.reconnect && decision.used > entitlements.maxBoundDaemons) {
          db.insertAuditLog(this.pool, userId, 'quota_would_reject', {
            resource: 'bound_hosts', operation: 'register', used: decision.used - 1,
            limit: entitlements.maxBoundDaemons, daemon_id: daemonId,
          }).catch(console.error);
        }
        daemonClaimedForUser = true;
      } catch (e) {
        console.error('daemon quota check:', e);
        this.send(ws, { type: 'register_rejected', reason: 'quota_check_failed', retryable: true, message: '主机额度检查失败' });
        ws.close(4011, 'quota check failed');
        return;
      }
    }

    // Fallback: if the connecting token didn't carry a userId (e.g. a legacy or
    // anonymous reconnection), recover the daemon's persisted owner from
    // daemons.user_id. Without this, sessions created during this connection
    // land with user_id NULL and vanish from the owner's web list (filtered by
    // listSessionsByUser). Anonymous legacy reconnects do not create bindings.
    if (!userId) {
      try { userId = await db.getDaemonOwner(this.pool, daemonId); } catch (e) { /* leave null */ }
    }

    this.daemons.set(daemonId, { ws, daemonId, hostname, agents, userId, os: daemonOS, ip: daemonIP, port: daemonPort, arch: daemonArch, version: daemonVersion, startedAt: daemonStartedAt });
    console.log('[ws] daemon registered', daemonId, 'agents:', JSON.stringify(agents), 'userId:', userId);
    if (!daemonClaimedForUser) {
      try { await db.upsertDaemon(this.pool, daemonId, hostname, agents, daemonArch, daemonVersion, daemonStartedAt); } catch (e) { console.error('upsertDaemon:', e); }
    }
    if (userId) {
      if (tokenJti) {
        db.bindTokenToDaemon(this.pool, daemonId, tokenJti, machineId).catch(console.error);
      }
    }
    db.cleanStaleSessions(this.pool).catch(console.error);

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
      this.daemonSeq.set(daemonId, { startedAt: daemonStartedAt, persistedHigh: baseline, pending: new Set(), baselineSet: baseline > 0 });
    }

    // Advertise at-least-once delivery support so the daemon retains an unacked
    // buffer and trims it on our event_ack (rather than legacy trim-on-write).
    this.send(ws, { type: 'register_ack', status: 'ok', connection_id: daemonId, supports_event_ack: true });
    if (userId) this.broadcastQuotaStatus(userId).catch(console.error);

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
      db.reconcileDaemonSessions(this.pool, daemonId, msg.active_session_ids)
        .then((closed) => {
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

    // Broadcast daemon online to clients with same userId
    const alias = await db.getDaemonAlias(this.pool, daemonId);
    for (const [clientWs, client] of this.clients) {
      if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
        this.send(clientWs, { type: 'daemon_status', daemon_id: daemonId, status: 'online', hostname, agents, alias, os: daemonOS, ip: daemonIP });
      }
    }

    // Push "online" only on a genuine offline→online transition. A flap
    // reconnect inside the grace window never ran finalize, so knownOffline
    // has no entry → no push. A relay restart loses this set, so the first
    // reconnect after restart also doesn't push (desirable — daemons aren't
    // "back", they just reconnected to the new process). Pro-only.
    const wasOffline = this.knownOffline.delete(daemonId);
    if (wasOffline && userId && !this.shuttingDown) {
      this.maybePushToPro(userId, daemonOnlinePush(hostname, daemonId)).catch(console.error);
    }
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
      this.settlePendingSessionOperation(pending);
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
      this.finalizeDaemonOffline(daemonId, daemon);
    }, this.offlineGraceMs);
    this.pendingOfflineTimers.set(daemonId, timer);
  }

  /**
   * Finalize the offline transition for a daemon whose grace window elapsed
   * without a reconnect: remove it from the map, persist offline, push (unless
   * shutting down), broadcast offline, and drop/notify its routed sessions.
   */
  private finalizeDaemonOffline(daemonId: string, daemon: DaemonConnection): void {
    const hostname = daemon.hostname || 'unknown';
    const userId = daemon.userId ?? null;
    this.daemons.delete(daemonId);
    this.daemonSeq.delete(daemonId);

    db.setDaemonOffline(this.pool, daemonId).catch(console.error);

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
      this.sessionToDaemon.delete(sessionId);
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) {
          this.send(clientWs, { type: 'session_status', session_id: sessionId, status: 'disconnected', daemon_id: daemonId });
        }
      }
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

    this.finalizeDaemonOffline(daemonId, daemon);
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
   * `pending` until the gap before them fills. A missing seq (control message
   * with no seq) is a no-op.
   */
  private markPersisted(daemonId: string, seq?: number): void {
    if (!seq) return;
    const st = this.daemonSeq.get(daemonId);
    if (!st || seq <= st.persistedHigh) return;
    st.pending.add(seq);
    while (st.pending.delete(st.persistedHigh + 1)) st.persistedHigh++;
  }

  /**
   * Persist a daemon event and advance the ack water-mark ONLY on durable
   * success. If persistEvent exhausts its retries it rejects — we then withhold
   * the ack so the daemon keeps the event buffered and replays it on reconnect
   * (where it is re-persisted), rather than acking-then-losing it.
   */
  private persistAndAck(daemonId: string, seq: number | undefined, sessionId: string, type: string, payload: any): void {
    db.persistEvent(this.pool, sessionId, type, payload)
      .then(() => this.markPersisted(daemonId, seq))
      .catch((e) => console.error('persistAndAck:', e));
  }

  handleDaemonMessage(daemonId: string, msg: any): void {
    // At-least-once dedup keyed on the *persisted* water-mark: a seq at or below
    // it has already been durably stored, so a reconnect replay of it is a
    // duplicate — drop it. A seq above the mark (received before but its persist
    // failed, or genuinely new) is (re)processed; the events.event_hash unique
    // index independently prevents duplicate DB rows. The mark advances only via
    // markPersisted (after the DB write), never synchronously on receipt.
    if (msg.seq) {
      const st = this.daemonSeq.get(daemonId);
      if (st) {
        if (msg.seq <= st.persistedHigh) return;
        // Establish the contiguity floor from the FIRST seq seen on a fresh entry
        // (set synchronously, in receive order, so it's the lowest). This covers
        // legacy daemons that don't report acked_seq and any daemon that replays
        // only its unacked tail (seq > 1) — without it the mark would stall on the
        // phantom gap below that tail. Guarded by baselineSet so a burst arriving
        // before the first persist can't mis-floor past an unpersisted seq.
        if (!st.baselineSet) { st.persistedHigh = msg.seq - 1; st.baselineSet = true; }
      }
    }

    if (msg.type === 'ping') {
      const daemon = this.daemons.get(daemonId);
      if (daemon) {
        this.send(daemon.ws, { type: 'pong' });
        db.updateHeartbeat(this.pool, daemonId).catch(console.error);
        // Cache metrics if present
        if (msg.cpu_pct !== undefined) {
          this.daemonMetrics.set(daemonId, { cpuPct: msg.cpu_pct, memPct: msg.mem_pct, diskPct: msg.disk_pct, updatedAt: Date.now() });
        }
        // Piggyback the delivery ack on the heartbeat so the daemon can trim its
        // unacked outbound buffer/spool — but only up to what we've durably
        // persisted, so a crash after ack can't lose an unwritten event.
        const st = this.daemonSeq.get(daemonId);
        if (st && st.persistedHigh > 0) this.send(daemon.ws, { type: 'event_ack', up_to_seq: st.persistedHigh });
      }
      return;
    }

    if (msg.type === 'daemon_shutdown') {
      this.markPersisted(daemonId, msg.seq);
      this.finalizeDaemonShutdown(daemonId);
      return;
    }

    // Handle cancel_takeover: old daemon confirms it has stopped
    if (msg.type === 'cancel_takeover') {
      const takeover = this.takeoverTimers.get(daemonId);
      if (takeover) {
        clearTimeout(takeover.timer);
        this.takeoverTimers.delete(daemonId);
        console.log(`[router] takeover cancelled by ${daemonId} — new daemon ${takeover.newDaemonId} accepted immediately`);
      }
      return;
    }

    const sessionId = msg.session_id;
    if (!sessionId) {
      // model_list (host-level response, no session_id): broadcast to the daemon owner's clients
      if (msg.type === 'model_list') {
        const daemon = this.daemons.get(daemonId);
        if (daemon?.userId) this.broadcastToUser(daemon.userId, { ...msg, daemon_id: daemonId });
        return;
      }
      if (msg.type === 'error') {
        const pendingClient = this.pendingSessionCreate.get(daemonId);
        if (pendingClient && pendingClient.readyState === 1) {
          this.send(pendingClient, msg);
        }
      }
      // session_create_failed (no session_id): forward to the originating client
      if (msg.type === 'session_create_failed') {
        const pending = this.findPendingSessionOperation(daemonId, msg.request_id);
        const originClient = pending?.origin ?? this.pendingSessionCreate.get(daemonId);
        if (originClient && originClient.readyState === 1) {
          this.send(originClient, {
            type: 'session_create_failed',
            request_id: pending?.requestId ?? msg.request_id,
            reservation_id: pending?.reservationId ?? msg.reservation_id,
            reason: msg.reason || 'start_fail',
            error: msg.error,
          });
        }
        this.settlePendingSessionOperation(pending);
        this.pendingSessionCreate.delete(daemonId);
        this.pendingSessionMeta?.delete(daemonId);
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
      this.markPersisted(daemonId, msg.seq);
      return;
    }
    const daemon = this.daemons.get(daemonId);
    const userId = daemon?.userId ?? null;

    if (msg.type === 'session_created' || msg.type === 'session_status' || msg.type === 'session_id_changed' || msg.type === 'session_discovered' || msg.type === 'subagent_discovered' || msg.type === 'session_model_changed') {
      this.sessionToDaemon.set(sessionId, daemonId);
    }
    if (msg.type === 'session_id_changed') {
      const oldId = msg.old_session_id;
      if (oldId) {
        this.pool.query('UPDATE sessions SET session_id = $1 WHERE session_id = $2', [sessionId, oldId]).catch(console.error);
        this.pool.query('UPDATE events SET session_id = $1 WHERE session_id = $2', [sessionId, oldId]).catch(console.error);
        db.ensureDaemonSessionIdentity(this.pool, sessionId, daemonId, userId ?? undefined).catch(console.error);
        for (const [, client] of this.clients) {
          if (client.subscribedSessions.has(oldId)) {
            client.subscribedSessions.delete(oldId);
            client.subscribedSessions.add(sessionId);
          }
        }
        this.sessionToDaemon.delete(oldId);
        // 主动向原始发起方补发 session_id_changed，确保即使订阅迁移有竞态也收到真实 ID
        const origin = this.pendingOriginClient.get(oldId);
        if (origin && origin.readyState === 1) {
          this.send(origin, { type: 'session_id_changed', session_id: sessionId, old_session_id: oldId });
        }
        this.pendingOriginClient.delete(oldId);
      }
    }
    if (msg.type === 'session_created') {
      const pending = this.findPendingSessionOperation(daemonId, msg.request_id);
      const meta = pending
        ? { agent_type: pending.agentType, cwd: pending.cwd }
        : this.pendingSessionMeta?.get(daemonId);
      db.upsertSession(this.pool, sessionId, daemonId, meta?.agent_type || '', meta?.cwd || '', 'running', msg.title || undefined, 'daemon', undefined, userId ?? undefined, msg.model || undefined)
        .then(() => this.settlePendingSessionOperation(pending))
        .catch(console.error);
      this.pendingSessionMeta?.delete(daemonId);
      const originClient = pending?.origin ?? this.pendingSessionCreate.get(daemonId);
      const enriched = {
        ...msg,
        request_id: pending?.requestId ?? msg.request_id,
        reservation_id: pending?.reservationId ?? msg.reservation_id,
        daemon_id: daemonId,
        hostname: daemon?.hostname || 'unknown',
      };
      if (originClient && originClient.readyState === 1) {
        const client = this.clients.get(originClient);
        if (client) client.subscribedSessions.add(sessionId);
        // 记录 origin client，供后续 session_id_changed 补发
        this.pendingOriginClient.set(sessionId, originClient);
        this.send(originClient, enriched);
      }
      // 广播给同用户的其他在线 client（多端：Web + iOS 等同时在线），
      // 让非发起端也能即时看到新会话，不依赖轮询 list_sessions。
      for (const [clientWs, client] of this.clients) {
        if (clientWs === originClient) continue;
        if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
          if (client) client.subscribedSessions.add(sessionId);
          this.send(clientWs, enriched);
        }
      }
      this.pendingSessionCreate.delete(daemonId);
      this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg);
      return;
    }
    if (msg.type === 'session_discovered') {
      // Tombstone check: skip if session was deleted by user
      db.isSessionDeleted(this.pool, sessionId).then((deleted) => {
        if (deleted) {
          console.log(`[router] skipping tombstoned session: ${sessionId}`);
          // Intentionally not persisted, but ack it so the daemon stops
          // re-discovering (replaying) a session the user already deleted.
          this.markPersisted(daemonId, msg.seq);
          return;
        }
        // Use provided title if present; otherwise leave existing title untouched
        const title = msg.title || undefined;
        const cwd = msg.cwd || '';
        db.upsertSession(this.pool, sessionId, daemonId, msg.agent || 'claude-code', cwd, msg.status || 'busy', title, 'terminal', undefined, userId ?? undefined, msg.model || undefined)
          .then(() => { if (userId) return this.broadcastQuotaStatus(userId); })
          .catch(console.error);
        this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg);
        const enriched = { ...msg, daemon_id: daemonId, hostname: daemon?.hostname || 'unknown' };
        for (const [clientWs, client] of this.clients) {
          if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) this.send(clientWs, enriched);
        }
      }).catch(console.error);
      return;
    }
    if (msg.type === 'session_model_changed') {
      // Mid-session model switch (e.g. /model in the terminal). Update the
      // sessions.model column unconditionally (upsertSession's COALESCE cannot
      // overwrite), persist as an event, and broadcast to all of the owner's
      // clients so every device's model badge refreshes.
      db.updateSessionModel(this.pool, sessionId, msg.model).catch(console.error);
      this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg);
      for (const [clientWs, client] of this.clients) {
        if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) this.send(clientWs, msg);
      }
      return;
    }
    if (msg.type === 'session_agent_changed') {
      // Persist only daemon-confirmed switches, then fan the authoritative state
      // out to every device currently viewing the session.
      db.updateSessionActiveAgent(this.pool, sessionId, msg.current_agent).catch(console.error);
      this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg);
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
      }
      return;
    }
    if (msg.type === 'subagent_discovered') {
      const isCodex = msg.agent === 'codex';
      const relation: db.SubagentRelation = {
        parentSessionId: sessionId,
        agentId: msg.agent_id || '',
        rootSessionId: msg.root_session_id || sessionId,
        kind: isCodex ? 'codex_subagent' : 'claude_subagent',
        toolUseId: msg.call_id || undefined,
        agentType: msg.subagent_type || undefined,
        title: msg.subagent_desc || undefined,
      };
      // Ack only after both the event and its relationship are durable. A
      // failed reconciliation remains in the daemon spool and retries safely.
      db.persistEvent(this.pool, sessionId, msg.type, msg)
        .then(() => db.reconcileSubagent(this.pool, relation))
        .then(() => {
          this.markPersisted(daemonId, msg.seq);
          for (const [clientWs, client] of this.clients) {
            if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
          }
        })
        .catch((e) => console.error('subagent discovery reconcile:', e));
      return;
    }
    if (msg.type === 'subagent_usage') {
      const u = msg.usage;
      if (!msg.agent_id || !u) {
        this.markPersisted(daemonId, msg.seq);
        return;
      }
      const inT = u.input_tokens || 0;
      const outT = u.output_tokens || 0;
      const crT = u.cache_read_tokens || 0;
      const ccT = u.cache_create_tokens || 0;
      // New daemons provide a stable JSONL record identity. An empty value
      // preserves the exact amount-based fingerprint used by older daemons.
      const eventId = msg.event_id || '';
      db.recordSubagentUsage(this.pool, {
        daemonId,
        seq: msg.seq,
        eventId,
        parentSessionId: sessionId,
        agentId: msg.agent_id,
        inputTokens: inT,
        outputTokens: outT,
        cacheRead: crT,
        cacheCreate: ccT,
      })
        .then(() => this.markPersisted(daemonId, msg.seq))
        .catch((e) => console.error('subagent usage persist:', e));
      return;
    }
    if (msg.type === 'generate_subagent_title_request') {
      // Not persisted as an event — only triggers async title generation for a subagent.
      this.markPersisted(daemonId, msg.seq);
      const agentId = msg.agent_id;
      const userMsg = msg.user_message;
      const agentType = msg.subagent_type;
      if (!agentId || !userMsg) {
        console.warn('[router] generate_subagent_title_request missing agent_id or user_message');
        return;
      }
      // Layer 2: skip if subagent already has a title
      db.hasDefaultSubagentTitle(this.pool, sessionId, agentId).then((isDefault) => {
        if (!isDefault) {
          console.log(`[router] skipping subagent title for ${sessionId}/${agentId} — already set`);
          return;
        }
        let ownerLocale: string | undefined;
        for (const [, client] of this.clients) {
          if (client.subscribedSessions.has(sessionId) && client.userId) { ownerLocale = client.locale; break; }
        }
        generateSubagentTitle(userMsg, agentType || '', ownerLocale).then((title) => {
          if (!title) return;
          db.updateSubagentTitleIfDefault(this.pool, sessionId, agentId, title).then((updated) => {
            if (updated) {
              console.log(`[router] subagent title generated for ${sessionId}/${agentId}: ${title}`);
              for (const [clientWs, client] of this.clients) {
                if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) {
                  this.send(clientWs, { type: 'subagent_title_update', session_id: sessionId, agent_id: agentId, parent_session_id: sessionId, title });
                }
              }
            }
          }).catch(console.error);
        }).catch(console.error);
      }).catch(console.error);
      return;
    }
    if (msg.type === 'generate_title_request') {
      // Not persisted as an event (it only triggers async title generation);
      // ack the seq up-front so neither early return stalls the daemon buffer.
      this.markPersisted(daemonId, msg.seq);
      const { user_message: userMsg, assistant_message: assistantMsg } = msg;
      if (!userMsg || !assistantMsg) {
        console.warn('[router] generate_title_request missing user_message or assistant_message');
        return;
      }
      // Layer 2: skip if title is no longer default
      db.hasDefaultTitle(this.pool, sessionId).then((isDefault) => {
        if (!isDefault) {
          console.log(`[router] skipping title generation for ${sessionId} — title already custom`);
          return;
        }
        // Resolve session owner locale for language-aware title generation
        let ownerLocale: string | undefined;
        // Find user clients subscribed to this session to get their locale
        for (const [, client] of this.clients) {
          if (client.subscribedSessions.has(sessionId) && client.userId) {
            ownerLocale = client.locale;
            break;
          }
        }
        generateTitle(userMsg, assistantMsg, ownerLocale).then((title) => {
          if (!title) return;
          // Layer 3: conditional update in DB
          db.updateTitleIfDefault(this.pool, sessionId, title).then((updated) => {
            if (updated) {
              console.log(`[router] title generated for ${sessionId}: ${title}`);
              // Broadcast to all of the owner's online clients — the list view
              // doesn't subscribe to sessions, so a subscribedSessions filter would
              // never deliver title updates to it. Mirrors session_created/discovered.
              for (const [clientWs, client] of this.clients) {
                if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
                  this.send(clientWs, { type: 'session_title_update', session_id: sessionId, title });
                }
              }
            }
          }).catch(console.error);
        }).catch(console.error);
      }).catch(console.error);
      return;
    }
    if (msg.type === 'session_title_update') {
      // Title is a best-effort, reconstructable UPDATE (not an event row); ack
      // immediately so the daemon buffer doesn't stall on it.
      this.markPersisted(daemonId, msg.seq);
      // Only overwrite default titles — protect user-renamed titles
      this.pool.query('UPDATE sessions SET title = $1 WHERE session_id = $2 AND (title LIKE \'Terminal Session-%\' OR title IS NULL)', [msg.title || '', sessionId]).catch(console.error);
      // Broadcast to all of the owner's online clients (list view included),
      // not just subscribed sessions — same reasoning as generate_title_request.
      for (const [clientWs, client] of this.clients) {
        if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) this.send(clientWs, msg);
      }
      return;
    }
    // Generic data path (agent_text, tool_call/result, user_text, session_status,
    // session_id_changed, …): persist with the ack gated on durability.
    this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg);
    // Accumulate per-turn token usage from agent_text events carrying usage (model-agnostic)
    if (msg.usage != null) {
      db.incrementSessionTokens(this.pool, sessionId, msg.usage).catch(console.error);
    }
    // Push for attention-requiring events (agent blocked, needs user action).
    // Both arrive via this generic path; push to all of the owner's devices so
    // the agent doesn't stall while the app is backgrounded/killed. Fire-and-
    // forget (never blocks the ack), mirroring session_status push below.
    //
    // Dedup by requestId: WS reconnect/seq-replay gaps (ack async window,
    // no-seq legacy daemons, persist retries) can reprocess an event and fire
    // the push twice. Only the push side-effect is guarded here — event
    // forwarding to subscribed clients below still runs regardless, so a
    // reconnected foreground client stays in sync.
    if (userId && (msg.type === 'approval_request' || msg.type === 'interactive_prompt' || msg.type === 'question_request')) {
      const requestId = (msg.request_id as string | undefined) || '';
      // Empty requestId can't be deduped (and shouldn't block the push) —
      // accept the rare duplicate for such malformed events.
      const shouldPush = requestId === '' || this.pushDeduper.shouldPush(requestId);
      if (shouldPush) {
        if (msg.type === 'approval_request') {
          const toolName = msg.tool || '';
          const summary = summarizeToolInput(toolName, msg.input);
          // Regular approval — free + Pro (product-critical, never gated).
          notifyUser(this.pool, userId, approvalPush(
            msg.title || '', toolName, summary, sessionId, requestId,
          )).catch(console.error);
          // D3 high-risk warning — Pro-only, layered on top of the regular
          // push. Shares the same dedup decision (one requestId = one event).
          if (isHighRiskCommand(toolName, summary)) {
            this.maybePushToPro(userId, highRiskPush(
              msg.title || '', toolName, summary, sessionId, requestId,
            )).catch(console.error);
          }
        } else if (msg.type === 'interactive_prompt') {
          const prompt = (msg.input?.prompt as string) || '';
          notifyUser(this.pool, userId, interactivePush(
            msg.title || '', prompt, sessionId, requestId,
          )).catch(console.error);
        } else {
          const firstQuestion = Array.isArray(msg.questions) ? msg.questions[0] : undefined;
          const prompt = firstQuestion?.question || firstQuestion?.header || '';
          notifyUser(this.pool, userId, questionPush(prompt, sessionId, requestId)).catch(console.error);
        }
      }
    }
    if (msg.type === 'permission_config_changed') {
      this.persistAndAck(daemonId, msg.seq, sessionId, msg.type, msg);
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
      }
      return;
    }
    if (msg.type === 'session_status') {
      // UPDATE-ONLY: never INSERT from a status event. A session_id that no
      // session_created/session_discovered ever announced is a ghost (e.g. the
      // transient sessions/<pid>.json Claude Code writes on --continue); insert-
      // upserting it created phantom "status + time, no messages" rows. If the
      // row doesn't exist, drop the status and its side-effects entirely.
      db.updateSessionStatus(this.pool, sessionId, daemonId, msg.status || 'unknown', msg.exit_reason, userId ?? undefined)
        .then((updated) => {
          if (!updated) {
            console.log(`[router] dropping session_status for unknown session ${sessionId} (no row — likely a ghost/transient session)`);
            return;
          }
          // C2: persist cumulative cost_usd from result event
          if (msg.cost_usd != null) {
            db.updateSessionCost(this.pool, sessionId, parseFloat(msg.cost_usd)).catch(console.error);
          }
          const pending = this.findPendingSessionOperation(daemonId, msg.request_id);
          if (pending && ['running', 'busy', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(msg.status)) {
            this.settlePendingSessionOperation(pending);
          }
          if (userId) this.broadcastQuotaStatus(userId).catch(console.error);
          // Push notification for terminal states
          if (userId && ['completed', 'error', 'killed', 'exited'].includes(msg.status)) {
            notifyUser(this.pool, userId, sessionStatusPush(msg.title || '', msg.status, sessionId)).catch(console.error);
          }
          // Forward to subscribed clients only for real sessions.
          for (const [clientWs, client] of this.clients) {
            if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
          }
        })
        .catch(console.error);
      return;
    }
    for (const [clientWs, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
    }
  }

  async handleClientMessage(clientWs: WebSocket, msg: any): Promise<void> {
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
      const owned = await db.isSessionOwnedByUser(this.pool, client.userId, msg.session_id).catch(() => false);
      if (!owned) {
        this.send(clientWs, { type: 'error', session_id: msg.session_id, error: 'session not found or not owned' });
        return;
      }
      client.subscribedSessions.add(msg.session_id);
    }
    if (msg.type === 'replay') { this.handleReplay(clientWs, msg.session_id, msg.last_seq, msg.req_id, msg.direction, msg.limit); return; }
    if (msg.type === 'replay_subagent') { this.handleReplaySubagent(clientWs, msg.session_id, msg.agent_id, msg.last_seq, msg.req_id, msg.limit); return; }
    if (msg.type === 'list_sessions') { this.handleListSessions(clientWs, client.userId, msg); return; }
    if (msg.type === 'list_daemons') { console.log('[router] list_daemons from user', client.userId, 'daemons in map:', this.daemons.size); this.handleListDaemons(clientWs, client.userId); return; }
    if (msg.type === 'set_locale') {
      if (msg.locale) { client.locale = msg.locale; }
      return;
    }

    if (msg.type === 'local_command_log') {
      // Locally-handled slash command (/model, /cost, /status): the user msg + receipt
      // are built client-side (no daemon round-trip). Persist both as events so they
      // survive refresh, and broadcast to OTHER same-user clients for multi-device sync.
      // Origin already rendered both locally, so skip echoing back to avoid duplicates.
      const sessionId = msg.session_id;
      if (!sessionId) return;
      const userEvt = { type: 'user_text', session_id: sessionId, text: msg.user_text };
      const receiptEvt = { type: 'command_receipt', session_id: sessionId, command: msg.command, receipt_status: msg.receipt_status, message: msg.message };
      db.persistEvent(this.pool, sessionId, 'user_text', userEvt).catch(console.error);
      db.persistEvent(this.pool, sessionId, 'command_receipt', receiptEvt).catch(console.error);
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
      // Ownership check
      db.isSessionOwnedByUser(this.pool, client.userId!, sessionId).then((owned) => {
        if (!owned) { this.send(clientWs, { type: 'error', error: 'session not found or not owned' }); return; }
        db.deleteSession(this.pool, sessionId).catch(console.error);
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
      if (isAppReviewDemoDaemon(msg.daemon_id)) {
        this.send(clientWs, {
          type: 'session_create_failed',
          request_id: msg.request_id,
          reason: 'demo_read_only',
          error: 'App Review 演示数据为只读模式',
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
        this.send(clientWs, { type: 'session_create_failed', reason: 'daemon_offline', error: 'no daemons available' });
        return;
      }
      const { id: daemonId } = targetDaemon;
      const requestId = typeof msg.request_id === 'string' && msg.request_id
        ? msg.request_id
        : randomUUID();
      const existingPending = this.pendingSessionOperations.get(requestId);
      if (existingPending?.daemonId === daemonId && existingPending.operation === 'create') {
        return;
      }
      let reservationId: string | null = null;
      let expiresAt: number | null = null;
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
          limit: enforcement === 'enforce' ? entitlements.maxConcurrentSessions : null,
        });
        if (!decision.allowed) {
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
      }
      this.trackPendingSessionOperation({
        requestId,
        reservationId,
        daemonId,
        origin: clientWs,
        operation: 'create',
        agentType: msg.agent || 'claude-code',
        cwd: msg.cwd || '',
      }, expiresAt);
      if (client.userId !== null) this.broadcastQuotaStatus(client.userId).catch(console.error);
      this.pendingSessionCreate.set(daemonId, clientWs);
      this.pendingSessionMeta = this.pendingSessionMeta || new Map();
      this.pendingSessionMeta.set(daemonId, { agent_type: msg.agent || 'claude-code', cwd: msg.cwd || '' });
      this.send(targetDaemon.daemon.ws, {
        ...msg,
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
      let daemonId = this.sessionToDaemon.get(msg.session_id) ?? null;
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
            const status = await db.getSessionStatus(this.pool, msg.session_id);
            const isActive = ['running', 'busy', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(status || '');
            if (!isActive) {
              const requestId = typeof msg.request_id === 'string' && msg.request_id
                ? msg.request_id
                : (typeof msg.msg_id === 'string' && msg.msg_id ? msg.msg_id : randomUUID());
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
                origin: clientWs,
                operation: 'resume',
                agentType: '',
                cwd: '',
              }, decision.expiresAt);
              this.broadcastQuotaStatus(client.userId).catch(console.error);
              outbound = {
                ...msg,
                request_id: requestId,
                quota_grant: {
                  reservation_id: decision.reservationId ?? `unlimited-${requestId}`,
                  expires_at: decision.expiresAt ?? (Date.now() + 20_000),
                  operation: 'resume',
                },
              };
            }
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

  private async handleReplay(clientWs: WebSocket, sessionId: string, lastSeq: number, reqId?: number, direction?: string, limit?: number): Promise<void> {
    const withReq = (obj: any) => reqId !== undefined ? { ...obj, req_id: reqId } : obj;
    // session-history-pagination: backward direction paginates history (recent N / cursor-before N).
    // Default forward (id > lastSeq ASC) preserves existing full-load behavior for old clients.
    const isBackward = direction === 'backward';
    const lim = isBackward && limit && limit > 0 ? limit : 100;
    try {
      const currentStatus = await db.getSessionStatus(this.pool, sessionId);
      let events: any[];
      if (isBackward) {
        events = (lastSeq && lastSeq > 0)
          ? await db.getEventsBefore(this.pool, sessionId, lastSeq, lim)
          : await db.getRecentEvents(this.pool, sessionId, lim);
      } else {
        events = await db.getEventsAfter(this.pool, sessionId, lastSeq);
      }
      // has_more (backward only, count-based heuristic): a full page implies older rows may exist.
      const hasMore = isBackward ? events.length === lim : false;
      if (events.length === 0) {
        this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq, has_more: false, status: currentStatus }));
        return;
      }
      // backward rows arrive in id DESC; forward rows in id ASC. Batches keep that order;
      // the client reverses backward batches before render/prepend.
      const BATCH = 50;
      for (let i = 0; i < events.length; i += BATCH) {
        const slice = events.slice(i, i + BATCH);
        this.send(clientWs, withReq({
          type: 'replay_batch',
          session_id: sessionId,
          events: slice.map(e => e.payload),
          last_seq: slice[slice.length - 1].id,
          direction: direction || 'forward',
        }));
      }
      this.send(clientWs, withReq({
        type: 'replay_end',
        session_id: sessionId,
        count: events.length,
        last_seq: events[events.length - 1].id,
        has_more: hasMore,
        status: currentStatus,
      }));
    } catch (err) {
      console.error('replay error:', err);
      // Always send replay_end so the client doesn't hang on isLoading
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq, has_more: false }));
    }
  }

  private async handleReplaySubagent(clientWs: WebSocket, sessionId: string, agentId: string, lastSeq?: number, reqId?: number, limit?: number): Promise<void> {
    const withReq = (obj: any) => reqId !== undefined ? { ...obj, req_id: reqId } : obj;
    const lim = limit && limit > 0 ? limit : 100;
    if (!agentId) {
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, agent_id: agentId, count: 0, last_seq: lastSeq ?? 0, has_more: false }));
      return;
    }
    try {
      const events = (lastSeq && lastSeq > 0)
        ? await db.getSubagentEventsBefore(this.pool, sessionId, agentId, lastSeq, lim)
        : await db.getRecentSubagentEvents(this.pool, sessionId, agentId, lim);
      const hasMore = events.length === lim;
      if (events.length === 0) {
        this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, agent_id: agentId, count: 0, last_seq: lastSeq ?? 0, has_more: false }));
        return;
      }
      const BATCH = 50;
      for (let i = 0; i < events.length; i += BATCH) {
        const slice = events.slice(i, i + BATCH);
        this.send(clientWs, withReq({
          type: 'replay_batch',
          session_id: sessionId,
          agent_id: agentId,
          events: slice.map(e => e.payload),
          last_seq: slice[slice.length - 1].id,
          direction: 'backward',
        }));
      }
      this.send(clientWs, withReq({
        type: 'replay_end',
        session_id: sessionId,
        agent_id: agentId,
        count: events.length,
        last_seq: events[events.length - 1].id,
        has_more: hasMore,
      }));
    } catch (err) {
      console.error('replay_subagent error:', err);
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, agent_id: agentId, count: 0, last_seq: lastSeq ?? 0, has_more: false }));
    }
  }

  private async handleListSessions(clientWs: WebSocket, userId: number | null, msg: any = {}): Promise<void> {
    try {
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
      const sessions = userId
        ? await db.listSessionsByUser(this.pool, userId)
        : await db.listSessions(this.pool);
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
                COUNT(*) FILTER (WHERE status IN ('running','busy'))::int AS active
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
                COUNT(*) FILTER (WHERE status IN ('running','busy'))::int AS active
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
    const daemon = this.daemons.get(daemonId);
    if (!daemon) {
      return { success: false, error: 'daemon not found or offline' };
    }
    if (daemon.userId !== userId) {
      return { success: false, error: 'forbidden' };
    }

    // Cancel any pending takeover timer for this daemon
    const takeover = this.takeoverTimers.get(daemonId);
    if (takeover) {
      clearTimeout(takeover.timer);
      this.takeoverTimers.delete(daemonId);
    }

    // Send kicked message with 0 grace period
    if (daemon.ws.readyState === 1) {
      this.send(daemon.ws, {
        type: 'kicked',
        reason: 'force_kick',
        message: '管理员已强制下线此设备',
        grace_period_seconds: 0,
      });
      daemon.ws.close();
    }

    // Revoke the daemon's specific token so it can't reconnect with the old one.
    try {
      await db.revokeDaemonToken(this.pool, daemonId, userId, 'force_kick');
      await db.insertAuditLog(this.pool, userId, 'force_kick', {
        daemon_id: daemonId,
        hostname: daemon.hostname,
      });
    } catch (e) { console.error('force_kick revoke:', e); }

    // Unregister
    this.daemons.delete(daemonId);
    db.setDaemonOffline(this.pool, daemonId).catch(console.error);

    return { success: true };
  }

  async handleDeleteDaemon(daemonId: string, userId: number): Promise<{ success: boolean; error?: string }> {
    const daemon = this.daemons.get(daemonId);
    if (daemon && daemon.userId !== userId) {
      return { success: false, error: 'forbidden' };
    }

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
      await db.revokeDaemonToken(this.pool, daemonId, userId, 'user_revoke');
      const deleted = await db.deleteDaemon(this.pool, userId, daemonId);
      if (!deleted) return { success: false, error: 'daemon not found or not owned' };
    } catch (e) {
      console.error('delete daemon:', e);
      return { success: false, error: 'failed to delete daemon' };
    }

    this.daemons.delete(daemonId);
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
