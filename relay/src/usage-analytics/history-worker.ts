import type pg from 'pg'
import { buildHistoryDay } from './history-build.js'

const intervalMs = 5_000
const retrySeconds = 60
const batchSize = 8
const retentionBatchSize = 64
const utcToday = "(statement_timestamp() AT TIME ZONE 'UTC')::date"
const dirty = "(built_revision IS DISTINCT FROM revision OR (tokens<>'[]'::jsonb AND token_composition_revision IS DISTINCT FROM revision))"
const key = 'owner_user_id=$1 AND daemon_id=$2 AND day=$3::date'

export interface HistoryDayKey {
  owner_user_id: number
  daemon_id: string
  day: string
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code
}

/** Return false if the key is already built, skipped by another worker, or raced a source write. */
export async function refreshHistoryDay(pool: pg.Pool, day: HistoryDayKey): Promise<boolean> {
  const client = await pool.connect()
  const values = [day.owner_user_id, day.daemon_id, day.day]
  let revision: string | undefined
  let discardClient = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'")
    // Only refreshers take this advisory lock. Source transactions can still
    // commit during the build, in which case REPEATABLE READ protects publish.
    const lock = await client.query<{ acquired: boolean }>(`
      SELECT pg_try_advisory_xact_lock(hashtextextended(
        jsonb_build_array('usage-history-day', $1::int, $2::text, $3::text)::text, 0)) AS acquired
    `, values)
    if (!lock.rows[0].acquired) {
      await client.query('ROLLBACK')
      return false
    }
    const state = await client.query<{ revision: string }>(`
      SELECT revision::text FROM public.usage_history_days
      WHERE ${key} AND ${dirty} AND retry_at<=statement_timestamp()
        AND day BETWEEN ${utcToday}-364 AND ${utcToday}-1
    `, values)
    revision = state.rows[0]?.revision
    if (!revision) {
      await client.query('ROLLBACK')
      return false
    }
    const data = await buildHistoryDay(client, day.owner_user_id, day.daemon_id, day.day)
    const update = await client.query(`
      UPDATE public.usage_history_days
      SET built_revision=revision, token_composition_revision=revision, tokens=$5::jsonb, residual=$6::jsonb, calls=$7::jsonb, skills=$8::jsonb,
        retry_at='-infinity'
      WHERE ${key} AND revision=$4::bigint AND ${dirty}
    `, [...values, revision, data.tokens, data.residual, data.calls, data.skills])
    await client.query('COMMIT')
    return update.rowCount === 1
  } catch (error) {
    try {
      await client.query('ROLLBACK')
      if (errorCode(error) === '40001') return false
      if (revision !== undefined) {
        await client.query('BEGIN')
        await client.query("SET LOCAL statement_timeout='1s'; SET LOCAL lock_timeout='500ms'")
        await client.query(`
          UPDATE public.usage_history_days SET retry_at=statement_timestamp()+make_interval(secs=>$5)
          WHERE ${key} AND revision=$4::bigint AND ${dirty}
        `, [...values, revision, retrySeconds])
        await client.query('COMMIT')
      }
    } catch {
      // Discard a connection whose cleanup failed, so it cannot leave an open
      // transaction in the pool. The unbuilt key remains eligible for retry.
      discardClient = true
    }
    throw error
  } finally {
    client.release(discardClient)
  }
}

async function pruneHistoryDays(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  await pool.query(`
    WITH expired AS (
      SELECT owner_user_id, daemon_id, day FROM public.usage_history_days
      WHERE day < ${utcToday}-364
      ORDER BY day, owner_user_id, daemon_id LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.usage_history_days h USING expired e
    WHERE (h.owner_user_id,h.daemon_id,h.day)=(e.owner_user_id,e.daemon_id,e.day)
  `, [retentionBatchSize])
}

export function createHistoryWorker(pool: pg.Pool) {
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: Promise<void> | undefined
  let nextPrune = 0

  const reportError = (error: unknown): void => {
    console.error('[usage-history] refresh failed', { code: errorCode(error) })
  }

  const run = async (): Promise<void> => {
    const candidates = await pool.query<HistoryDayKey>(`
      SELECT owner_user_id, daemon_id, to_char(day, 'YYYY-MM-DD') AS day FROM public.usage_history_days
      WHERE ${dirty} AND retry_at <= statement_timestamp()
        AND day BETWEEN ${utcToday}-364 AND ${utcToday}-1
      ORDER BY day DESC, owner_user_id, daemon_id LIMIT $1
    `, [batchSize])
    for (const day of candidates.rows) {
      if (!running) return
      try {
        await refreshHistoryDay(pool, day)
      } catch (error) {
        reportError(error)
      }
    }
    if (running && Date.now() >= nextPrune) {
      nextPrune = Date.now() + 60_000
      await pruneHistoryDays(pool)
    }
  }

  const schedule = (delay: number): void => {
    if (!running) return
    timer = setTimeout(() => {
      timer = undefined
      active = run().catch(reportError).finally(() => {
        active = undefined
        schedule(intervalMs)
      })
    }, delay)
    timer.unref()
  }

  return {
    start(): void {
      if (running) return
      running = true
      schedule(0)
    },
    async stop(): Promise<void> {
      running = false
      if (timer) clearTimeout(timer)
      timer = undefined
      await active
    },
  }
}
