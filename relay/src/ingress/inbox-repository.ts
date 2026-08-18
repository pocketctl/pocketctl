import type pg from 'pg'
import type { AckCheckpoint, IngressEnvelope, PriorityClass } from './types.js'
import type { MaterializationContext } from '../materialization/types.js'
import { inboxClaimSeconds, inboxPoolWait } from '../metrics.js'

export interface InboxRow {
  inboxId: number;
  userId: number | null;
  daemonId: string;
  daemonGeneration: number;
  seq: number;
  dedupKey: string;
  sessionId: string | null;
  eventType: string;
  priorityClass: number;
  schemaVersion: number;
  occurredAt: Date | null;
  receivedAt: Date;
  payload: Record<string, unknown>;
  materializationContext: MaterializationContext;
  status: number;
  attempts: number;
  availableAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  completedAt: Date | null;
  materializedEventId: number | null;
  lastError: string | null;
}

export interface ClaimBatchOptions {
  workerId: string;
  limit: number;
  shardCount: number;
  shardIndex: number;
}

export interface ClaimFence {
  inboxId: number;
  attempts: number;
}

export class LostClaimError extends Error {
  constructor(readonly inboxId: number) {
    super('inbox claim lost')
    this.name = 'LostClaimError'
  }
}

interface CheckpointRow {
  daemon_id: string;
  daemon_generation: string;
  ack_seq: string;
}

interface CanonicalRow {
  inbox_id: string;
  user_id: number | null;
  dedup_key: string;
}

interface ExistingReceiptRow {
  inbox_id: string | null;
  daemon_id: string;
  daemon_generation: string;
  seq: string;
  user_id: number | null;
  dedup_key: string | null;
}

interface ClaimedRow {
  inbox_id: string;
  user_id: number | null;
  daemon_id: string;
  daemon_generation: string;
  seq: string;
  dedup_key: string;
  session_id: string | null;
  event_type: string;
  priority_class: number;
  schema_version: number;
  occurred_at: Date | null;
  received_at: Date;
  payload: Record<string, unknown>;
  materialization_context: MaterializationContext;
  status: number;
  attempts: number;
  available_at: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
  completed_at: Date | null;
  materialized_event_id: string | null;
  last_error: string | null;
}

const PRIORITY_CLASS: Record<PriorityClass, number> = {
  control: 0,
  live: 1,
  replay: 2,
  aggregate: 3,
}

function checkpointKey(daemonId: string, daemonGeneration: number): string {
  return `${daemonId}\0${daemonGeneration}`
}

function canonicalKey(userId: number | null, dedupKey: string): string {
  return JSON.stringify([userId ?? 0, dedupKey])
}

function transportKey(event: IngressEnvelope): string {
  return `${checkpointKey(event.daemonId, event.daemonGeneration)}\0${event.seq}`
}

function receiptTransportKey(row: ExistingReceiptRow): string {
  return `${checkpointKey(row.daemon_id, Number(row.daemon_generation))}\0${row.seq}`
}

function toCheckpoint(row: CheckpointRow): AckCheckpoint {
  return {
    daemonId: row.daemon_id,
    daemonGeneration: Number(row.daemon_generation),
    ackSeq: Number(row.ack_seq),
  }
}

function toInboxRow(row: ClaimedRow): InboxRow {
  return {
    inboxId: Number(row.inbox_id),
    userId: row.user_id,
    daemonId: row.daemon_id,
    daemonGeneration: Number(row.daemon_generation),
    seq: Number(row.seq),
    dedupKey: row.dedup_key,
    sessionId: row.session_id,
    eventType: row.event_type,
    priorityClass: row.priority_class,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    payload: row.payload,
    materializationContext: row.materialization_context ?? {},
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    completedAt: row.completed_at,
    materializedEventId: row.materialized_event_id === null ? null : Number(row.materialized_event_id),
    lastError: row.last_error,
  }
}

async function lockCheckpoint(
  client: pg.PoolClient,
  daemonId: string,
  daemonGeneration: number,
): Promise<AckCheckpoint> {
  await client.query(
    `INSERT INTO daemon_ack_checkpoint (daemon_id, daemon_generation, ack_seq)
     VALUES ($1, $2, 0)
     ON CONFLICT (daemon_id, daemon_generation) DO NOTHING`,
    [daemonId, daemonGeneration],
  )
  const result = await client.query<CheckpointRow>(
    `SELECT daemon_id, daemon_generation, ack_seq
     FROM daemon_ack_checkpoint
     WHERE daemon_id = $1 AND daemon_generation = $2
     FOR UPDATE`,
    [daemonId, daemonGeneration],
  )
  const row = result.rows[0]
  if (!row) throw new Error('checkpoint row unavailable after initialization')
  return toCheckpoint(row)
}

