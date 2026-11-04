#!/usr/bin/env node
// Operator-only, one bounded page; never invokes the worker or executor.
import pg from 'pg'
import { sessionLifecycleConfig } from '../dist/session-lifecycle/config.js'
import { SessionLifecycleScanner } from '../dist/session-lifecycle/scanner.js'

const args = process.argv.slice(2)
let pool, client
try {
  if (!args.includes('--read-only') || args.some(arg => !/^--(?:read-only|statistics|after=\d+|limit=\d+)$/.test(arg)))
    throw new Error('usage: --read-only [--after=ROW_ID] [--limit=1..100] [--statistics]')
  const afterRowId = Number(args.find(arg => arg.startsWith('--after='))?.slice(8) ?? 0)
  const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) ?? 20)
  if (!Number.isSafeInteger(afterRowId) || afterRowId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('invalid page bounds')
  const config = sessionLifecycleConfig(process.env)
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required')
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000' })
  client = await pool.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='15s'")
  // Observe is local to this diagnostic; production configuration is not changed.
  const scanner = new SessionLifecycleScanner(client, { ...config, mode: 'observe' })
  const page = await scanner.scanPage({ afterRowId, limit, includeStatistics: args.includes('--statistics') })
  await client.query('ROLLBACK')
  const blockers = {}
  for (const candidate of page.candidates) for (const reason of candidate.prediction.blockedReasons)
    blockers[reason] = (blockers[reason] ?? 0) + 1
  console.log(JSON.stringify({ ...page, configuredMode: config.mode, pageBlockers: blockers,
    statisticsIncluded: args.includes('--statistics'),
    note: 'One page of dependency components. Null statistics mean not measured. Activity age is not blocker duration. Eligibility does not authorize execution; daily scheduling and execution fences still apply.' }, null, 2))
} catch (error) {
  // Do not echo driver errors, connection strings or database contents.
  console.error(JSON.stringify({ error: 'lifecycle_diagnostic_failed', code: error.code ?? 'invalid_configuration_or_query',
    usage: 'node --env-file=.env scripts/session-lifecycle-diagnose.mjs --read-only [--after=ROW_ID] [--limit=1..100] [--statistics]' }))
  process.exitCode = 1
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
  await pool?.end()
}
