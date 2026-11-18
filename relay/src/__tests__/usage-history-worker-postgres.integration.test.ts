import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { deleteUserAccount, initDB } from '../db.js'
import { queueHistoryDays } from '../usage-analytics/history-backfill-main.js'
import { assertHistorySchema } from '../usage-analytics/history-schema.js'
import { createHistoryWorker, refreshHistoryDay, type HistoryDayKey } from '../usage-analytics/history-worker.js'

const url = process.env.USAGE_HISTORY_WORKER_TEST_DATABASE_URL
const test = url ? it : it.skip
const pool = new pg.Pool({ connectionString: url, application_name: 'usage-history-worker-fixture', max: 5 })
const owners: number[] = []
let today: string
let yesterday: string
let earlier: string

beforeAll(async () => {
  if (!url) return
  const parsed = new URL(url)
  if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/personal_usage_test_queue' || parsed.search) {
    throw Error('isolated_usage_history_worker_database_required')
  }
  await initDB(pool)
  await pool.query('UPDATE usage_analytics_state SET write_enabled=FALSE')
  const { rows } = await pool.query(`SELECT day::text AS today, (day-1)::text AS yesterday, (day-2)::text AS earlier
    FROM (SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS day) t`)
  today = rows[0].today
  yesterday = rows[0].yesterday
  earlier = rows[0].earlier
}, 60_000)

afterEach(async () => {
  for (const owner of owners.splice(0)) await deleteUserAccount(pool, owner)
})

afterAll(async () => { await pool.end() })

async function fixture(enrolled = true) {
  const { id: owner } = (await pool.query(
    "INSERT INTO users(email,password_hash) VALUES($1,'fixture') RETURNING id",
    [`usage-history-${randomUUID()}@example.test`],
  )).rows[0]
  owners.push(owner)
  if (enrolled) await pool.query('INSERT INTO usage_history_owners(owner_user_id) VALUES($1)', [owner])
  const daemon = `usage-history-${owner}`
  await pool.query("INSERT INTO daemons(daemon_id,user_id,hostname) VALUES($1,$2,'History test host')", [daemon, owner])
  return { owner, daemon, day: (day = yesterday): HistoryDayKey => ({ owner_user_id: owner, daemon_id: daemon, day }) }
}

async function state({ owner_user_id, daemon_id, day }: HistoryDayKey) {
  return (await pool.query(`SELECT revision, built_revision, residual::text, tokens::text, calls::text, skills::text
    FROM usage_history_days WHERE owner_user_id=$1 AND daemon_id=$2 AND day=$3`, [owner_user_id, daemon_id, day])).rows[0]
}

async function daily({ owner_user_id, daemon_id, day }: HistoryDayKey, total = 100) {
  await pool.query("INSERT INTO token_daily_stats(user_id,daemon_id,date,model,input) VALUES($1,$2,$3,'legacy',$4)",
    [owner_user_id, daemon_id, day, total])
}

async function editDaily({ owner_user_id, daemon_id, day }: HistoryDayKey, total: number, db: pg.Pool | pg.PoolClient = pool) {
  await db.query('UPDATE token_daily_stats SET input=$4 WHERE user_id=$1 AND daemon_id=$2 AND date=$3',
    [owner_user_id, daemon_id, day, total])
}