async function upsertCanonicalInboxRows(
  client: pg.PoolClient,
  events: IngressEnvelope[],
): Promise<Map<string, number>> {
  const unique = new Map<string, IngressEnvelope>()
  for (const event of events) {
    const key = canonicalKey(event.userId, event.dedupKey)
    if (!unique.has(key)) unique.set(key, event)
  }
  if (unique.size === 0) return new Map()

  const values: unknown[] = []
  const tuples: string[] = []
  const orderedCanonicalEvents = [...unique.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, event]) => event)
  for (const event of orderedCanonicalEvents) {
    const offset = values.length
    values.push(
      event.userId,
      event.daemonId,
      event.daemonGeneration,
      event.seq,
      event.dedupKey,
      event.sessionId,
      event.eventType,
      PRIORITY_CLASS[event.priority],
      event.receivedAt,
      event.payload,
      event.materializationContext,
    )
    tuples.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, `
      + `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`,
    )
  }
  const result = await client.query<CanonicalRow>(
    `INSERT INTO event_inbox
       (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id, event_type,
        priority_class, received_at, payload, materialization_context)
     VALUES ${tuples.join(', ')}
     ON CONFLICT ((COALESCE(user_id, 0)), dedup_key)
     DO UPDATE SET dedup_key = EXCLUDED.dedup_key
     RETURNING inbox_id, user_id, dedup_key`,
    values,
  )
  return new Map(result.rows.map((row) => [
    canonicalKey(row.user_id, row.dedup_key),
    Number(row.inbox_id),
  ]))
}

async function lockAndFilterExistingReceipts(
  client: pg.PoolClient,
  events: IngressEnvelope[],
): Promise<IngressEnvelope[]> {
  const coordinates = new Map<string, IngressEnvelope>()
  for (const event of events) {
    const key = transportKey(event)
    const existing = coordinates.get(key)
    if (existing && canonicalKey(existing.userId, existing.dedupKey) !== canonicalKey(event.userId, event.dedupKey)) {
      throw new Error('transport coordinate canonical mismatch')
    }
    if (!existing) coordinates.set(key, event)
  }
  if (coordinates.size === 0) return []

  const values: unknown[] = []
  const tuples: string[] = []
  for (const event of coordinates.values()) {
    const offset = values.length
    values.push(event.daemonId, event.daemonGeneration, event.seq)
    tuples.push(`($${offset + 1}::varchar, $${offset + 2}::bigint, $${offset + 3}::bigint)`)
  }
  const existing = await client.query<ExistingReceiptRow>(
    `WITH incoming(daemon_id, daemon_generation, seq) AS (
       VALUES ${tuples.join(', ')}
     )
     SELECT receipt.inbox_id, receipt.daemon_id, receipt.daemon_generation, receipt.seq,
            inbox.user_id, inbox.dedup_key
     FROM incoming
     JOIN event_inbox_receipt receipt
       ON receipt.daemon_id = incoming.daemon_id
      AND receipt.daemon_generation = incoming.daemon_generation
      AND receipt.seq = incoming.seq
     LEFT JOIN event_inbox inbox ON inbox.inbox_id = receipt.inbox_id
     ORDER BY inbox.inbox_id ASC, receipt.receipt_id ASC
     FOR UPDATE OF receipt`,
    values,
  )

  const existingKeys = new Set<string>()
  for (const row of existing.rows) {
    const key = receiptTransportKey(row)
    const event = coordinates.get(key)
    const matchesReceiptOnly = row.inbox_id === null && event?.receiptOnly === true
    const matchesCanonical = row.inbox_id !== null && event?.receiptOnly !== true
      && row.dedup_key !== null
      && canonicalKey(row.user_id, row.dedup_key) === canonicalKey(event?.userId ?? null, event?.dedupKey ?? '')
    if (!event || (!matchesReceiptOnly && !matchesCanonical)) {
      throw new Error('transport coordinate canonical mismatch')
    }
    existingKeys.add(key)
  }
  return [...coordinates.entries()]
    .filter(([key]) => !existingKeys.has(key))
    .map(([, event]) => event)
}

async function insertTransportReceipts(
  client: pg.PoolClient,
  events: IngressEnvelope[],
  inboxIds: Map<string, number>,
): Promise<void> {
  if (events.length === 0) return
  const values: unknown[] = []
  const tuples: string[] = []
  for (const event of events) {
    const inboxId = event.receiptOnly
      ? null
      : inboxIds.get(canonicalKey(event.userId, event.dedupKey))
    if (!event.receiptOnly && inboxId === undefined) {
      throw new Error('canonical inbox row unavailable for receipt')
    }
    const offset = values.length
    values.push(inboxId, event.daemonId, event.daemonGeneration, event.seq, event.receivedAt)
    tuples.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`)
  }
  await client.query(
    `INSERT INTO event_inbox_receipt
       (inbox_id, daemon_id, daemon_generation, seq, received_at)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (daemon_id, daemon_generation, seq) DO NOTHING`,
    values,
  )
}

