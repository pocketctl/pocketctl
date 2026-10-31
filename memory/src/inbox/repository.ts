import type pg from 'pg'
import type { ExtensionFeedEnvelopeV1 } from '../relay/contracts.js'
import { classifyEnvelope } from '../relay/validation.js'
import { canonicalPayloadHash } from './canonical-json.js'

export class FeedIntegrityError extends Error {
  constructor() {
    super('feed integrity violation: same feed id with a different payload hash')
    this.name = 'FeedIntegrityError'
  }
}

/** Per-event receipts no longer exist below the GC watermark. Never accept
 * such a replay as a new, unverified event or silently ACK it. */
export class FeedReplayExpiredError extends Error {
  constructor() {
    super('inbox replay window expired')
    this.name = 'FeedReplayExpiredError'
  }
}

export interface QuarantinedInput {
  feed_id: string
  error_code: 'unsupported_envelope_version' | 'invalid_envelope' | 'oversized_content' | 'oversized_discovery'
  gap?: ExtensionFeedEnvelopeV1
  raw: unknown
}

/**
 * Durable inbox with ACK-after-commit semantics. One Relay batch commits in a
 * single transaction (validated envelopes + quarantined rows + the projection
 * job + the local checkpoint); only after that transaction commits does the
 * caller-supplied ack run, using the in-memory cursor and lease material —
 * those are never persisted.
 */
