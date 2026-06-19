import type { WebSocket } from 'ws';
import type pg from 'pg';
import * as db from './db.js';
import { generateTitle } from './title.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush } from './push.js';

interface DaemonConnection { ws: WebSocket; daemonId: string; hostname: string; agents: any[]; userId: number | null; os?: string; ip?: string; port?: string; arch?: string; version?: string; startedAt?: number }
interface ClientConnection { ws: WebSocket; subscribedSessions: Set<string>; userId: number | null; locale: string }
interface DaemonMetrics { cpuPct: number; memPct: number; diskPct: number; updatedAt: number }

export class Router {
  private daemons = new Map<string, DaemonConnection>();
  private daemonMetrics = new Map<string, DaemonMetrics>();
  private clients = new Map<WebSocket, ClientConnection>();
  private sessionToDaemon = new Map<string, string>();
  private pendingSessionCreate = new Map<string, WebSocket>();
  private pendingSessionMeta = new Map<string, { agent_type: string; cwd: string }>();
  private pendingOriginClient = new Map<string, WebSocket>(); // pending session_id → origin client (for session_id_changed 补发)
  private takeoverTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; newDaemonId: string; newHostname: string }>();
  private pool: pg.Pool;

  constructor(pool: pg.Pool) { this.pool = pool; }

  async registerDaemon(ws: WebSocket, msg: any, userId: number | null, tokenJti?: string, machineId?: string): Promise<void> {
    const daemonId = msg.daemon_id;
    const hostname = msg.hostname || 'unknown';
    // Compose agents as [{type, version, latest}] objects (C4b: version; C4c: latest for upgrade UI)
    const agentTypes: string[] = msg.agents || [];
    const agentVersions: Record<string, string> = msg.agent_versions || {};
    const agentLatests: Record<string, string> = msg.agent_latests || {};
    const agents = agentTypes.map((t: string) => ({ type: t, version: agentVersions[t] || '', latest: agentLatests[t] || '' }));

    // Soft eviction: check for existing daemon(s) for this user
    if (userId) {
      try {
        const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
        const maxDaemons = whitelist ? Infinity : (plan === 'free' ? 1 : Infinity);

        // Find existing online daemons for this user with different daemonId
        const oldDaemons: { daemonId: string; daemon: DaemonConnection }[] = [];
        for (const [dId, d] of this.daemons) {
          if (d.userId === userId && dId !== daemonId) {
            oldDaemons.push({ daemonId: dId, daemon: d });
          }
        }

        if (oldDaemons.length >= maxDaemons) {
          // Soft eviction: notify old daemon(s) and set grace period
          for (const { daemonId: oldId, daemon: oldDaemon } of oldDaemons) {
            // Send kicked message with grace period
            this.send(oldDaemon.ws, {
              type: 'kicked',
              reason: 'new_login',
              message: `账号已在 ${hostname} 上登录，当前连接将在 5 分钟后断开`,
              grace_period_seconds: 300,
              new_hostname: hostname,
            });

            // Start grace period timer
            const timer = setTimeout(() => {
              // Revoke old daemon's token
              if (oldDaemon.userId) {
                db.revokeToken(this.pool, '', oldDaemon.userId, 'new_login').catch(console.error);
                db.insertAuditLog(this.pool, oldDaemon.userId, 'daemon_replace', {
                  old_daemon_id: oldId,
                  new_daemon_id: daemonId,
                  grace_period: 300,
                }).catch(console.error);
              }
              // Close old daemon connection
              if (oldDaemon.ws.readyState === 1) {
                this.send(oldDaemon.ws, {
                  type: 'kicked',
                  reason: 'grace_period_expired',
                  message: '5 分钟等待期已过，连接即将断开',
                  grace_period_seconds: 0,
                });
                oldDaemon.ws.close();
              }
              this.daemons.delete(oldId);
              db.setDaemonOffline(this.pool, oldId).catch(console.error);
            }, 300_000); // 5 minutes

            // Store timer reference for cancellation
            this.takeoverTimers = this.takeoverTimers || new Map();
            this.takeoverTimers.set(oldId, { timer, newDaemonId: daemonId, newHostname: hostname });
          }
        }
      } catch (e) {
        console.error('daemon limit check:', e);
      }
    }

    // Fallback: if the connecting token didn't carry a userId (e.g. a legacy or
    // anonymous reconnection), recover the daemon's persisted owner from
    // daemons.user_id. Without this, sessions created during this connection
    // land with user_id NULL and vanish from the owner's web list (filtered by
    // listSessionsByUser). Soft eviction above already ran on the original
    // (null) userId, which is fine — an anonymous reconnect shouldn't evict.
    if (!userId) {
      try { userId = await db.getDaemonOwner(this.pool, daemonId); } catch (e) { /* leave null */ }
    }

    const daemonOS = msg.os || 'unknown';
    const daemonIP = msg.ip || 'unknown';
    const daemonPort = msg.port || '';
    const daemonArch = msg.arch || '';
    const daemonVersion = msg.version || '';
    const daemonStartedAt = msg.started_at || 0;
    this.daemons.set(daemonId, { ws, daemonId, hostname, agents, userId, os: daemonOS, ip: daemonIP, port: daemonPort, arch: daemonArch, version: daemonVersion, startedAt: daemonStartedAt });
    console.log('[ws] daemon registered', daemonId, 'agents:', JSON.stringify(agents), 'userId:', userId);
    try { await db.upsertDaemon(this.pool, daemonId, hostname, agents, daemonArch, daemonVersion, daemonStartedAt); } catch (e) { console.error('upsertDaemon:', e); }
    if (userId) {
      try { await db.bindDaemonToUser(this.pool, daemonId, userId); } catch (e) { console.error('bindDaemon:', e); }
      if (tokenJti) {
        db.bindTokenToDaemon(this.pool, daemonId, tokenJti, machineId).catch(console.error);
      }
    }
    db.cleanStaleSessions(this.pool).catch(console.error);
    this.send(ws, { type: 'register_ack', status: 'ok', connection_id: daemonId });

    // Broadcast daemon online to clients with same userId
    const alias = await db.getDaemonAlias(this.pool, daemonId);
    for (const [clientWs, client] of this.clients) {
      if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
        this.send(clientWs, { type: 'daemon_status', daemon_id: daemonId, status: 'online', hostname, agents, alias, os: daemonOS, ip: daemonIP });
      }
    }
  }

  unregisterDaemon(daemonId: string): void {
    const daemon = this.daemons.get(daemonId);
    const hostname = daemon?.hostname || 'unknown';
    const userId = daemon?.userId ?? null;
    this.daemons.delete(daemonId);

    // Clean up any pending takeover timer
    const takeover = this.takeoverTimers.get(daemonId);
    if (takeover) {
      clearTimeout(takeover.timer);
      this.takeoverTimers.delete(daemonId);
    }

    // If a session_create was in-flight on this daemon, notify the origin client of failure
    const pendingOrigin = this.pendingSessionCreate.get(daemonId);
    if (pendingOrigin && pendingOrigin.readyState === 1) {
      this.send(pendingOrigin, { type: 'session_create_failed', reason: 'daemon_offline', error: 'daemon disconnected' });
    }
    this.pendingSessionCreate.delete(daemonId);
    this.pendingSessionMeta?.delete(daemonId);

    db.setDaemonOffline(this.pool, daemonId).catch(console.error);

    // Push notification for daemon offline
    if (userId) {
      notifyUser(this.pool, userId, daemonOfflinePush(hostname, daemonId)).catch(console.error);
    }

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
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) {
          this.send(clientWs, { type: 'session_status', session_id: sessionId, status: 'disconnected', daemon_id: daemonId });
        }
      }
    }
  }

  registerClient(ws: WebSocket, userId: number | null): void {
    this.clients.set(ws, { ws, subscribedSessions: new Set(), userId, locale: 'zh' });
  }
  unregisterClient(ws: WebSocket): void { this.clients.delete(ws); }

  handleDaemonMessage(daemonId: string, msg: any): void {
    if (msg.type === 'ping') {
      const daemon = this.daemons.get(daemonId);
      if (daemon) {
        this.send(daemon.ws, { type: 'pong' });
        db.updateHeartbeat(this.pool, daemonId).catch(console.error);
        // Cache metrics if present
        if (msg.cpu_pct !== undefined) {
          this.daemonMetrics.set(daemonId, { cpuPct: msg.cpu_pct, memPct: msg.mem_pct, diskPct: msg.disk_pct, updatedAt: Date.now() });
        }
      }
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
        if (daemon?.userId) this.broadcastToUser(daemon.userId, msg);
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
        const originClient = this.pendingSessionCreate.get(daemonId);
        if (originClient && originClient.readyState === 1) {
          this.send(originClient, { type: 'session_create_failed', reason: msg.reason || 'start_fail', error: msg.error });
        }
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
      return;
    }
    const daemon = this.daemons.get(daemonId);
    const userId = daemon?.userId ?? null;

    if (msg.type === 'session_created' || msg.type === 'session_status' || msg.type === 'session_id_changed' || msg.type === 'session_discovered' || msg.type === 'subagent_discovered') {
      this.sessionToDaemon.set(sessionId, daemonId);
    }
    if (msg.type === 'session_id_changed') {
      const oldId = msg.old_session_id;
      if (oldId) {
        this.pool.query('UPDATE sessions SET session_id = $1 WHERE session_id = $2', [sessionId, oldId]).catch(console.error);
        this.pool.query('UPDATE events SET session_id = $1 WHERE session_id = $2', [sessionId, oldId]).catch(console.error);
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
      const meta = this.pendingSessionMeta?.get(daemonId);
      db.upsertSession(this.pool, sessionId, daemonId, meta?.agent_type || '', meta?.cwd || '', 'running', msg.title || undefined, 'daemon', undefined, userId ?? undefined, msg.model || undefined).catch(console.error);
      this.pendingSessionMeta?.delete(daemonId);
      const originClient = this.pendingSessionCreate.get(daemonId);
      const enriched = { ...msg, daemon_id: daemonId, hostname: daemon?.hostname || 'unknown' };
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
      db.insertEvent(this.pool, sessionId, msg.type, msg).catch(console.error);
      return;
    }
    if (msg.type === 'session_discovered') {
      // Tombstone check: skip if session was deleted by user
      db.isSessionDeleted(this.pool, sessionId).then((deleted) => {
        if (deleted) {
          console.log(`[router] skipping tombstoned session: ${sessionId}`);
          return;
        }
        // Use provided title if present; otherwise leave existing title untouched
        const title = msg.title || undefined;
        const cwd = msg.cwd || '';
        db.upsertSession(this.pool, sessionId, daemonId, 'claude-code', cwd, msg.status || 'busy', title, 'terminal', undefined, userId ?? undefined, msg.model || undefined).catch(console.error);
        db.insertEvent(this.pool, sessionId, msg.type, msg).catch(console.error);
        const enriched = { ...msg, daemon_id: daemonId, hostname: daemon?.hostname || 'unknown' };
        for (const [clientWs, client] of this.clients) {
          if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) this.send(clientWs, enriched);
        }
      }).catch(console.error);
      return;
    }
    if (msg.type === 'subagent_discovered') {
      db.insertEvent(this.pool, sessionId, msg.type, msg).catch(console.error);
      db.incrementSubagentCount(this.pool, sessionId).catch(console.error);
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
      }
      return;
    }
    if (msg.type === 'generate_title_request') {
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
              for (const [clientWs, client] of this.clients) {
                if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) {
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
      // Only overwrite default titles — protect user-renamed titles
      this.pool.query('UPDATE sessions SET title = $1 WHERE session_id = $2 AND (title LIKE \'Terminal Session-%\' OR title IS NULL)', [msg.title || '', sessionId]).catch(console.error);
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
      }
      return;
    }
    db.insertEvent(this.pool, sessionId, msg.type, msg).catch(console.error);
    // Accumulate per-turn token usage from agent_text events carrying usage (model-agnostic)
    if (msg.usage != null) {
      db.incrementSessionTokens(this.pool, sessionId, msg.usage).catch(console.error);
    }
    if (msg.type === 'session_status') {
      db.upsertSession(this.pool, sessionId, daemonId, '', '', msg.status || 'unknown', undefined, undefined, msg.exit_reason, userId ?? undefined).catch(console.error);
      // C2: persist cumulative cost_usd from result event
      if (msg.cost_usd != null) {
        db.updateSessionCost(this.pool, sessionId, parseFloat(msg.cost_usd)).catch(console.error);
      }
      // Push notification for terminal states
      if (userId && ['completed', 'error', 'killed', 'exited'].includes(msg.status)) {
        notifyUser(this.pool, userId, sessionStatusPush(msg.title || '', msg.status, sessionId)).catch(console.error);
      }
    }
    for (const [clientWs, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
    }
  }

  handleClientMessage(clientWs: WebSocket, msg: any): void {
    const client = this.clients.get(clientWs);
    if (!client) return;
    if (msg.session_id) client.subscribedSessions.add(msg.session_id);
    if (msg.type === 'replay') { this.handleReplay(clientWs, msg.session_id, msg.last_seq, msg.req_id, msg.direction, msg.limit); return; }
    if (msg.type === 'list_sessions') { this.handleListSessions(clientWs, client.userId); return; }
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
      db.insertEvent(this.pool, sessionId, 'user_text', userEvt).catch(console.error);
      db.insertEvent(this.pool, sessionId, 'command_receipt', receiptEvt).catch(console.error);
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
      this.pendingSessionCreate.set(daemonId, clientWs);
      this.pendingSessionMeta = this.pendingSessionMeta || new Map();
      this.pendingSessionMeta.set(daemonId, { agent_type: msg.agent || 'claude-code', cwd: msg.cwd || '' });
      this.send(targetDaemon.daemon.ws, msg);
      return;
    }

    if (msg.session_id) {
      const daemonId = this.sessionToDaemon.get(msg.session_id);
      if (daemonId) {
        const daemon = this.daemons.get(daemonId);
        if (daemon && daemon.ws.readyState === 1) { this.send(daemon.ws, msg); return; }
      }
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
        this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq, has_more: false }));
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
      }));
    } catch (err) {
      console.error('replay error:', err);
      // Always send replay_end so the client doesn't hang on isLoading
      this.send(clientWs, withReq({ type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq, has_more: false }));
    }
  }

  private async handleListSessions(clientWs: WebSocket, userId: number | null): Promise<void> {
    try {
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
      const sessionCounts = userId ? await db.getSessionCountsByUser(this.pool, userId) : {};
      for (const [, daemon] of this.daemons) {
        console.log('[router] list_daemons iterating daemon', daemon.daemonId, 'daemon.userId:', daemon.userId, 'request.userId:', userId, 'agents:', JSON.stringify(daemon.agents));
        if (!this.sameUser(daemon.userId, userId)) continue;
        const alias = await db.getDaemonAlias(this.pool, daemon.daemonId);
        const metrics = this.daemonMetrics.get(daemon.daemonId);
        const counts = sessionCounts[daemon.daemonId];
        daemonList.push({
          daemon_id: daemon.daemonId,
          hostname: daemon.hostname,
          agents: daemon.agents,
          daemon_online: true,
          daemon_alias: alias,
          status: 'online',
          os: daemon.os || 'unknown',
          ip: daemon.ip || 'unknown',
          port: daemon.port || '',
          arch: daemon.arch || '',
          version: daemon.version || '',
          started_at: daemon.startedAt || 0,
          last_heartbeat: Date.now(),
          cpu_pct: metrics?.cpuPct ?? null,
          mem_pct: metrics?.memPct ?? null,
          disk_pct: metrics?.diskPct ?? null,
          active_sessions: counts?.active ?? 0,
          total_sessions: counts?.total ?? 0,
        });
      }
      // Also include offline daemons from DB for this user
      if (userId) {
        try {
          const result = await this.pool.query(
            `SELECT daemon_id, hostname, agents, alias, status, last_heartbeat FROM daemons WHERE user_id = $1 AND status = 'offline'`,
            [userId]
          );
          for (const row of result.rows) {
            const counts = sessionCounts[row.daemon_id];
            daemonList.push({
              daemon_id: row.daemon_id,
              hostname: row.hostname,
              agents: row.agents || [],
              daemon_online: false,
              daemon_alias: row.alias,
              status: 'offline',
              last_seen_at: row.last_heartbeat,
              active_sessions: counts?.active ?? 0,
              total_sessions: counts?.total ?? 0,
            });
          }
        } catch (e) { console.error('list_daemons offline:', e); }
      }
      console.log('[router] list_daemons sending', daemonList.length, 'daemons to user', userId);
    this.send(clientWs, { type: 'daemon_list', daemons: daemonList });
    } catch (err) { console.error('list_daemons error:', err); }
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

    // Revoke token
    try {
      await db.revokeToken(this.pool, '', userId, 'force_kick');
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
