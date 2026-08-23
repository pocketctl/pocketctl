import type pg from 'pg'
import { LostClaimError } from '../ingress/inbox-repository.js'
import type { MaterializedAudience, MaterializedDelivery } from './types.js'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_POLL_INTERVAL_MS = 1_000

export interface RealtimeOutboxRow {
  outboxId: number;
  inboxId: number;
  daemonId: string;
  eventId: number | null;
  userId: number | null;
  audience: MaterializedAudience;
  sessionId: string | null;
  requestId: string | null;
  ordinal: number;
  deliveryKey: string;
  type: string;
  payload: Record<string, unknown>;
}

type DurableDelivery = MaterializedDelivery & { inboxId: number }

export interface RealtimeOutboxClaim {
  rows: RealtimeOutboxRow[];
  markDelivered(outboxId: number): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface RealtimeOutboxRepositoryLike {
  claimUndelivered(limit: number): Promise<RealtimeOutboxClaim>;
  subscribe?(wake: () => void): Promise<() => Promise<void>>;
}

function deliveryOrdinal(deliveryKey: string): number {
  const value = Number.parseInt(deliveryKey.slice(deliveryKey.lastIndexOf(':') + 1), 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function toOutboxRow(row: Record<string, unknown>): RealtimeOutboxRow {
  return {
    outboxId: Number(row.outbox_id),
    inboxId: Number(row.inbox_id),
    daemonId: String(row.daemon_id),
    eventId: row.event_id === null ? null : Number(row.event_id),
    userId: row.user_id === null ? null : Number(row.user_id),
    audience: String(row.audience) as MaterializedAudience,
    sessionId: row.session_id === null ? null : String(row.session_id),
    requestId: row.request_id === null ? null : String(row.request_id),
    ordinal: deliveryOrdinal(String(row.delivery_key)),
    deliveryKey: String(row.delivery_key),
    type: String(row.event_type),
    payload: row.payload as Record<string, unknown>,
  }
}

export class RealtimeOutboxWriter {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(client: Pick<pg.PoolClient, 'query'>, deliveries: DurableDelivery[]): Promise<void> {
    for (const delivery of deliveries) {
      await client.query(
        `INSERT INTO realtime_outbox
           (inbox_id, delivery_key, event_id, user_id, session_id, event_type, audience, request_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (inbox_id, delivery_key) DO NOTHING`,
        [
          delivery.inboxId,
          delivery.deliveryKey,
          delivery.eventId,
          delivery.userId,
          delivery.sessionId,
          delivery.type,
          delivery.audience,
          delivery.requestId,
          JSON.stringify(delivery.payload),
        ],
      )
    }
  }

  async complete(
    inboxId: number,
    eventId: number | null,
    deliveries: MaterializedDelivery[],
    workerId: string,
    attempts: number,
  ): Promise<void> {
    const durableDeliveries = deliveries.map((delivery) => ({
      ...delivery,
      inboxId,
    }))
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const completed = await client.query(
        `UPDATE event_inbox
         SET status = 2,
             completed_at = NOW(),
             materialized_event_id = $2,
             claimed_at = NULL,
             claimed_by = NULL,
             last_error = NULL
         WHERE inbox_id = $1
           AND status = 1
           AND claimed_by = $3
           AND attempts = $4`,
        [inboxId, eventId, workerId, attempts],
      )
      if (completed.rowCount !== 1) throw new LostClaimError(inboxId)
      await this.enqueue(client, durableDeliveries)
      await client.query(`SELECT pg_notify('pocketctl_realtime', $1)`, [String(inboxId)])
      await client.query('COMMIT')
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the transaction failure.
      }
      throw error
    } finally {
      client.release()
    }
  }
}

export class RealtimeOutboxRepository implements RealtimeOutboxRepositoryLike {
  constructor(private readonly pool: pg.Pool) {}

