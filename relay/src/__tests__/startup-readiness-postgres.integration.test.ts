import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
vi.hoisted(() => { vi.stubEnv('JWT_SECRET', 'local-startup-readiness-test-secret') })
import { initDB, backfillSessionModel } from '../db.js'
import { registerDurableIngressReadinessRoute } from '../server.js'
import { finishDatabaseStartup } from '../startup-readiness.js'
import { assertDurableIngressTestDatabase } from './durable-ingress-test-db.js'

const url = process.env.TEST_DATABASE_URL
const enabled = Boolean(url && process.env.RUN_POSTGRES_INTEGRATION === '1')
let pool: pg.Pool, worker: pg.Pool
beforeAll(async () => {
  if (!enabled) return
  pool = new pg.Pool({ connectionString: url, max: 3 })
  worker = new pg.Pool({ connectionString: url, max: 1, statement_timeout: 1500 })
  await assertDurableIngressTestDatabase(pool, url!)
  await initDB(pool)
}, 30000)
afterAll(async () => { await worker?.end(); await pool?.end() })

;(enabled ? test : test.skip)('real metadata lock/timeout does not block the readiness endpoint', async () => {
  await pool.query('TRUNCATE events,sessions,daemons CASCADE')
  await pool.query("INSERT INTO daemons(daemon_id) VALUES('ready-test')")
  await pool.query("INSERT INTO sessions(session_id,daemon_id) VALUES('ready-test','ready-test')")
  await pool.query(`INSERT INTO events(session_id,event_type,payload) VALUES('ready-test','session_meta','{"model":"test-model","effort":"high"}')`)
  const lock = await pool.connect()
  const app = Fastify()
  let ready = false
  registerDurableIngressReadinessRoute(app, () => ready, pool, { fixture: 'local' })
  try {
    expect((await app.inject('/health/ready')).statusCode).toBe(503)
    await lock.query('BEGIN')
    await lock.query("SELECT 1 FROM sessions WHERE session_id='ready-test' FOR UPDATE")
    let repairFailed = false
    const started = performance.now()
    await finishDatabaseStartup({ isShuttingDown: () => false, markReady: () => { ready = true },
      repairMetadata: () => backfillSessionModel(worker), reportMetadataError: () => { repairFailed = true } })
    expect((await app.inject('/health/ready')).statusCode).toBe(200)
    expect(repairFailed).toBe(false)
    const readyMs = performance.now() - started
    expect(readyMs).toBeLessThan(1000)
    await vi.waitFor(() => expect(repairFailed).toBe(true), { timeout: 4000 })
    expect((await app.inject('/health/ready')).statusCode).toBe(200)
    await lock.query('ROLLBACK')
    expect(await backfillSessionModel(worker)).toBe(1)
    console.log(`isolated readiness=${readyMs.toFixed(1)}ms; metadata timeout=1500ms; repair resumes after lock release`)
  } finally { await lock.query('ROLLBACK'); lock.release(); await app.close() }
})
