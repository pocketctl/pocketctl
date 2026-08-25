import type pg from 'pg'

const TEST_DATABASE = 'pocketctl_durable_ingress_test'
const TEST_ROLE = 'pocketctl_durable_ingress_test'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface DurableIngressTestDatabaseConfig {
  database: typeof TEST_DATABASE
  user: typeof TEST_ROLE
}

/**
 * Durable-ingress release tests truncate shared tables.  Their connection URL
 * is intentionally narrower than the project's other integration tests: this
 * gate may only touch a local, purpose-named database owned by its purpose-
 * named role.  Runtime checks below make URL spoofing insufficient.
 */
export function durableIngressTestDatabaseConfig(raw: string): DurableIngressTestDatabaseConfig {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL for the durable-ingress test database')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || decodeURIComponent(url.username) !== TEST_ROLE
    || decodeURIComponent(url.pathname.replace(/^\//, '')) !== TEST_DATABASE
    || url.searchParams.has('options')) {
    throw new Error(
      'TEST_DATABASE_URL must use the loopback pocketctl_durable_ingress_test database and role without options',
    )
  }
  return { database: TEST_DATABASE, user: TEST_ROLE }
}

export async function assertDurableIngressTestDatabase(
  pool: Pick<pg.Pool, 'query'>,
  databaseUrl: string,
): Promise<DurableIngressTestDatabaseConfig> {
  const config = durableIngressTestDatabaseConfig(databaseUrl)
  const result = await pool.query<{
    database: string
    user: string
    schema: string | null
    schemas: string[]
    superuser: boolean
  }>(`
    SELECT current_database() AS database,
           current_user AS "user",
           current_schema() AS schema,
           current_schemas(false)::text[] AS schemas,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
  `)
  const identity = result.rows[0]
  if (!identity
    || identity.database !== config.database
    || identity.user !== config.user
    || identity.schema !== 'public'
    || identity.schemas.length !== 1
    || identity.schemas[0] !== 'public'
    || identity.superuser) {
    throw new Error(
      'Refusing durable-ingress destructive test: database, role, or schema is not the isolated test target',
    )
  }
  return config
}

export async function resetDurableIngressTestDatabase(
  pool: Pick<pg.Pool, 'query'>,
  databaseUrl: string,
): Promise<void> {
  await assertDurableIngressTestDatabase(pool, databaseUrl)
  await pool.query(`
    TRUNCATE
      realtime_outbox,
      event_inbox_receipt,
      event_inbox,
      daemon_ack_checkpoint,
      extension_purge_requests,
      extension_provider_usage_facts,
      extension_provider_status,
      extension_provider_credentials,
      extension_checkpoints,
      extension_feed,
      extension_source_outbox,
      extension_installations,
      extension_providers,
      events,
      subagent_usage_seen,
      subagents,
      deleted_sessions,
      sessions,
      daemons,
      users
    RESTART IDENTITY CASCADE
  `)
}
