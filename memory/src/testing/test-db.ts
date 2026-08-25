/**
 * Fail-closed guard for Memory PostgreSQL integration tests. The destructive
 * suites may only run against a purpose-named local test database whose role
 * equals the database name; anything else must refuse before a connection is
 * even attempted. Error messages never echo the URL or its password.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface MemoryTestDatabaseConfig {
  database: string
  user: string
}

export function memoryTestDatabaseConfig(raw: string): MemoryTestDatabaseConfig {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('MEMORY_TEST_DATABASE_URL must be a PostgreSQL URL')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(url.username)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || !database.includes('test')
    || user !== database
    || url.searchParams.has('options')) {
    throw new Error(
      'MEMORY_TEST_DATABASE_URL must target a loopback database whose name contains "test" and whose username equals the database name, without options',
    )
  }
  return { database, user }
}

export async function assertMemoryTestDatabase(
  pool: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
  databaseUrl: string,
): Promise<MemoryTestDatabaseConfig> {
  const config = memoryTestDatabaseConfig(databaseUrl)
  const result = await pool.query(`
    SELECT current_database() AS database,
           current_user AS "user",
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
  `)
  const identity = result.rows[0] as
    | { database: string; user: string; superuser: boolean }
    | undefined
  if (!identity
    || identity.database !== config.database
    || identity.user !== config.user
    || identity.superuser) {
    throw new Error(
      'Refusing memory integration test: connected database or role is not the isolated test target',
    )
  }
  return config
}

export const MEMORY_TEST_DATABASE_TABLES = [
  'memory_schema_migrations',
  'memory_provider_state',
  'memory_installations',
  'memory_feed_inbox',
  'memory_snapshot_runs',
  'memory_snapshot_events',
  'source_sessions',
  'source_events',
  'source_turns',
  'source_artifacts',
  'repositories',
  'repo_snapshots',
  'work_episodes',
  'memory_jobs',
  'memory_dead_letters',
  'memory_session_tombstones',
  'memory_purge_receipts',
  'memory_usage_outbox',
] as const
