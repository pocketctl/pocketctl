import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import pg from 'pg'
import { initDB } from '../db.js'
import { resolvePersonalUsageScope } from '../usage-analytics/scope.js'
import { readTokenRows, type TokenRow } from '../usage-analytics/token-repository.js'
import type { AuthorizedUsageScope, Window } from '../usage-analytics/contracts.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1'
const test = enabled ? it : it.skip
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
let db: pg.PoolClient
let owner: number
let other: number
const window: Window = { from: '2026-01-01T00:00:00Z', toExclusive: '2026-11-16T12:00:00Z', days: 320 }

beforeAll(async () => {
  if (!enabled) return
  if (!process.env.TEST_DATABASE_URL?.includes('personal_usage_test')) throw Error('isolated_test_database_required')
  await initDB(pool)
}, 60000)
beforeEach(async () => {
  if (!enabled) return
  db = await pool.connect()
  await db.query('BEGIN')
  // Fixtures deliberately contain legacy facts without automatic projection.
  await db.query('UPDATE usage_analytics_state SET write_enabled=FALSE')
  const users = await db.query("INSERT INTO users(email,password_hash) VALUES('residual-a@example.test','fixture'),('residual-b@example.test','fixture') RETURNING id")
  owner = users.rows[0].id; other = users.rows[1].id
  await db.query("INSERT INTO daemons(daemon_id,user_id,hostname) VALUES('residual-a',$1,'Fixture'),('residual-b',$2,'Other')", [owner, other])
  await db.query("INSERT INTO sessions(session_id,user_id,daemon_id,agent_type) VALUES('residual-session',$1,'residual-a','fixture')", [owner])
})
afterEach(async () => { if (db) { await db.query('ROLLBACK'); db.release() } })
afterAll(async () => { await pool.end() })

function scope(w = window): AuthorizedUsageScope {
  return { kind: 'personal', actorUserId: owner, authorizationRevision: 'fixture', daemons: [], windows: [{ ownerUserId: owner, daemonId: 'residual-a', from: w.from, toExclusive: w.toExclusive }] }
}
async function daily(total: number, model = 'old', date = '2026-11-14', user = owner, daemon = 'residual-a') {
  await db.query('INSERT INTO token_daily_stats(user_id,daemon_id,date,model,input) VALUES($1,$2,$3,$4,$5)', [user, daemon, date, model, total])
}
async function fact(key: string, total: number, logical?: string, model = 'old', date = '2026-11-14', user = owner, daemon = 'residual-a') {
  await db.query(`INSERT INTO token_usage_facts(fact_key,user_id,daemon_id,session_id,model,usage_date,recorded_at,input)
    VALUES($1,$2,$3,'residual-session',$4,$5,'2026-11-15',$6)`, [key, user, daemon, model, date, total])
  if (logical) await db.query(`INSERT INTO usage_source_metadata(fact_key,owner_user_id,daemon_id,source_session,logical_usage_id,metadata,received_at)
    VALUES($1,$2,$3,'residual-session',$4,'{}','2026-11-15')`, [key, user, daemon, logical])
}
async function projection(logical: string, total: number, version = 'normalized-v1') {
  await db.query(`INSERT INTO usage_token_projection(owner_user_id,daemon_id,source_session,logical_usage_id,source_fact_key,accounting_version,agent_type,model,occurred_at,received_at,time_basis,input,output,cache_read,cache_create,total,request_id,quality)
    VALUES($1,'residual-a','residual-session',$2,$2,$4,'fixture','new','2026-11-13T10:00:00Z','2026-11-15','source',$3,0,0,0,$3,'same-request','normalized')`, [owner, logical, total, version])
}
const sum = (rows: TokenRow[]) => rows.reduce((n, row) => n + BigInt(row.total), 0n)

// Catches subtracting only the latest revision, using the projection's date/model,
// double deduction from multiple accounting versions, and treating metadata alone as coverage.
test('deducts each covered legacy fact once across revisions and changed model/day', async () => {
  await daily(400)
  await fact('first', 100, 'logical')
  await fact('revision', 120, 'logical')
  await fact('unmapped', 80)
  await fact('metadata-only', 100, 'absent')
  await projection('logical', 70)
  await projection('logical', 10, 'future-fixture')
  const rows = await readTokenRows(db, scope(), window)
  expect(rows.find(r => r.model === 'unknown')).toMatchObject({ total: '180', input: null, requests: null, attribution_revoked: true })
  expect(rows.find(r => r.model === 'new')).toMatchObject({ total: '80', date: '2026-11-13', requests: '1' })
  expect(sum(rows)).toBe(260n)
})

test('keeps owner, daemon, model and day boundaries when subtracting coverage', async () => {
  await daily(100)
  await daily(200, 'different')
  await daily(300, 'old', '2026-11-12')
  await daily(9000, 'old', '2026-11-14', other, 'residual-b')
  await daily(8000, 'old', '2026-11-14', owner, 'residual-b')
  await fact('covered', 30, 'logical')
  await fact('other-owner', 5000, 'logical', 'old', '2026-11-14', other, 'residual-b')
  await fact('other-daemon', 4000, 'logical', 'old', '2026-11-14', owner, 'residual-b')
  await projection('logical', 30)
  expect(sum(await readTokenRows(db, scope(), window))).toBe(600n)
  const repeated = scope(); repeated.windows.push({ ...repeated.windows[0] })
  expect(sum(await readTokenRows(db, repeated, window))).toBe(600n)
})