async function advanceContiguousCheckpoint(
  client: pg.PoolClient,
  checkpoint: AckCheckpoint,
): Promise<AckCheckpoint> {
  const contiguous = await client.query<{ ack_seq: string }>(
    `WITH RECURSIVE contiguous(seq) AS (
       SELECT $3::bigint
       UNION ALL
       SELECT receipt.seq
       FROM contiguous
       JOIN event_inbox_receipt receipt
         ON receipt.daemon_id = $1
        AND receipt.daemon_generation = $2
        AND receipt.seq = contiguous.seq + 1
     )
     SELECT MAX(seq)::text AS ack_seq FROM contiguous`,
    [checkpoint.daemonId, checkpoint.daemonGeneration, checkpoint.ackSeq],
  )
  const ackSeq = Number(contiguous.rows[0]?.ack_seq ?? checkpoint.ackSeq)
  if (ackSeq !== checkpoint.ackSeq) {
    await client.query(
      `UPDATE daemon_ack_checkpoint
       SET ack_seq = $3, updated_at = NOW()
       WHERE daemon_id = $1 AND daemon_generation = $2`,
      [checkpoint.daemonId, checkpoint.daemonGeneration, ackSeq],
    )
  }
  return { ...checkpoint, ackSeq }
}

export class InboxRepository {
  constructor(private readonly pool: pg.Pool) {}