test('dry run and replay queue just missing days for the specified owner and authorized hosts', async () => {
  const f = await fixture(false)
  const peer = await fixture(false)
  const history = { ...f.day(), daemon_id: `historical-${f.owner}` }
  await daily(history)
  await expect(queueHistoryDays(pool, f.owner, 2, false)).resolves.toMatchObject({ hosts: 2, missing: 4, queued: 0, current_day_missing: 2, current_day_queued: 0 })
  expect(await state(f.day())).toBeUndefined()
  expect(await state(history)).toBeUndefined()
  expect(await state(peer.day())).toBeUndefined()

  await expect(queueHistoryDays(pool, f.owner, 2, true)).resolves.toMatchObject({ hosts: 2, missing: 4, queued: 4, current_day_missing: 2, current_day_queued: 2 })
  await expect(refreshHistoryDay(pool, f.day())).resolves.toBe(true)
  const before = await state(f.day())
  expect(before).toMatchObject({
    built_revision: '1', tokens: '[]', residual: '[]', calls: '[]', skills: '[]',
  })
  await expect(queueHistoryDays(pool, f.owner, 2, true)).resolves.toMatchObject({ missing: 0, queued: 0 })
  expect(await state(f.day())).toEqual(before)
  expect(await state(peer.day())).toBeUndefined()
  expect(await state(f.day(today))).toMatchObject({ revision: '1', built_revision: null })
  await daily({ ...f.day(today), daemon_id: `new-after-enrollment-${f.owner}` })
  expect(await state({ ...f.day(today), daemon_id: `new-after-enrollment-${f.owner}` })).toMatchObject({ revision: '1', built_revision: null })
  await expect(queueHistoryDays(pool, f.owner, 365, true)).rejects.toThrow('explicit_owner_and_bounded_days_required')
  await pool.query('DELETE FROM usage_history_owners WHERE owner_user_id=$1', [f.owner])
  expect(await state(f.day())).toBeUndefined()
  expect(await state(history)).toBeUndefined()
})

test('projection key, metadata and fact corrections dirty original legacy dates', async () => {
  const { owner, daemon, day } = await fixture()
  await daily(day())
  await pool.query(`INSERT INTO token_usage_facts(fact_key,user_id,daemon_id,session_id,model,usage_date,recorded_at,input)
    VALUES($1,$2,$3,'fixture-session','legacy',$4,now(),20)`, [daemon, owner, daemon, yesterday])
  await pool.query(`INSERT INTO usage_source_metadata(fact_key,owner_user_id,daemon_id,source_session,logical_usage_id,metadata,received_at)
    VALUES($1,$2,$3,'fixture-session','first','{}',now())`, [daemon, owner, daemon])
  const rebuildResidual = async (total: number) => {
    expect((await state(day())).built_revision).not.toBe((await state(day())).revision)
    await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
    expect((await state(day())).residual).toBe(`[{"total": ${total}}]`)
  }
  await rebuildResidual(100)
  await pool.query(`INSERT INTO usage_token_projection(owner_user_id,daemon_id,source_session,logical_usage_id,source_fact_key,
    agent_type,model,occurred_at,received_at,time_basis,input,total,quality)
    VALUES($1,$2,'fixture-session','first',$2,'fixture','new',$3::date::timestamp AT TIME ZONE 'UTC',now(),'source',20,20,'normalized')`,
    [owner, daemon, earlier])
  await rebuildResidual(80)
  await pool.query("UPDATE usage_token_projection SET logical_usage_id='second' WHERE owner_user_id=$1", [owner])
  await rebuildResidual(100)
  await pool.query("UPDATE usage_source_metadata SET logical_usage_id='second' WHERE owner_user_id=$1", [owner])
  await rebuildResidual(80)
  await pool.query('UPDATE token_usage_facts SET input=25 WHERE user_id=$1', [owner])
  await rebuildResidual(75)
  await pool.query('DELETE FROM usage_token_projection WHERE owner_user_id=$1', [owner])
  await rebuildResidual(100)

  const changes = await pool.query(`SELECT from_at::text, to_exclusive::text,
    (from_at AT TIME ZONE 'UTC')::date::text AS day, to_exclusive-from_at = interval '24 hours' AS full_day
    FROM usage_scope_changes WHERE owner_user_id=$1 AND legacy_day`, [owner])
  expect(changes.rows).toHaveLength(8)
  expect(changes.rows.every(change => change.day === yesterday && change.full_day)).toBe(true)
  await daily(day(today))
  const count = await pool.query('SELECT count(*)::int AS count FROM usage_scope_changes WHERE owner_user_id=$1 AND legacy_day', [owner])
  expect(count.rows[0].count).toBe(8)

  await expect(deleteUserAccount(pool, owner)).resolves.toBe(true)
  expect(await state(day())).toBeUndefined()
  expect(await state(day(earlier))).toBeUndefined()
})