test('includes only complete UTC legacy days and clamps over-covered days to zero', async () => {
  await daily(50)
  await daily(300, 'old', '2026-11-15')
  await fact('over-covered', 100, 'logical')
  await projection('logical', 40)
  const partial: Window = { from: '2026-11-14T12:00:00Z', toExclusive: '2026-11-15T12:00:00Z', days: 2 }
  expect(await readTokenRows(db, scope(partial), partial)).toEqual([])
  expect(sum(await readTokenRows(db, scope(), window))).toBe(340n)
  const empty = scope(); empty.windows = []
  expect(await readTokenRows(db, empty, window)).toEqual([])
})

test('revoked session keeps scalar totals without reintroducing legacy double counting', async () => {
  await daily(100)
  await fact('covered', 100, 'logical')
  await projection('logical', 70)
  await db.query("UPDATE sessions SET content_state='deleted' WHERE session_id='residual-session'")
  const rows = await readTokenRows(db, scope(), window)
  expect(sum(rows)).toBe(70n)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ attribution_revoked: true, source_session: null })
  expect(await readTokenRows(db, scope(), window, { sessionIds: ['residual-session'] })).toEqual([])
})

// A work budget is stable across machine speeds: the old correlated subqueries
// touch hundreds of thousands of buffers for just 120k facts / 900 daily rows.
// This fails if a per-day/per-fact lookup is reintroduced, without asserting a SQL spelling or join algorithm.
test('large legacy dashboard stays within a bounded database read-work budget', async () => {
  await db.query(`INSERT INTO token_usage_facts(fact_key,user_id,daemon_id,session_id,model,usage_date,recorded_at,input)
    SELECT 'bulk-'||i,$1,'residual-a','residual-session','m'||(i%3),DATE '2026-01-01'+((i/3)%300),'2026-11-15',1 FROM generate_series(1,120000) i`, [owner])
  await db.query(`INSERT INTO token_daily_stats(user_id,daemon_id,date,model,input)
    SELECT user_id,daemon_id,usage_date,model,SUM(input) FROM token_usage_facts WHERE user_id=$1 GROUP BY 1,2,3,4`, [owner])
  await db.query(`INSERT INTO usage_source_metadata(fact_key,owner_user_id,daemon_id,source_session,logical_usage_id,metadata,received_at)
    SELECT 'bulk-'||i,$1,'residual-a','residual-session','bulk-'||i,'{}','2026-11-15' FROM generate_series(1,4000) i`, [owner])
  await db.query(`INSERT INTO usage_token_projection(owner_user_id,daemon_id,source_session,logical_usage_id,source_fact_key,agent_type,model,occurred_at,received_at,time_basis,input,output,cache_read,cache_create,total,quality)
    SELECT $1,'residual-a','residual-session','bulk-'||i,'bulk-'||i,'fixture','m'||(i%3),(DATE '2026-01-01'+((i/3)%300))::timestamp AT TIME ZONE 'UTC','2026-11-15','source',1,0,0,0,1,'normalized' FROM generate_series(1,4000) i`, [owner])
  for (const table of ['token_usage_facts', 'token_daily_stats', 'usage_source_metadata', 'usage_token_projection', 'sessions']) await db.query(`ANALYZE ${table}`)
  let plan: any
  // Execute the actual repository query with PostgreSQL's work instrumentation.
  const measured = { query: async (sql: string, args: unknown[]) => {
    const result = await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args)
    plan = result.rows[0]['QUERY PLAN'][0]
    return { rows: [] }
  } } as unknown as Pick<pg.Pool, 'query'>
  await readTokenRows(measured, scope(), window, { aggregate: true })
  const buffers = plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks']
  console.info(JSON.stringify({ benchmark: 'legacy-residual-120k', executionMs: plan['Execution Time'], buffers }))
  expect(buffers).toBeLessThan(100000)
  expect(sum(await readTokenRows(db, scope(), window, { aggregate: true }))).toBe(120000n)

  // Host switching still returns the complete list of hosts. Its cost should
  // depend on the host count, even when the selected host has 120k facts.
  type PlanNode = {
    'Relation Name'?: string
    'Actual Rows': number
    'Actual Loops': number
    Plans?: PlanNode[]
  }
  function factRows(node: PlanNode): number {
    const own = node['Relation Name'] === 'token_usage_facts' ? node['Actual Rows'] * node['Actual Loops'] : 0
    return own + (node.Plans ?? []).reduce((sum, child) => sum + factRows(child), 0)
  }
  let hostPlan: PlanNode | undefined
  const tracedScope = { query: async (sql: string, args: unknown[]) => {
    if (!hostPlan) hostPlan = (await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args)).rows[0]['QUERY PLAN'][0].Plan
    return db.query(sql, args)
  } } as Pick<pg.Pool, 'query'>
  const selected = await resolvePersonalUsageScope(tracedScope, owner, 'residual-a', window)
  expect(selected.windows).toEqual(scope().windows)
  expect(factRows(hostPlan!)).toBeLessThan(10)
}, 60000)
