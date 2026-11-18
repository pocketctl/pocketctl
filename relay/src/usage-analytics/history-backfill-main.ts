import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { resolvePersonalUsageScope } from './scope.js'

function validScope(owner: number, days: number): boolean {
  return Number.isInteger(owner) && owner > 0 && owner <= 2_147_483_647
    && Number.isInteger(days) && days >= 1 && days <= 364
}

async function queueInTransaction(
  db: pg.PoolClient,
  owner: number,
  days: number,
  apply: boolean,
) {
  const user = await db.query('SELECT id FROM public.users WHERE id=$1', [owner])
  if (!user.rowCount) throw new Error('owner_not_found')
  if (apply) {
    const enrollment = await db.query(`
      SELECT owner_user_id FROM public.usage_history_owners WHERE owner_user_id=$1 FOR KEY SHARE
    `, [owner])
    if (!enrollment.rowCount) {
      // A source transaction that has already checked the enrollment gate
      // may still be open. Drain such writes before enumerating and seeding
      // the first keys, then block new writes until enrollment is visible.
      await db.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='3s'")
      await db.query(`
        LOCK TABLE public.token_usage_facts, public.usage_source_metadata, public.usage_token_projection,
          public.usage_call_facts, public.usage_skill_facts, public.token_daily_stats IN SHARE MODE
      `)
      await db.query(`
        INSERT INTO public.usage_history_owners (owner_user_id) VALUES ($1)
        ON CONFLICT (owner_user_id) DO NOTHING
      `, [owner])
    }
  }
  const clock = await db.query<{ today: string; start_day: string }>(`
    SELECT to_char(day, 'YYYY-MM-DD') AS today, to_char(day-$1::int, 'YYYY-MM-DD') AS start_day
    FROM (SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS day) clock
  `, [days])
  const { today, start_day: start } = clock.rows[0]
  const scope = await resolvePersonalUsageScope(db, owner, 'all', {
    from: `${start}T00:00:00.000Z`,
    toExclusive: `${today}T00:00:00.000Z`,
    days,
  }, true)
  const daemons = scope.windows.map(window => window.daemonId)
  const params = [owner, daemons, today, days]
  const keys = `
    SELECT $1::int AS owner_user_id, daemon_id, $3::date-days_ago AS day
    FROM unnest($2::text[]) AS hosts(daemon_id) CROSS JOIN generate_series(0,$4::int) AS ages(days_ago)
  `
  const counts = `
    count(*) FILTER (WHERE day < $3::date)::int AS history,
    count(*) FILTER (WHERE day = $3::date)::int AS current_day
  `
  type Counts = { history: number; current_day: number }
  const missing = await db.query<Counts>(`
    SELECT ${counts} FROM (${keys}) k
    WHERE NOT EXISTS (
      SELECT 1 FROM public.usage_history_days h
      WHERE (h.owner_user_id,h.daemon_id,h.day)=(k.owner_user_id,k.daemon_id,k.day)
    )
  `, params)
  const queued = apply ? await db.query<Counts>(`
    WITH queued AS (
      INSERT INTO public.usage_history_days (owner_user_id, daemon_id, day)
      SELECT k.owner_user_id, k.daemon_id, k.day
      FROM (${keys}) k
      ORDER BY k.owner_user_id, k.daemon_id, k.day
      ON CONFLICT (owner_user_id, daemon_id, day) DO NOTHING
      RETURNING day
    )
    SELECT ${counts} FROM queued
  `, params) : undefined
  return {
    owner,
    days,
    start_day: start,
    to_exclusive_day: today,
    hosts: daemons.length,
    missing: missing.rows[0].history,
    queued: queued?.rows[0].history ?? 0,
    current_day_missing: missing.rows[0].current_day,
    current_day_queued: queued?.rows[0].current_day ?? 0,
    dry_run: !apply,
  }
}

export async function queueHistoryDays(pool: pg.Pool, owner: number, days: number, apply: boolean) {
  if (!validScope(owner, days)) throw new Error('explicit_owner_and_bounded_days_required')
  const client = await pool.connect()
  let discardClient = false
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const report = await queueInTransaction(client, owner, days, apply)
    await client.query('COMMIT')
    return report
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discardClient = true
    }
    throw error
  } finally {
    client.release(discardClient)
  }
}

export async function backfillUsageHistory(args = process.argv.slice(2)): Promise<void> {
  const [expected, ...flags] = args
  const options = new Map<string, string>()
  let apply = false
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    if (flag === '--apply' && !apply) apply = true
    else if (['--owner', '--days'].includes(flag) && /^\d+$/.test(flags[index + 1] ?? '') && !options.has(flag)) {
      options.set(flag, flags[++index])
    } else {
      throw new Error('invalid_usage_history_backfill_arguments')
    }
  }
  const connectionString = process.env.PERSONAL_USAGE_HISTORY_BACKFILL_DATABASE_URL
  const owner = Number(options.get('--owner'))
  const days = Number(options.get('--days'))
  if (!expected || expected.startsWith('-') || !connectionString || !validScope(owner, days)) {
    throw new Error('explicit_database_owner_and_bounded_days_required')
  }

  const pool = new pg.Pool({
    connectionString,
    max: 1,
    application_name: 'pocketctl-usage-history-backfill',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    lock_timeout: 1_000,
    options: '-c search_path=pg_catalog,public',
  })
  try {
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name')
    if (database.rows[0].name !== expected) throw new Error('backfill_database_identity_mismatch')
    console.log(JSON.stringify(await queueHistoryDays(pool, owner, days, apply)))
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await backfillUsageHistory()
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    const reason = error instanceof Error && /^(invalid|explicit|backfill|owner)_[a-z_]+$/.test(error.message)
      ? error.message
      : code && /^[A-Z0-9]{5}$/.test(code) ? `postgres_${code}` : 'usage_history_backfill_failed'
    console.error(reason)
    console.error('usage: PERSONAL_USAGE_HISTORY_BACKFILL_DATABASE_URL=... npm run backfill:usage-history -- EXPECTED_DATABASE --owner ID --days 1..364 [--apply]')
    process.exitCode = 2
  }
}
