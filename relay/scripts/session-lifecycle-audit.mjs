#!/usr/bin/env node
import pg from 'pg'
import { spawnSync } from 'node:child_process'
import { sessionLifecycleConfig } from '../dist/session-lifecycle/config.js'
import { SessionLifecycleScanner } from '../dist/session-lifecycle/scanner.js'

const config = sessionLifecycleConfig(process.env)
if (config.mode === 'off') {
  console.log(
    JSON.stringify({ mode: 'off', candidates: [], databaseAccessed: false }),
  )
} else {
  if (config.mode !== 'observe')
    throw new Error('read-only audit requires observe mode')
  const raw = process.env.SESSION_LIFECYCLE_AUDIT_DATABASE_URL
  if (!raw)
    throw new Error('explicit SESSION_LIFECYCLE_AUDIT_DATABASE_URL required')
  const url = new URL(raw)
  // Production audit authorization/credentials are a later release operation.
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/pocketctl_session_lifecycle_test' ||
    decodeURIComponent(url.username) !== 'pocketctl_session_lifecycle_test' ||
    url.search
  )
    throw new Error('dedicated loopback lifecycle test database required')
  const pool = new pg.Pool({
    connectionString: raw,
    max: 1,
    options:
      '-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const scanner = new SessionLifecycleScanner(client, config)
    const afterRowId = Number(
      process.env.SESSION_LIFECYCLE_AUDIT_AFTER_ROW_ID ?? '0',
    )
    const page = await scanner.scanPage({
      afterRowId,
      limit: config.batchSessions,
    })
    await client.query('COMMIT')
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim()
    console.log(
      JSON.stringify(
        {
          ...page,
          sourceRevision: revision,
          note: 'Preliminary isolated-test inventory. Logical payload bytes are not physical disk savings.',
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