export function createInboxRepository(pool: pg.Pool) {
  return {
    async commitBatch(input: {
      installationId: string
      envelopes: ExtensionFeedEnvelopeV1[]
      rawQuarantined: QuarantinedInput[]
      ack: (input: { installation_id: string; cursor: string; lease_token: string }) => Promise<number>
      cursor: string
      leaseToken: string
    }): Promise<number> {
      let maxFeedId = '0'
      let inserted = 0
      try {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          try {
            // Match purge/extraction ordering: all session locks precede the
            // installation lock, even when one batch contains multiple gaps.
            const gaps = input.rawQuarantined.filter(row => row.error_code === 'oversized_content' || row.error_code === 'oversized_discovery')
            for (const row of gaps) {
              if (!row.gap || row.gap.feed_id !== row.feed_id || classifyEnvelope(row.gap).kind !== (row.error_code === 'oversized_discovery' ? 'discovery_gap' : 'content_gap')) throw new Error('invalid_content_gap')
            }
            const sessions = [...new Set(gaps.map(row => row.gap!.subject.session_id!))].sort()
            for (const sessionId of sessions) {
              await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))`, [input.installationId, sessionId])
            }
            await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))`, [input.installationId])
            const installation = await client.query<{gc_feed_id: string}>(`
              SELECT COALESCE(c.gc_feed_id,0)::text AS gc_feed_id FROM memory_installations i
              LEFT JOIN memory_inbox_checkpoints c USING(installation_id)
              WHERE i.installation_id=$1 AND i.relay_status NOT IN ('revoking','revoked')
                AND i.local_status NOT IN ('purging','purged','integrity_error') FOR SHARE OF i`, [input.installationId])
            if (!installation.rowCount) throw new Error('feed_installation_unavailable')
            const gcFeedId = BigInt(installation.rows[0].gc_feed_id)
            for (const row of [...input.envelopes, ...input.rawQuarantined]) {
              if (BigInt(row.feed_id) <= gcFeedId) throw new FeedReplayExpiredError()
            }
            for (const envelope of input.envelopes) {
              const feedId = envelope.feed_id
              maxFeedId = maxDecimal(maxFeedId, feedId)
              const hash = canonicalPayloadHash(envelope)
              const insert = await client.query(`
                INSERT INTO memory_feed_inbox
                  (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
                   session_id, turn_id, event_type, recorded_at, classification, data, payload_hash)
                VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
                ON CONFLICT (installation_id, feed_id) DO NOTHING
              `, [
                input.installationId,
                feedId,
                envelope.envelope_version,
                envelope.topic,
                envelope.source.kind,
                envelope.source.id,
                envelope.subject.session_id,
                envelope.subject.turn_id ?? null,
                envelope.subject.event_type,
                envelope.source.recorded_at,
                JSON.stringify(envelope.classification ?? {}),
                JSON.stringify(envelope.data ?? {}),
                hash,
              ])
              if ((insert.rowCount ?? 0) === 0) {
                await assertReplayHash(client, input.installationId, feedId, hash)
              } else {
                inserted++
              }
            }
            for (const quarantined of input.rawQuarantined) {
              const feedId = quarantined.feed_id
              if (quarantined.error_code === 'oversized_content' || quarantined.error_code === 'oversized_discovery') {
                const tombstone = await client.query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2', [input.installationId, quarantined.gap!.subject.session_id])
                // A later redelivery must not resurrect purged source metadata.
                if (tombstone.rowCount) { maxFeedId = maxDecimal(maxFeedId, feedId); continue }
              }
              maxFeedId = maxDecimal(maxFeedId, feedId)
              const hash = canonicalPayloadHash(quarantined.gap ?? quarantined.raw)
              const insert = await client.query(`
                INSERT INTO memory_feed_inbox
                  (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
                   event_type, recorded_at, data, payload_hash, projection_state, error_code, session_id, turn_id)
                VALUES ($1, $2::bigint, 1, 'quarantined', 'relay', $3, $9, NOW(),
                        $4::jsonb, $5, 'quarantined', $6, $7, $8)
                ON CONFLICT (installation_id, feed_id) DO NOTHING
              `, [
                input.installationId,
                feedId,
                `quarantine-${feedId}`,
                JSON.stringify(quarantined.gap?.quarantine ?? { redacted: true }),
                hash,
                quarantined.error_code,
                quarantined.gap?.subject.session_id ?? null,
                quarantined.gap?.subject.turn_id ?? null,
                quarantined.gap?.subject.event_type ?? 'quarantined',
              ])
              if ((insert.rowCount ?? 0) === 0) {
                await assertReplayHash(client, input.installationId, feedId, hash)
              }
            }

            if (inserted > 0) {
              // Session cleanup can remove inbox rows while their stable
              // project job remains completed. Same-ID redelivery must wake
              // projection again; a running owner's fence stays intact and
              // completeJob observes rerun_required after its current pass.
              await client.query(`
                INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
                VALUES (gen_random_uuid(), $1, 'project_feed', $2, 50, '{}'::jsonb)
                ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
                  state = CASE WHEN memory_jobs.state IN ('completed', 'dead') THEN 'pending' ELSE memory_jobs.state END,
                  available_at = NOW(),
                  attempts = CASE WHEN memory_jobs.state IN ('completed', 'dead') THEN 0 ELSE memory_jobs.attempts END,
                  claimed_by = CASE WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL ELSE memory_jobs.claimed_by END,
                  claim_expires_at = CASE WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL ELSE memory_jobs.claim_expires_at END,
                  completed_at = CASE WHEN memory_jobs.state IN ('completed', 'dead') THEN NULL ELSE memory_jobs.completed_at END,
                  last_error_code = CASE WHEN memory_jobs.state = 'running' THEN 'rerun_required' ELSE NULL END
              `, [input.installationId, `project:${input.installationId}:${maxFeedId}`])
            }
            await client.query(`
              UPDATE memory_installations
              SET last_feed_id = GREATEST(last_feed_id, $2::bigint),
                  last_pull_at = NOW(),
                  updated_at = NOW()
              WHERE installation_id = $1
            `, [input.installationId, maxFeedId])
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          }
        } finally {
          client.release()
        }
      } catch (error) {
        if (error instanceof FeedIntegrityError || error instanceof FeedReplayExpiredError) {
          await pool.query(`
            WITH held AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))
            )
            UPDATE memory_installations
            SET local_status = 'integrity_error', last_error_code = $2, updated_at = NOW()
            FROM held
            WHERE installation_id = $1::uuid
              AND relay_status NOT IN ('revoking','revoked') AND local_status NOT IN ('purging','purged')
          `, [input.installationId, error instanceof FeedReplayExpiredError ? 'inbox_replay_expired' : 'feed_integrity'])
        }
        throw error
      }

      // Durable commit done — now (and only now) tell Relay. An ack failure
      // throws so the loop retries the ack on the next redelivery, where the
      // rows above collapse idempotently.
      const ackFeedId = await input.ack({
        installation_id: input.installationId,
        cursor: input.cursor,
        lease_token: input.leaseToken,
      })
      if (!Number.isSafeInteger(ackFeedId) || ackFeedId < 0) throw new Error('invalid_ack_feed_id')
      await pool.query(`
        WITH held AS MATERIALIZED (
          SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))
        )
        INSERT INTO memory_inbox_checkpoints(installation_id,last_ack_feed_id)
        SELECT i.installation_id,$2::bigint FROM memory_installations i CROSS JOIN held
        WHERE i.installation_id=$1::uuid AND i.relay_status NOT IN ('revoking','revoked')
          AND i.local_status NOT IN ('purging','purged')
        ON CONFLICT(installation_id) DO UPDATE SET
          last_ack_feed_id=GREATEST(memory_inbox_checkpoints.last_ack_feed_id,EXCLUDED.last_ack_feed_id),
          updated_at=NOW()
      `, [input.installationId, String(ackFeedId)])
      await pool.query(`
        UPDATE memory_installations
        SET last_ack_at = NOW(),
            local_status = CASE
              WHEN (local_status IN ('discovering', 'syncing')
                    OR (local_status = 'degraded' AND last_error_code IS NULL))
                AND snapshot_required = FALSE THEN 'ready'
              ELSE local_status
            END,
            last_error_code = CASE
              WHEN (local_status IN ('discovering', 'syncing')
                    OR (local_status = 'degraded' AND last_error_code IS NULL))
                AND snapshot_required = FALSE THEN NULL
              ELSE last_error_code
            END,
            updated_at = NOW()
        WHERE installation_id = $1
      `, [input.installationId])
      return inserted
    },
  }
}

export type InboxRepository = ReturnType<typeof createInboxRepository>

function maxDecimal(left: string, right: string): string {
  return BigInt(right) > BigInt(left) ? right : left
}

async function assertReplayHash(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  feedId: string,
  incomingHash: Buffer,
): Promise<void> {
  const existing = await client.query<{ payload_hash: Buffer }>(`
    SELECT payload_hash FROM memory_feed_inbox
    WHERE installation_id = $1 AND feed_id = $2::bigint
    FOR UPDATE
  `, [installationId, feedId])
  if (!existing.rows[0]?.payload_hash.equals(incomingHash)) throw new FeedIntegrityError()
}