test('moves calls and skill facts across UTC buckets and clears removed entries', async () => {
  const { owner, daemon, day } = await fixture()
  const params = [owner, daemon, yesterday]
  await pool.query(`INSERT INTO usage_call_facts(owner_user_id,daemon_id,runtime,source_session,invocation_id,
    tool_kind,tool_name,occurred_at,received_at,outcome,has_start,quality)
    VALUES($1,$2,'fixture','fixture-session','one','builtin','read',
      $3::date::timestamp AT TIME ZONE 'UTC',now(),'success',true,'fixture')`, params)
  await pool.query(`INSERT INTO usage_skill_facts(owner_user_id,daemon_id,runtime,source_session,skill_invocation_id,
    skill_key,skill_name,occurred_at,evidence_kind,evidence_version)
    VALUES($1,$2,'fixture','fixture-session','one','skill','Skill',
      $3::date::timestamp AT TIME ZONE 'UTC','fixture',1)`, params)
  await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
  expect(JSON.parse((await state(day())).calls)).toHaveLength(1)
  expect(JSON.parse((await state(day())).skills)).toHaveLength(1)
  for (const table of ['usage_call_facts', 'usage_skill_facts']) {
    await pool.query(`UPDATE ${table} SET occurred_at=occurred_at-INTERVAL '1 day' WHERE owner_user_id=$1`, [owner])
  }

  await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
  expect(await state(day())).toMatchObject({ calls: '[]', skills: '[]' })
  await expect(refreshHistoryDay(pool, day(earlier))).resolves.toBe(true)
  expect(JSON.parse((await state(day(earlier))).calls)).toHaveLength(1)
  expect(JSON.parse((await state(day(earlier))).skills)).toHaveLength(1)
  for (const table of ['usage_call_facts', 'usage_skill_facts']) {
    await pool.query(`DELETE FROM ${table} WHERE owner_user_id=$1`, [owner])
  }
  await expect(refreshHistoryDay(pool, day(earlier))).resolves.toBe(true)
  expect(await state(day(earlier))).toMatchObject({ calls: '[]', skills: '[]' })
})

