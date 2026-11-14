import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getLatestAgentTaskLists, getLatestAgentTaskListsWithTimeout, initDB, LATEST_AGENT_TASK_LISTS_SQL } from '../db.js'
import { installPostgresHistoryBodyReader, withSessionHistoryScope } from '../session-history/postgres-reader.js'
import { aliasLimits, aliasStorage } from './native-session-alias-fixture.js'

// Explicit loopback history_test control database only. Its role needs CREATEDB;
// production schema is initialized solely in a new database owned by this run.
const url = process.env.TEST_HISTORY_SNAPSHOT_POSTGRES_URL
const suite = url ? describe : describe.skip
suite('task snapshot candidate selection with isolated PostgreSQL', () => {
  let pool: pg.Pool, admin: pg.Pool
  let databaseCreated = false
  let owner: number, other: number
  const database = `history_snapshot_${process.pid}_${randomUUID().replaceAll('-', '')}`
  const readLists = (sessionId: string, userId = owner) => withSessionHistoryScope({ userId }, () => getLatestAgentTaskLists(pool, sessionId))
  const readListsWithTimeout = (sessionId: string, userId = owner) => withSessionHistoryScope({ userId }, () => getLatestAgentTaskListsWithTimeout(pool, sessionId))
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1'
      || parsed.pathname !== '/history_test' || parsed.search || parsed.hash) throw new Error('dedicated local history_test database required')
    admin = new pg.Pool({ connectionString: url })
    const identity = (await admin.query(`SELECT current_database() AS database_name,
      (SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname=current_user) AS can_create_database`)).rows[0]
    if (identity.database_name !== 'history_test' || identity.can_create_database !== true) throw new Error('history_test fixture role requires CREATEDB')
    await admin.query(`CREATE DATABASE ${database}`)
    databaseCreated = true
    parsed.pathname = `/${database}`
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 3 })
    await initDB(pool)
    installPostgresHistoryBodyReader(pool, aliasStorage(), aliasLimits)
    const users = (await pool.query(`INSERT INTO users(email,password_hash)
      VALUES('snapshot-owner@test.invalid','x'),('snapshot-other@test.invalid','x') RETURNING id,email`)).rows
    owner = users.find(row => row.email === 'snapshot-owner@test.invalid')!.id
    other = users.find(row => row.email === 'snapshot-other@test.invalid')!.id
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('snapshot-owner',$1),('snapshot-other',$2)", [owner, other])
    await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id)
      VALUES('large','snapshot-owner',$1),('legacy','snapshot-owner',$1),('ownership','snapshot-owner',$1)`, [owner])
    await pool.query(`INSERT INTO events(session_id,event_type,payload,body_header,user_id)
      SELECT 'large','agent_plan',jsonb_build_object('type','agent_plan','part_id','source-'||(i%12),'revision',i,'plan',jsonb_build_array(jsonb_build_object('step',repeat(md5(i::text),128),'status','pending'))),
        jsonb_build_object('part_id','source-'||(i%12),'revision',i),$1 FROM generate_series(1,24000) i`, [owner])
    await pool.query(`INSERT INTO events(session_id,event_type,payload,user_id)
      SELECT 'large','agent_text',jsonb_build_object('type','agent_text','text','body-'||i),$1 FROM generate_series(1,24000) i`, [owner])
    await pool.query(readFileSync(new URL('../../migrations/20261111-root-task-list-index.sql', import.meta.url), 'utf8'))
    await pool.query('ANALYZE events')
  }, 60000)
  afterAll(async () => {
    await pool?.end()
    if (admin) {
      try { if (databaseCreated) await admin.query(`DROP DATABASE ${database}`) }
      finally { await admin.end() }
    }
  })
  test('24k candidates choose independent highest revisions and clears within the server deadline', async () => {
    await pool.query(`INSERT INTO events(session_id,event_type,payload,body_header,user_id) VALUES
      ('large','agent_plan','{"type":"agent_plan","part_id":"source-0","revision":25000,"plan":[]}','{"part_id":"source-0","revision":25000}',$1),
      ('large','agent_plan','{"type":"agent_plan","part_id":"source-0","revision":2,"plan":[{"step":"stale"}]}','{"part_id":"source-0","revision":2}',$1),
      ('large','agent_todo','{"type":"agent_todo","todos":[]}','{}',$1),
      ('large','agent_plan','{"type":"agent_plan","part_id":"source-1","revision":99999,"agent_id":"child","plan":[]}','{"part_id":"source-1","revision":99999,"agent_id":"child"}',$1)`, [owner])
    const start = performance.now()
    const rows = await readListsWithTimeout('large')
    process.stdout.write(`task snapshot PostgreSQL candidate read ms: ${Math.round(performance.now() - start)}\n`)
    expect(rows).toHaveLength(13)
    expect(rows.find(row => row.payload.part_id === 'source-0')?.payload).toMatchObject({ revision: 25000, plan: [] })
    expect(rows.find(row => row.payload.type === 'agent_todo')?.payload.todos).toEqual([])
    expect(rows.some(row => row.payload.agent_id)).toBe(false)
  })
  test('real query uses partial index and sorts compact winning metadata, not JSON bodies', async () => {
    const result = await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${LATEST_AGENT_TASK_LISTS_SQL}`, ['large'])
    const plan = result.rows[0]['QUERY PLAN'][0]
    process.stdout.write(`task snapshot PostgreSQL plan: ${JSON.stringify(plan)}\n`)
    expect(JSON.stringify(plan)).toContain('idx_events_root_task_lists')
    const walk = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(walk)]
    const sort = walk(plan.Plan).find(node => node['Node Type'] === 'Sort' && node['Actual Rows'] >= 24000)
    expect(sort?.['Plan Width']).toBeLessThan(200)
    expect(sort?.['Sort Space Type']).toBe('Memory')
    const invalid = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='idx_events_root_task_lists'::regclass")
    expect(invalid.rows[0].indisvalid).toBe(true)
    // Preserve the original SQL here only as a performance/semantic baseline.
    const original = `SELECT DISTINCT ON (event_type, COALESCE(COALESCE(payload,body_header)->>'part_id',event_type))
      id,session_id,event_type,payload,created_at,body_storage,body_manifest_id,body_chunk_ordinal,body_owner_user_id,body_activity_epoch
      FROM events WHERE session_id=$1 AND event_type IN ('agent_plan','agent_todo')
        AND COALESCE(COALESCE(payload,body_header)->>'agent_id','')=''
      ORDER BY event_type,COALESCE(COALESCE(payload,body_header)->>'part_id',event_type),
        CASE WHEN event_type='agent_plan' AND (COALESCE(payload,body_header)->>'revision') ~ '^[1-9][0-9]*$'
          THEN (COALESCE(payload,body_header)->>'revision')::numeric ELSE 0 END DESC,id DESC`
    const baseline=(await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${original}`,['large'])).rows[0]['QUERY PLAN'][0]
    process.stdout.write(`original task snapshot PostgreSQL baseline: ${JSON.stringify({executionMs:baseline['Execution Time'],tempReadBlocks:baseline.Plan['Temp Read Blocks'],tempWrittenBlocks:baseline.Plan['Temp Written Blocks']})}\n`)
    const originalRows=(await pool.query(original,['large'])).rows
    expect((await readLists('large')).map(row=>row.id).sort()).toEqual(originalRows.map(row=>row.id).sort())
  })
  test('server cancels blocked task selection and releases its transaction deadline', async () => {
    const blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE events IN ACCESS EXCLUSIVE MODE')
    try {
      await expect(readListsWithTimeout('large')).rejects.toMatchObject({ code: '57014' })
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0')
    expect(await readLists('legacy')).toEqual([])
  })
  test('legacy empty headers and long source IDs retain exact independent source semantics', async () => {
    const sources = ['x'.repeat(5000), 'x'.repeat(4999)+'y']
    // Simulate pre-header hot rows, without replacing the native ownership guards.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE events DISABLE TRIGGER events_body_header')
      for (const [index, source] of sources.entries()) await client.query('INSERT INTO events(session_id,event_type,payload,user_id) VALUES($1,$2,$3,$4)', ['legacy','agent_plan',{type:'agent_plan',part_id:source,revision:index+1,plan:[]},owner])
      await client.query('ALTER TABLE events ENABLE TRIGGER events_body_header')
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    expect((await pool.query("SELECT body_header FROM events WHERE session_id='legacy'")).rows.map(row=>row.body_header)).toEqual([{},{}])
    const rows = await readLists('legacy')
    expect(rows.map(row => row.payload.part_id).sort()).toEqual(sources.sort())
  })
  test('native ownership transfer excludes retired and foreign heads while restoring the current owner', async () => {
    const retired = (await pool.query(`INSERT INTO events(session_id,event_type,payload,user_id)
      VALUES('ownership','agent_plan','{"type":"agent_plan","part_id":"retired","revision":1,"plan":[]}',$1) RETURNING id`, [owner])).rows[0].id
    await pool.query("UPDATE sessions SET user_id=$1,daemon_id='snapshot-other' WHERE session_id='ownership'", [other])
    const current = (await pool.query(`INSERT INTO events(session_id,event_type,payload,user_id)
      VALUES('ownership','agent_plan','{"type":"agent_plan","part_id":"current","revision":1,"plan":[]}',$1) RETURNING id`, [other])).rows[0].id
    const foreign = (await pool.query(`INSERT INTO events(session_id,event_type,payload,user_id)
      VALUES('ownership','agent_plan','{"type":"agent_plan","part_id":"foreign","revision":1,"plan":[]}',$1) RETURNING id`, [owner])).rows[0].id
    const selected = (await pool.query(LATEST_AGENT_TASK_LISTS_SQL, ['ownership'])).rows
    expect(selected.map(row=>row.id)).toEqual([retired,current,foreign])
    expect(selected.find(row=>row.id===retired)?.owner_retired).toBe(true)
    const authority = (await pool.query(`SELECT public.native_event_authority($1,$4)->>'state' AS retired,
      public.native_event_authority($2,$4)->>'state' AS current,
      public.native_event_authority($3,$4)->>'state' AS foreign`, [retired,current,foreign,other])).rows[0]
    expect(authority).toEqual({retired:'revoked',current:'current',foreign:'revoked'})
    expect((await readListsWithTimeout('ownership', other)).map(row=>row.id)).toEqual([current])
    await expect(readListsWithTimeout('ownership', owner)).rejects.toThrow('session history not accessible')
  })
})
