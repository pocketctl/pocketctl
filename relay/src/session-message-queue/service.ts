import type pg from 'pg'
import { getSessionRuntimePolicy, isSessionDeleted, type SessionRuntimePolicy } from '../db.js'
import { isCollaborationManagedSession } from '../session-message-admissions.js'
import { claimQueue, emptyQueue, mutateQueue, reduceQueueEvent, type QueueState, type QueueItem } from './state.js'

type LockedOperation = (client: pg.PoolClient, state: QueueState, policy: SessionRuntimePolicy) => Promise<void>

export class MessageQueueService {
  private timer?: NodeJS.Timeout
  private ticking = false

  constructor(
    private pool: pg.Pool,
    private online: (daemonId: string, userId: number) => boolean,
    private dispatch: (userId: number, sessionId: string, item: QueueItem) => Promise<string | undefined>,
    private changed: (userId: number, sessionId: string, state: QueueState) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async authorize(client: pg.PoolClient, userId: number, sessionId: string, requireCapability = true): Promise<SessionRuntimePolicy> {
    const db = client as unknown as pg.Pool
    const policy = await getSessionRuntimePolicy(db, sessionId, userId)
    if (!policy?.daemonId) throw Error('queue_unavailable')
    if (!requireCapability) return policy
    if (!['claude-code', 'codex', 'opencode', 'dsh'].includes(policy.agentType)
      || !policy.capabilities.includes('message_queue_v1') || policy.controlMode === 'legacy_read_only'
      || await isSessionDeleted(db, sessionId) || await isCollaborationManagedSession(db, userId, sessionId)) {
      throw Error('queue_unavailable')
    }
    const sub = await client.query('SELECT 1 FROM subagents WHERE agent_id=$1 LIMIT 1', [sessionId])
    if (sub.rows.length) throw Error('queue_unavailable')
    return policy
  }

  async command(userId: number, sessionId: string, command: any): Promise<QueueState> {
    return this.lock(userId, sessionId, async (_client, state, policy) => {
      if (command.action !== 'read') {
        if (!this.online(policy.daemonId!, userId)) throw Error('daemon_offline')
        mutateQueue(state, command)
      }
    })
  }

  async hold(userId: number, sessionId: string): Promise<void> {
    const found = await this.pool.query('SELECT 1 FROM session_message_queues WHERE session_id=$1 AND user_id=$2', [sessionId, userId])
    if (!found.rows.length) return
    await this.lock(userId, sessionId, async (_client, state) => {
      state.blocked = 'stopped'
      state.version++
    }, false)
  }

  private async lock(userId: number, sessionId: string, fn: LockedOperation, requireCapability = true): Promise<QueueState> {
    const client = await this.pool.connect()
    let result: QueueState
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 742))', [sessionId])
      const policy = await this.authorize(client, userId, sessionId, requireCapability)
      const rows = await client.query('SELECT state FROM session_message_queues WHERE session_id=$1 AND user_id=$2 FOR UPDATE', [sessionId, userId])
      if (rows.rows.length) result = rows.rows[0].state
      else {
        const max = await client.query('SELECT COALESCE(MAX(id),0)::text AS id FROM events WHERE session_id=$1', [sessionId])
        result = emptyQueue(!['idle', 'completed', 'exited', 'error', 'killed'].includes(policy.status ?? ''), max.rows[0].id)
        if (['error', 'killed'].includes(policy.status ?? '')) result.blocked = policy.status!
      }
      // Drain the entire bounded history window before permitting dispatch. A
      // page boundary must not mistake an intermediate terminal for current idle.
      let more = true
      while (more) {
        const events = await client.query(`SELECT id::text,event_type,payload FROM events
          WHERE session_id=$1 AND id>$2 AND event_type IN ('turn_status','queue_dispatch_started','user_message_receipt','error')
          ORDER BY id LIMIT 500`, [sessionId, result.cursor])
        for (const event of events.rows) {
          reduceQueueEvent(result, event)
          result.cursor = event.id
          result.version++
        }
        more = events.rows.length === 500
      }
      await fn(client, result, policy)
      await client.query(`INSERT INTO session_message_queues(session_id,user_id,state) VALUES($1,$2,$3)
        ON CONFLICT(session_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`, [sessionId, userId, JSON.stringify(result)])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    this.changed(userId, sessionId, result!)
    return result!
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const rows = await this.pool.query(`SELECT session_id,user_id FROM session_message_queues
        WHERE jsonb_array_length(state->'items')>0 ORDER BY updated_at LIMIT 100`)
      for (const row of rows.rows) {
        try {
          let claimed: QueueItem | undefined
          await this.lock(row.user_id, row.session_id, async (_client, state, policy) => {
            claimed = claimQueue(state, this.online(policy.daemonId!, row.user_id))
          })
          // Commit the dispatch claim first. Crashes/timeouts after this point
          // become unknown; another worker must never resend the same item.
          if (claimed) await this.lock(row.user_id, row.session_id, async (_client, state, policy) => {
            const item = state.items.find(i => i.request_id === claimed!.request_id)
            if (!item || item.state !== 'dispatching') return
            if (state.blocked || !this.online(policy.daemonId!, row.user_id)) {
              item.state = 'pending'
              delete item.request_id
              delete item.started_at
              state.version++
              return
            }
            // Keep the queue lock through routing so stop/cancel is ordered
            // before or after dispatch, never acknowledged while racing it.
            const error = await this.dispatch(row.user_id, row.session_id, claimed!)
            if (error) {
              item.state = 'failed'
              state.blocked = error
              state.version++
            }
          })
        } catch (error) {
          console.error('[message-queue] session reconciliation failed', error instanceof Error ? error.message : 'unknown')
        }
      }
    } catch (error) {
      console.error('[message-queue] tick failed', error instanceof Error ? error.message : 'unknown')
    } finally {
      this.ticking = false
    }
  }
}
