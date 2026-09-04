#!/usr/bin/env node
/**
 * Mock pocketctl-memory consumer E2E runner (ADR-0003 Task 12).
 *
 * The flow lives in src/__tests__/extension-platform-e2e-postgres.integration.test.ts
 * so it stays under the same strict test-database guardrails as every other
 * destructive PostgreSQL suite. This script refuses to run against anything
 * that is not the purpose-named durable-ingress test database, then invokes
 * the suite. It never touches production URLs, tokens or accounts.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl) {
  console.error('TEST_DATABASE_URL is required for the extension platform E2E')
  process.exit(1)
}
let url
try {
  url = new URL(databaseUrl)
} catch {
  console.error('TEST_DATABASE_URL must be a PostgreSQL URL')
  process.exit(1)
}
const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
const user = decodeURIComponent(url.username)
if (!/test/i.test(database) || user !== database) {
  console.error('extension E2E may only run against the loopback purpose-named test database')
  process.exit(1)
}
delete url // keep the URL object out of any later mistake below

const repoRoot = new URL('../..', import.meta.url).pathname
const result = spawnSync(
  'npx', ['vitest', 'run', '--no-file-parallelism',
    'src/__tests__/extension-platform-e2e-postgres.integration.test.ts'],
  {
    cwd: `${repoRoot}/relay`,
    stdio: 'inherit',
    env: {
      ...process.env,
      RUN_POSTGRES_INTEGRATION: '1',
      TEST_DATABASE_URL: databaseUrl,
    },
  },
)
process.exit(result.status ?? 1)