test('source writes can commit during a build and a stale revision cannot publish', async () => {
  const { day } = await fixture()
  await daily(day())
  const blocker = await pool.connect()
  let refresh: Promise<boolean> | undefined
  try {
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE usage_call_facts IN ACCESS EXCLUSIVE MODE')
    refresh = refreshHistoryDay(pool, day())
    await vi.waitFor(async () => {
      const { rows } = await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE application_name='usage-history-worker-fixture' AND wait_event_type='Lock'
          AND query LIKE '%scope_windows AS%'`)
      expect(rows).toHaveLength(1)
    }, { timeout: 1_000 })
    await expect(refreshHistoryDay(pool, day())).resolves.toBe(false)
    await blocker.query("SET LOCAL statement_timeout='500ms'")
    await editDaily(day(), 150, blocker)
    await blocker.query('COMMIT')
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
    await expect(refresh).resolves.toBe(false)
  }
  expect((await state(day())).built_revision).toBeNull()
  await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
  expect((await state(day())).residual).toBe('[{"total": 150}]')
})

test('write source triggers work for a runtime role before cache privileges are granted', async () => {
  const { day } = await fixture()
  const key = day()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE ROLE usage_history_fixture_runtime NOLOGIN;
      GRANT USAGE ON SCHEMA public TO usage_history_fixture_runtime;
      GRANT INSERT ON public.token_daily_stats TO usage_history_fixture_runtime;
      SET LOCAL ROLE usage_history_fixture_runtime`)
    await expect(assertHistorySchema(client)).rejects.toThrow('usage_history_schema_not_ready')
    await client.query(`INSERT INTO public.token_daily_stats(user_id,daemon_id,date,model,input)
      VALUES($1,$2,$3,'legacy',6)`, [key.owner_user_id, key.daemon_id, key.day])
    const privateAccess = await client.query(`SELECT has_schema_privilege(current_user, 'usage_history_private', 'USAGE') AS permitted`)
    expect(privateAccess.rows[0].permitted).toBe(false)
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('RESET ROLE')
    expect((await client.query('SELECT revision FROM usage_history_days WHERE owner_user_id=$1', [key.owner_user_id])).rows[0])
      .toEqual({ revision: '1' })

    await client.query('GRANT SELECT ON public.usage_history_days, public.usage_history_owners TO usage_history_fixture_runtime; SET LOCAL ROLE usage_history_fixture_runtime')
    await expect(assertHistorySchema(client)).resolves.toBeUndefined()
    await expect(assertHistorySchema(client, { write: true })).rejects.toThrow('usage_history_schema_not_ready')
    await client.query(`RESET ROLE; GRANT UPDATE,DELETE ON public.usage_history_days TO usage_history_fixture_runtime;
      SET LOCAL ROLE usage_history_fixture_runtime`)
    await expect(assertHistorySchema(client, { write: true })).resolves.toBeUndefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})

test('background maintenance retains the active window, builds historical work and leaves today to live reads', async () => {
  const { owner, daemon, day } = await fixture()
  await pool.query(`INSERT INTO usage_history_days(owner_user_id,daemon_id,day)
    VALUES($1,$2,$3::date),($1,$2,$3::date-1),($1,$2,$3::date-364),($1,$2,$3::date-365)`, [owner, daemon, today])
  const worker = createHistoryWorker(pool)
  try {
    worker.start()
    await vi.waitFor(async () => {
      expect(await state(day())).toMatchObject({ revision: '1', built_revision: '1' })
      expect((await pool.query('SELECT count(*)::int AS count FROM usage_history_days WHERE owner_user_id=$1', [owner])).rows[0].count).toBe(3)
    }, { timeout: 2_000 })
    expect(await state(day(today))).toMatchObject({ built_revision: null })
  } finally {
    await worker.stop()
  }
})

test('older metadata and call writes can overlap without reversing owner and day locks', async () => {
  const { owner, daemon, day } = await fixture()
  await daily(day())
  await pool.query(`INSERT INTO token_usage_facts(fact_key,user_id,daemon_id,session_id,model,usage_date,recorded_at,input)
    VALUES($1,$2,$3,'fixture-session','legacy',$4,now(),20)`, [daemon, owner, daemon, yesterday])
  await pool.query(`INSERT INTO usage_source_metadata(fact_key,owner_user_id,daemon_id,source_session,logical_usage_id,metadata,received_at)
    VALUES($1,$2,$3,'fixture-session','first','{}',now())`, [daemon, owner, daemon])
  const token = await pool.connect()
  const call = await pool.connect()
  try {
    await token.query('BEGIN')
    await token.query("UPDATE usage_source_metadata SET logical_usage_id='second' WHERE fact_key=$1", [daemon])
    await call.query('BEGIN')
    await call.query("SET LOCAL lock_timeout='500ms'")
    await call.query(`INSERT INTO usage_call_facts(owner_user_id,daemon_id,runtime,source_session,invocation_id,
      tool_kind,tool_name,occurred_at,received_at,outcome,has_start,quality)
      VALUES($1,$2,'fixture','other-session','one','builtin','read',
        $3::date::timestamp AT TIME ZONE 'UTC',now(),'success',true,'fixture')`, [owner, daemon, yesterday])
    await call.query('COMMIT')
    await token.query(`INSERT INTO usage_token_projection(owner_user_id,daemon_id,source_session,logical_usage_id,source_fact_key,
      agent_type,model,occurred_at,received_at,time_basis,input,total,quality)
      VALUES($1,$2,'fixture-session','second',$2,'fixture','new',$3::date::timestamp AT TIME ZONE 'UTC',now(),'source',20,20,'normalized')`,
      [owner, daemon, earlier])
    await token.query('COMMIT')
  } finally {
    await token.query('ROLLBACK')
    await call.query('ROLLBACK')
    token.release()
    call.release()
  }

  await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
  const completed = await state(day())
  expect(completed.residual).toBe('[{"total": 80}]')
  expect(JSON.parse(completed.calls)).toHaveLength(1)
})

test('deferred invalidation dedupes a transaction and leaves no pending work after commit or rollback', async () => {
  const { owner, day } = await fixture()
  await daily(day())
  await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
  const ready = await state(day())
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await editDaily(day(), 150, client)
    expect(await state(day())).toEqual(ready)
    await client.query('ROLLBACK')
    expect(await state(day())).toEqual(ready)

    await client.query('BEGIN')
    await editDaily(day(), 175, client)
    await editDaily(day(), 200, client)
    await client.query('COMMIT')
    expect((await state(day())).revision).toBe(String(BigInt(ready.revision) + 1n))
    const changes = await client.query('SELECT count(*)::int AS n FROM usage_scope_changes WHERE owner_user_id=$1 AND legacy_day', [owner])
    expect(changes.rows[0].n).toBe(2)
    expect((await client.query('SELECT 1 FROM usage_history_private.invalidations')).rowCount).toBe(0)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
  await expect(refreshHistoryDay(pool, day())).resolves.toBe(true)
  expect((await state(day())).residual).toBe('[{"total": 200}]')
})

test('first enrollment waits for preexisting source writes and includes their historical hosts', async () => {
  const f = await fixture(false)
  const key = { ...f.day(), daemon_id: `late-discovered-${f.owner}` }
  const oldSource = await pool.connect()
  let enrollment: Promise<unknown> | undefined
  try {
    await oldSource.query('BEGIN')
    await oldSource.query(`INSERT INTO public.token_daily_stats(user_id,daemon_id,date,model,input)
      VALUES($1,$2,$3,'legacy',70)`, [key.owner_user_id, key.daemon_id, key.day])
    enrollment = queueHistoryDays(pool, f.owner, 1, true)
    await vi.waitFor(async () => {
      const { rows } = await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE application_name='usage-history-worker-fixture' AND wait_event_type='Lock'
          AND query LIKE '%LOCK TABLE public.token_usage_facts%'`)
      expect(rows).toHaveLength(1)
    }, { timeout: 750, interval: 20 })
    expect(await state(key)).toBeUndefined()
    await oldSource.query('COMMIT')
  } finally {
    await oldSource.query('ROLLBACK')
    oldSource.release()
    await enrollment?.catch(() => undefined)
  }
  await expect(enrollment).resolves.toMatchObject({ hosts: 2, queued: 2, current_day_queued: 2 })
  await expect(refreshHistoryDay(pool, key)).resolves.toBe(true)
  expect((await state(key)).residual).toBe('[{"total": 70}]')

  const busyScope = await pool.connect()
  try {
    await busyScope.query('BEGIN')
    await busyScope.query('LOCK TABLE public.token_daily_stats IN ROW EXCLUSIVE MODE')
    await expect(queueHistoryDays(pool, f.owner, 1, true)).resolves.toMatchObject({ missing: 0, queued: 0 })
  } finally {
    await busyScope.query('ROLLBACK')
    busyScope.release()
  }
})

test('first enrollment timeout leaves neither enrollment nor queued days', async () => {
  const f = await fixture(false)
  const writer = await pool.connect()
  try {
    await writer.query('BEGIN')
    await writer.query('LOCK TABLE public.token_daily_stats IN ROW EXCLUSIVE MODE')
    await expect(queueHistoryDays(pool, f.owner, 1, true)).rejects.toMatchObject({ code: '55P03' })
    expect((await pool.query('SELECT 1 FROM usage_history_owners WHERE owner_user_id=$1', [f.owner])).rowCount).toBe(0)
    expect(await state(f.day())).toBeUndefined()
  } finally {
    await writer.query('ROLLBACK')
    writer.release()
  }
})
