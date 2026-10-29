import { createHash } from 'node:crypto'
import type pg from 'pg'
import { validateDeliveryWithdrawalBatch, type DeliveryWithdrawalBatch } from '../relay/delivery-withdrawal-client.js'

const lock = 'memory-delivery-withdrawal-consumer-v1'
export function createDeliveryWithdrawalConsumer(options: {
  pool: pg.Pool; signal: AbortSignal
  pull(consumerId: string, lastSequence: string): Promise<DeliveryWithdrawalBatch>
  ack(batch: DeliveryWithdrawalBatch): Promise<string>
}) {
  let current: Promise<{ applied: number; skipped: boolean }> | undefined
  return {
    runOnce(): Promise<{ applied: number; skipped: boolean }> {
      if (current) return current
      current = (async () => {
        if (options.signal.aborted) return { applied: 0, skipped: true }
        const client = await options.pool.connect()
        let locked = false
        try {
          locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lock])).rows[0].locked
          if (!locked) return { applied: 0, skipped: true }
          await client.query('INSERT INTO memory_delivery_withdrawal_checkpoint(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING')
          const state = (await client.query('SELECT consumer_id::text,last_sequence::text FROM memory_delivery_withdrawal_checkpoint WHERE singleton')).rows[0]
          const batch = validateDeliveryWithdrawalBatch(await options.pull(state.consumer_id, state.last_sequence), state.consumer_id)
          if (!batch.items.length && BigInt(batch.through_sequence) > BigInt(state.last_sequence)) throw new Error('delivery withdrawal replay gap')
          if (options.signal.aborted) return { applied: 0, skipped: true }
          let applied = 0
          await client.query('BEGIN')
          try {
            for (const item of batch.items) {
              const hash = createHash('sha256').update(JSON.stringify(item)).digest()
              const receipt = await client.query('INSERT INTO memory_delivery_withdrawal_receipts(sequence,payload_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING sequence', [item.sequence, hash])
              if (!receipt.rowCount) {
                const previous = (await client.query('SELECT payload_hash FROM memory_delivery_withdrawal_receipts WHERE sequence=$1', [item.sequence])).rows[0]
                if (!previous?.payload_hash.equals(hash)) throw new Error('delivery withdrawal integrity conflict')
              }
              const result = await client.query(`INSERT INTO memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id)
                VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [item.team_id, item.team_session_id, item.submission_id, item.decision_id])
              applied += result.rowCount ?? 0
            }
            // Empty/nonempty retries may be behind local persistence after a
            // lost ACK; never regress the local durable watermark.
            await client.query(`UPDATE memory_delivery_withdrawal_checkpoint SET last_sequence=GREATEST(last_sequence,$1::bigint),updated_at=clock_timestamp() WHERE singleton`, [batch.through_sequence])
            await client.query('COMMIT')
          } catch (error) { await client.query('ROLLBACK'); throw error }
          if (!options.signal.aborted) {
            const ack = await options.ack(batch)
            if (!/^(0|[1-9][0-9]{0,18})$/.test(ack) || BigInt(ack) < BigInt(batch.through_sequence)) throw new Error('delivery withdrawal ACK mismatch')
            await client.query(`UPDATE memory_delivery_withdrawal_checkpoint SET last_ack_sequence=GREATEST(last_ack_sequence,$1::bigint),updated_at=clock_timestamp() WHERE singleton`, [batch.through_sequence])
          }
          return { applied, skipped: false }
        } finally {
          // A session lock spans network I/O without holding a transaction.
          // Connection loss releases it; another worker can replay committed data.
          try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]) }
          catch (error) { client.release(true); throw error }
          client.release()
        }
      })().finally(() => { current = undefined })
      return current
    },
  }
}
