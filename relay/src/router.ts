import type { WebSocket } from 'ws';
import type pg from 'pg';
import * as db from './db.js';
import { generateTitle } from './title.js';
import { notifyUser, sessionStatusPush, daemonOfflinePush } from './push.js';

interface DaemonConnection { ws: WebSocket; daemonId: string; hostname: string; agents: string[]; userId: number | null }
interface ClientConnection { ws: WebSocket; subscribedSessions: Set<string>; userId: number | null }

export class Router {
  private daemons = new Map<string, DaemonConnection>();
  private clients = new Map<WebSocket, ClientConnection>();
  private sessionToDaemon = new Map<string, string>();
  private pendingSessionCreate = new Map<string, WebSocket>();
  private pendingSessionMeta = new Map<string, { agent_type: string; cwd: string }>();
  private pool: pg.Pool;

  constructor(pool: pg.Pool) { this.pool = pool; }

  async registerDaemon(ws: WebSocket, msg: any, userId: number | null): Promise<void> {
    const daemonId = msg.daemon_id;
    const hostname = msg.hostname || 'unknown';
    const agents = msg.agents || [];

    // Daemon limit check for authenticated users
    if (userId) {
      try {
        const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, userId);
        if (!whitelist && plan === 'free') {
          // Count online daemons for this user
          let onlineCount = 0;
          let currentHost = '';
          for (const [, d] of this.daemons) {
            if (d.userId === userId) {
              onlineCount++;
              currentHost = d.hostname;
            }
          }
          if (onlineCount >= 1) {
            this.send(ws, {
              type: 'error',
              error: `免费版仅支持1台主机。当前在线: ${currentHost}。请先在 ${currentHost} 上运行 pocketctl daemon stop`,
              code: 'DAEMON_LIMIT_REACHED',
              limit: 1,
              plan: 'free',
              current_host: currentHost,
            });
            ws.close();
            return;
          }
        }
      } catch (e) {
        console.error('daemon limit check:', e);
        // Proceed with registration on error (don't block on check failure)
      }
    }

    this.daemons.set(daemonId, { ws, daemonId, hostname, agents, userId });
    // Await daemon upsert BEFORE sending ack, so FK constraints on subsequent
    // session_discovered events won't fail (daemon row must exist first).
    try { await db.upsertDaemon(this.pool, daemonId, hostname, agents); } catch (e) { console.error('upsertDaemon:', e); }
    if (userId) { try { await db.bindDaemonToUser(this.pool, daemonId, userId); } catch (e) { console.error('bindDaemon:', e); } }
    db.cleanStaleSessions(this.pool).catch(console.error);
    this.send(ws, { type: 'register_ack', status: 'ok', connection_id: daemonId });

