import pg from 'pg'
import {assertDurableIngressTestDatabase, durableIngressTestDatabaseConfig} from './durable-ingress-test-db.js'

// Read-only fail-fast probe. Never log connection strings or driver errors.
let pool: pg.Pool | undefined
try {
  const url = process.env.TEST_DATABASE_URL ?? ''
  durableIngressTestDatabaseConfig(url)
  pool = new pg.Pool({connectionString: url, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000})
  await assertDurableIngressTestDatabase(pool, url)
  console.log('Durable-ingress database identity and connectivity verified.')
} catch {
  console.error('Durable-ingress database preparation failed; verify the dedicated loopback non-superuser database and credentials.')
  process.exitCode = 1
} finally {
  await pool?.end()
}
