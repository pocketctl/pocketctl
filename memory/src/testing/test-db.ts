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
  'memory_skill_publication_policy_versions',
  'memory_skill_publication_policy_heads',
  'memory_skill_publication_heads',
  'memory_skill_publication_events',
  'memory_skill_version_revocations',
  'memory_skill_rollouts',
  'memory_skill_executions',
  'memory_skill_replay_runs',
  'memory_skill_replay_cases',
  'memory_skills',
  'memory_skill_versions',
  'memory_skill_heads',
  'memory_skill_review_decisions',
  'memory_skill_audit_events',
  'memory_skill_archives',
  'memory_skill_archive_sources',
  'memory_skill_tasks',
  'memory_skill_task_runs',
  'memory_skill_candidates',
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
  'memory_provider_budget_reservations',
  'memory_source_snapshots',
  'memory_source_blobs',
  'memory_source_snapshot_entries',
  'memory_code_graph_versions',
  'memory_code_graph_heads',
  'memory_code_nodes',
  'memory_code_edges',
  'memory_wikis',
  'memory_wiki_heads',
  'memory_wiki_build_runs',
  'memory_wiki_build_sources',
  'memory_wiki_build_candidates',
  'memory_wiki_versions',
  'memory_wiki_pages',
  'memory_wiki_sections',
  'memory_wiki_source_bindings',
  'memory_wiki_manual_section_versions',
  'memory_wiki_manual_section_heads',
  'memory_wiki_stale_marks',
  'memory_source_snapshot_tombstones',
  'memory_repository_tombstones',
  'memory_wiki_audit_events',
  'memory_phase4_authorization_audit_events',
] as const