    // Broadcast daemon online to clients with same userId (or all for legacy)
    const alias = await db.getDaemonAlias(this.pool, daemonId);
    for (const [clientWs, client] of this.clients) {
      if (clientWs.readyState === 1 && this.sameUser(client.userId, userId)) {
        this.send(clientWs, { type: 'daemon_status', daemon_id: daemonId, status: 'online', hostname, agents, alias });
      }
    }
  }

  unregisterDaemon(daemonId: string): void {
    const daemon = this.daemons.get(daemonId);
    const hostname = daemon?.hostname || 'unknown';
    const userId = daemon?.userId ?? null;
    this.daemons.delete(daemonId);
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
    this.clients.set(ws, { ws, subscribedSessions: new Set(), userId });
  }
  unregisterClient(ws: WebSocket): void { this.clients.delete(ws); }

  handleDaemonMessage(daemonId: string, msg: any): void {
    if (msg.type === 'ping') {
      const daemon = this.daemons.get(daemonId);
      if (daemon) { this.send(daemon.ws, { type: 'pong' }); db.updateHeartbeat(this.pool, daemonId).catch(console.error); }
      return;
    }
    const sessionId = msg.session_id;
    if (!sessionId) {
      if (msg.type === 'error') {
        const pendingClient = this.pendingSessionCreate.get(daemonId);
        if (pendingClient && pendingClient.readyState === 1) {
          this.send(pendingClient, msg);
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
      }
    }
    if (msg.type === 'session_created') {
      const meta = this.pendingSessionMeta?.get(daemonId);
      db.upsertSession(this.pool, sessionId, daemonId, meta?.agent_type || '', meta?.cwd || '', 'running', msg.title || undefined, 'daemon', undefined, userId ?? undefined).catch(console.error);
      this.pendingSessionMeta?.delete(daemonId);
      const originClient = this.pendingSessionCreate.get(daemonId);
      if (originClient && originClient.readyState === 1) {
        const client = this.clients.get(originClient);
        if (client) client.subscribedSessions.add(sessionId);
        const enriched = { ...msg, daemon_id: daemonId, hostname: daemon?.hostname || 'unknown' };
        this.send(originClient, enriched);
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
        // Use provided title, or generate fallback with session ID suffix
        const title = msg.title || `Terminal Session-${sessionId.slice(-8)}`;
        const cwd = msg.cwd || '';
        db.upsertSession(this.pool, sessionId, daemonId, 'claude-code', cwd, msg.status || 'busy', title, 'terminal', undefined, userId ?? undefined).catch(console.error);
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
        generateTitle(userMsg, assistantMsg).then((title) => {
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
      this.pool.query('UPDATE sessions SET title = $1 WHERE session_id = $2', [msg.title || '', sessionId]).catch(console.error);
      for (const [clientWs, client] of this.clients) {
        if (client.subscribedSessions.has(sessionId) && clientWs.readyState === 1) this.send(clientWs, msg);
      }
      return;
    }
    db.insertEvent(this.pool, sessionId, msg.type, msg).catch(console.error);
    if (msg.type === 'session_status') {
      db.upsertSession(this.pool, sessionId, daemonId, '', '', msg.status || 'unknown', undefined, undefined, msg.exit_reason).catch(console.error);
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
    if (msg.type === 'replay') { this.handleReplay(clientWs, msg.session_id, msg.last_seq); return; }
    if (msg.type === 'list_sessions') { this.handleListSessions(clientWs, client.userId); return; }
    if (msg.type === 'list_daemons') { console.log('[router] list_daemons from user', client.userId, 'daemons in map:', this.daemons.size); this.handleListDaemons(clientWs, client.userId); return; }

    if (msg.type === 'session_delete') {
      const sessionId = msg.session_id;
      if (!sessionId) { this.send(clientWs, { type: 'error', error: 'session_id required' }); return; }
      // Delete session, events from DB, write tombstone
      db.deleteSession(this.pool, sessionId).catch(console.error);
      // Clean up session-to-daemon mapping
      this.sessionToDaemon.delete(sessionId);
      // Broadcast session_deleted to all clients of the same user
      for (const [ws, c] of this.clients) {
        if (ws.readyState === 1 && this.sameUser(c.userId, client.userId)) {
          c.subscribedSessions.delete(sessionId);
          this.send(ws, { type: 'session_deleted', session_id: sessionId });
        }
      }
      return;
    }

    if (msg.type === 'session_create') {
      // Route to a daemon owned by the same user
      for (const [daemonId, daemon] of this.daemons) {
        if (daemon.ws.readyState === 1 && this.sameUser(client.userId, daemon.userId)) {
          this.pendingSessionCreate.set(daemonId, clientWs);
          this.pendingSessionMeta = this.pendingSessionMeta || new Map();
          this.pendingSessionMeta.set(daemonId, { agent_type: msg.agent || 'claude-code', cwd: msg.cwd || '' });
          this.send(daemon.ws, msg);
          return;
        }
      }
      this.send(clientWs, { type: 'error', error: 'no daemons available' });
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

  private async handleReplay(clientWs: WebSocket, sessionId: string, lastSeq: number): Promise<void> {
    try {
      const events = await db.getEventsAfter(this.pool, sessionId, lastSeq);
      if (events.length === 0) {
        this.send(clientWs, { type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq });
        return;
      }
      // Send events in batches of 50 to reduce WebSocket frame overhead
      const BATCH = 50;
      for (let i = 0; i < events.length; i += BATCH) {
        const slice = events.slice(i, i + BATCH);
        this.send(clientWs, {
          type: 'replay_batch',
          session_id: sessionId,
          events: slice.map(e => e.payload),
          last_seq: slice[slice.length - 1].id,
        });
      }
      // Signal completion with final seq for incremental replay
      this.send(clientWs, {
        type: 'replay_end',
        session_id: sessionId,
        count: events.length,
        last_seq: events[events.length - 1].id,
      });
    } catch (err) {
      console.error('replay error:', err);
      // Always send replay_end so the client doesn't hang on isLoading
      this.send(clientWs, { type: 'replay_end', session_id: sessionId, count: 0, last_seq: lastSeq });
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
      for (const [, daemon] of this.daemons) {
        console.log('[router] list_daemons iterating daemon', daemon.daemonId, 'daemon.userId:', daemon.userId, 'request.userId:', userId);
        if (!this.sameUser(daemon.userId, userId)) continue;
        const alias = await db.getDaemonAlias(this.pool, daemon.daemonId);
        daemonList.push({
          daemon_id: daemon.daemonId,
          hostname: daemon.hostname,
          agents: daemon.agents,
          daemon_online: true,
          daemon_alias: alias,
          status: 'online',
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
            daemonList.push({
              daemon_id: row.daemon_id,
              hostname: row.hostname,
              agents: row.agents || [],
              daemon_online: false,
              daemon_alias: row.alias,
              status: 'offline',
              last_seen_at: row.last_heartbeat,
            });
          }
        } catch (e) { console.error('list_daemons offline:', e); }
      }
      console.log('[router] list_daemons sending', daemonList.length, 'daemons to user', userId);
    this.send(clientWs, { type: 'daemon_list', daemons: daemonList });
    } catch (err) { console.error('list_daemons error:', err); }
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