  async claimUndelivered(limit = DEFAULT_BATCH_SIZE): Promise<RealtimeOutboxClaim> {
    const client = await this.pool.connect()
    let closed = false
    const close = (action: 'COMMIT' | 'ROLLBACK') => async (): Promise<void> => {
      if (closed) return
      closed = true
      try {
        await client.query(action)
      } finally {
        client.release()
      }
    }
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `SELECT o.outbox_id, o.inbox_id, i.daemon_id, o.event_id, o.user_id,
                o.session_id, o.event_type, o.audience, o.request_id,
                o.delivery_key, o.payload
         FROM realtime_outbox o
         JOIN event_inbox i ON i.inbox_id = o.inbox_id
         WHERE o.delivered_at IS NULL
         ORDER BY o.created_at, o.outbox_id
         FOR UPDATE OF o SKIP LOCKED
         LIMIT $1`,
        [Math.max(1, Math.trunc(limit))],
      )
      return {
        rows: result.rows.map(toOutboxRow),
        markDelivered: async (outboxId) => {
          const marked = await client.query(
            `UPDATE realtime_outbox SET delivered_at = NOW()
             WHERE outbox_id = $1 AND delivered_at IS NULL`,
            [outboxId],
          )
          if (marked.rowCount !== 1) throw new Error('realtime outbox claim lost')
        },
        commit: close('COMMIT'),
        rollback: close('ROLLBACK'),
      }
    } catch (error) {
      if (!closed) {
        closed = true
        try {
          await client.query('ROLLBACK')
        } finally {
          client.release()
        }
      }
      throw error
    }
  }

  async subscribe(wake: () => void): Promise<() => Promise<void>> {
    const client = await this.pool.connect()
    const onNotification = (notification: { channel: string }) => {
      if (notification.channel === 'pocketctl_realtime') wake()
    }
    const onError = (error: Error) => {
      console.error('[realtime-outbox] listener unavailable', { errorName: error.name })
    }
    client.on('notification', onNotification)
    client.on('error', onError)
    try {
      await client.query('LISTEN pocketctl_realtime')
    } catch (error) {
      client.off('notification', onNotification)
      client.off('error', onError)
      client.release()
      throw error
    }
    return async () => {
      client.off('notification', onNotification)
      client.off('error', onError)
      try {
        await client.query('UNLISTEN pocketctl_realtime')
      } finally {
        client.release()
      }
    }
  }
}

export interface RealtimeOutboxConsumerOptions {
  repository: RealtimeOutboxRepositoryLike;
  /** `false` means no eligible recipient exists yet; keep the row pending. */
  deliver(delivery: RealtimeOutboxRow): boolean | void | Promise<boolean | void>;
  batchSize?: number;
  pollIntervalMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class RealtimeOutboxConsumer {
  private readonly batchSize: number
  private readonly pollIntervalMs: number
  private readonly setTimer: NonNullable<RealtimeOutboxConsumerOptions['setTimer']>
  private readonly clearTimer: NonNullable<RealtimeOutboxConsumerOptions['clearTimer']>
  private activeRun?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private activeSubscription?: { generation: number; unsubscribe?: () => Promise<void> }
  private readonly pendingStarts = new Map<number, Promise<void>>()
  private generation = 0
  private stopped = true

  constructor(private readonly options: RealtimeOutboxConsumerOptions) {
    this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE))
    this.pollIntervalMs = Math.max(1, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return
    this.timer = this.setTimer(() => {
      this.timer = undefined
      void this.runOnce()
        .catch((error) => console.error('[realtime-outbox] delivery failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        }))
        .finally(() => this.schedule(this.pollIntervalMs))
    }, delayMs)
    this.timer.unref?.()
  }

  private wake(generation: number): void {
    if (this.stopped || this.activeSubscription?.generation !== generation) return
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    this.schedule(0)
  }

  async runOnce(): Promise<void> {
    if (this.activeRun) return this.activeRun
    const run = (async () => {
      const claim = await this.options.repository.claimUndelivered(this.batchSize)
      try {
        for (const delivery of claim.rows) {
          if (await this.options.deliver(delivery) !== false) {
            await claim.markDelivered(delivery.outboxId)
          }
        }
        await claim.commit()
      } catch (error) {
        await claim.rollback()
        throw error
      }
    })()
    this.activeRun = run
    try {
      await run
    } finally {
      if (this.activeRun === run) this.activeRun = undefined
    }
  }

  start(): Promise<void> {
    if (!this.stopped) return this.pendingStarts.get(this.generation) ?? Promise.resolve()
    this.stopped = false
    const generation = ++this.generation
    const run = (async () => {
      try {
        const unsubscribe = await this.options.repository.subscribe?.(() => this.wake(generation))
        if (this.stopped || generation !== this.generation) {
          await unsubscribe?.()
          return
        }
        const previous = this.activeSubscription
        this.activeSubscription = { generation, unsubscribe }
        await previous?.unsubscribe?.()
        this.schedule(0)
      } catch (error) {
        if (generation === this.generation) this.stopped = true
        throw error
      }
    })()
    this.pendingStarts.set(generation, run)
    void run.finally(() => {
      if (this.pendingStarts.get(generation) === run) this.pendingStarts.delete(generation)
    }).catch(() => undefined)
    return run
  }

  async stop(): Promise<void> {
    ++this.generation
    this.stopped = true
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    const activeSubscription = this.activeSubscription
    this.activeSubscription = undefined
    const pendingStarts = [...this.pendingStarts.values()]
    let failure: unknown
    try {
      await activeSubscription?.unsubscribe?.()
      const starts = await Promise.allSettled(pendingStarts)
      const rejectedStart = starts.find((result) => result.status === 'rejected')
      if (rejectedStart?.status === 'rejected') throw rejectedStart.reason
      await this.activeRun
    } catch (error) {
      failure = error
    }
    if (failure !== undefined) throw failure
  }
}