  async persistBatch(events: IngressEnvelope[]): Promise<Map<string, AckCheckpoint>> {
    const poolWaitStartedAt = performance.now()
    const client = await this.pool.connect()
    inboxPoolWait.observe(Math.max(0, (performance.now() - poolWaitStartedAt) / 1000))
    try {
      await client.query('BEGIN')

      const generationInputs = new Map<string, { daemonId: string; daemonGeneration: number }>()
      for (const event of events) {
        generationInputs.set(checkpointKey(event.daemonId, event.daemonGeneration), {
          daemonId: event.daemonId,
          daemonGeneration: event.daemonGeneration,
        })
      }
      const orderedGenerations = [...generationInputs.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

      const checkpoints = new Map<string, AckCheckpoint>()
      for (const [key, input] of orderedGenerations) {
        checkpoints.set(key, await lockCheckpoint(client, input.daemonId, input.daemonGeneration))
      }

      const unackedEvents = events.filter((event) => {
        const checkpoint = checkpoints.get(checkpointKey(event.daemonId, event.daemonGeneration))
        return Boolean(checkpoint && event.seq > checkpoint.ackSeq)
      })
      const pendingEvents = await lockAndFilterExistingReceipts(client, unackedEvents)

      const inboxIds = await upsertCanonicalInboxRows(
        client,
        pendingEvents.filter((event) => !event.receiptOnly),
      )
      await insertTransportReceipts(client, pendingEvents, inboxIds)

      for (const [key, checkpoint] of checkpoints) {
        checkpoints.set(key, await advanceContiguousCheckpoint(client, checkpoint))
      }

      await client.query('COMMIT')
      return checkpoints
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async seedCheckpoint(
    daemonId: string,
    daemonGeneration: number,
    ackedSeq: number,
  ): Promise<AckCheckpoint> {
    const result = await this.pool.query<CheckpointRow>(
      `INSERT INTO daemon_ack_checkpoint (daemon_id, daemon_generation, ack_seq)
       VALUES ($1, $2, $3)
       ON CONFLICT (daemon_id, daemon_generation) DO UPDATE SET
         ack_seq = GREATEST(daemon_ack_checkpoint.ack_seq, EXCLUDED.ack_seq),
         updated_at = CASE
           WHEN EXCLUDED.ack_seq > daemon_ack_checkpoint.ack_seq THEN NOW()
           ELSE daemon_ack_checkpoint.updated_at
         END
       RETURNING daemon_id, daemon_generation, ack_seq`,
      [daemonId, daemonGeneration, ackedSeq],
    )
    return toCheckpoint(result.rows[0])
  }

  async claimBatch(options: ClaimBatchOptions): Promise<InboxRow[]> {
    const limit = Math.max(0, Math.trunc(options.limit))
    const shardCount = Math.trunc(options.shardCount)
    const shardIndex = Math.trunc(options.shardIndex)
    if (limit === 0) return []
    if (shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) {
      throw new Error('invalid inbox shard')
    }
    const claimStartedAt = performance.now()
    try {
      const result = await this.pool.query<ClaimedRow>(
      `WITH stream_heads AS MATERIALIZED (
         SELECT DISTINCT ON (daemon_id, daemon_generation)
                inbox_id
         FROM event_inbox
         WHERE status IN (0, 1)
         ORDER BY daemon_id ASC,
                  daemon_generation ASC,
                  seq ASC,
                  inbox_id ASC
       ),
       candidates AS (
         SELECT inbox.inbox_id
         FROM event_inbox inbox
         JOIN stream_heads head
           ON head.inbox_id = inbox.inbox_id
         WHERE inbox.status = 0
           AND inbox.available_at <= NOW()
           AND MOD(ABS(hashtext(inbox.daemon_id)::bigint), $2::bigint) = $3::bigint
         ORDER BY inbox.priority_class ASC,
                  inbox.received_at ASC,
                  inbox.inbox_id ASC
         FOR UPDATE OF inbox SKIP LOCKED
         LIMIT $4
       ),
       claimed AS (
       UPDATE event_inbox inbox
       SET status = 1,
           attempts = inbox.attempts + 1,
           claimed_at = NOW(),
           claimed_by = $1,
           last_error = NULL
       FROM candidates
       WHERE inbox.inbox_id = candidates.inbox_id
         AND inbox.status = 0
       RETURNING inbox.*
       )
       SELECT * FROM claimed
       ORDER BY priority_class ASC, received_at ASC, inbox_id ASC`,
        [options.workerId, shardCount, shardIndex, limit],
      )
      return result.rows.map(toInboxRow)
    } finally {
      inboxClaimSeconds.observe(Math.max(0, (performance.now() - claimStartedAt) / 1000))
    }
  }

  async reschedule(
    inboxId: number,
    attempts: number,
    availableAt: Date,
    error: string,
    workerId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE event_inbox
       SET status = 0,
           attempts = $2,
           available_at = $3,
           claimed_at = NULL,
           claimed_by = NULL,
           completed_at = NULL,
           last_error = $4
       WHERE inbox_id = $1
         AND status = 1
         AND claimed_by = $5
         AND attempts = $2`,
      [inboxId, attempts, availableAt, error, workerId],
    )
    if (result.rowCount !== 1) throw new LostClaimError(inboxId)
  }

  async renewClaims(claims: ClaimFence[], workerId: string): Promise<Set<number>> {
    if (claims.length === 0) return new Set()
    const result = await this.pool.query<{ inbox_id: string }>(
      `WITH claim_fences(inbox_id, attempts) AS (
         SELECT * FROM UNNEST($1::bigint[], $2::int[])
       )
       UPDATE event_inbox inbox
       SET claimed_at = NOW()
       FROM claim_fences
       WHERE inbox.inbox_id = claim_fences.inbox_id
         AND inbox.attempts = claim_fences.attempts
         AND inbox.status = 1
         AND inbox.claimed_by = $3
       RETURNING inbox.inbox_id`,
      [
        claims.map((claim) => claim.inboxId),
        claims.map((claim) => claim.attempts),
        workerId,
      ],
    )
    return new Set(result.rows.map((row) => Number(row.inbox_id)))
  }

  async complete(inboxId: number, eventId: number | null, workerId: string, attempts: number): Promise<void> {
    const result = await this.pool.query(
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
    if (result.rowCount !== 1) throw new LostClaimError(inboxId)
  }

  async deadLetter(inboxId: number, attempts: number, error: string, workerId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE event_inbox
       SET status = 3,
           attempts = $2,
           claimed_at = NULL,
           claimed_by = NULL,
           completed_at = NOW(),
           last_error = $3
       WHERE inbox_id = $1
         AND status = 1
         AND claimed_by = $4
         AND attempts = $2`,
      [inboxId, attempts, error, workerId],
    )
    if (result.rowCount !== 1) throw new LostClaimError(inboxId)
  }

  async resetStaleClaims(leaseMs = 300_000, limit = 1_000): Promise<number> {
    const boundedLeaseMs = Math.max(1, Math.trunc(leaseMs))
    const boundedLimit = Math.max(1, Math.trunc(limit))
    const result = await this.pool.query(
      `WITH stale AS (
         SELECT inbox_id
         FROM event_inbox
         WHERE status = 1
           AND claimed_at < NOW() - make_interval(secs => $1::double precision / 1000)
         ORDER BY claimed_at ASC, inbox_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE event_inbox inbox
       SET status = 0,
           available_at = NOW(),
           claimed_at = NULL,
           claimed_by = NULL,
           completed_at = NULL
       FROM stale
       WHERE inbox.inbox_id = stale.inbox_id`,
      [boundedLeaseMs, boundedLimit],
    )
    return result.rowCount ?? 0
  }
}
