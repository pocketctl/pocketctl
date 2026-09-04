import type pg from 'pg'
import type { ExtensionFeedEnvelopeV1 } from '../relay/contracts.js'
import { canonicalPayloadHash } from './canonical-json.js'

export class FeedIntegrityError extends Error {
  constructor() {
    super('feed integrity violation: same feed id with a different payload hash')
    this.name = 'FeedIntegrityError'
  }
}

export interface QuarantinedInput {
  feed_id: string
  error_code: 'unsupported_envelope_version' | 'invalid_envelope'
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
              maxFeedId = maxDecimal(maxFeedId, feedId)
              const hash = canonicalPayloadHash(quarantined.raw)
              const insert = await client.query(`
                INSERT INTO memory_feed_inbox
                  (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
                   event_type, recorded_at, data, payload_hash, projection_state, error_code)
                VALUES ($1, $2::bigint, 1, 'quarantined', 'relay', $3, 'quarantined', NOW(),
                        $4::jsonb, $5, 'quarantined', $6)
                ON CONFLICT (installation_id, feed_id) DO NOTHING
              `, [
                input.installationId,
                feedId,
                `quarantine-${feedId}`,
                JSON.stringify({ redacted: true }),
                hash,
                quarantined.error_code,
              ])
              if ((insert.rowCount ?? 0) === 0) {
                await assertReplayHash(client, input.installationId, feedId, hash)
              }
            }

            if (input.envelopes.length > 0) {
              await client.query(`
                INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
                VALUES (gen_random_uuid(), $1, 'project_feed', $2, 50, '{}'::jsonb)
                ON CONFLICT DO NOTHING
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
        if (error instanceof FeedIntegrityError) {
          await pool.query(`
            UPDATE memory_installations
            SET local_status = 'integrity_error', last_error_code = 'feed_integrity', updated_at = NOW()
            WHERE installation_id = $1
          `, [input.installationId])
        }
        throw error
      }

      // Durable commit done — now (and only now) tell Relay. An ack failure
      // throws so the loop retries the ack on the next redelivery, where the
      // rows above collapse idempotently.
      await input.ack({
        installation_id: input.installationId,
        cursor: input.cursor,
        lease_token: input.leaseToken,
      })
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
