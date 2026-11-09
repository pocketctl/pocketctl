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
      extension_scope_idempotency,
      extension_scope_outbox,
      extension_scope_memberships,
      extension_teams,
      extension_organizations,
      extension_purge_requests,
      extension_provider_usage_facts,
      extension_provider_status,
      extension_provider_credentials,
      extension_checkpoints,
      team_delivery_memory_consumers, team_delivery_memory_withdrawals,
      extension_feed,
      extension_source_outbox,
      extension_installations,
      extension_providers,
      session_aliases,
      events,
      subagent_usage_seen,
      subagents,
      deleted_sessions,
      sessions,
      daemons,
      users
    RESTART IDENTITY CASCADE
  `)
  await resetNativeInputProofFixture(pool,TEST_DATABASE)
}

/** Native routing uses public identities. Schema-only legacy fixtures cannot
 * isolate it with search_path. Reset only this purpose-named non-superuser DB. */
export async function resetDurableIngressPublicSchema(pool:Pick<pg.Pool,'query'>,databaseUrl:string):Promise<void>{
  await assertDurableIngressTestDatabase(pool,databaseUrl)
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
}

/** Test-only reset of this fixture's own body-free proof identity space. The
 * runtime immutable/reuse guards remain installed and are not relaxed. */
export async function resetNativeInputProofFixture(pool:Pick<pg.Pool,'query'>&Partial<Pick<pg.Pool,'connect'>>,expectedDatabase:'pocketctl_durable_ingress_test'|'shared_native_alias_w3_test'):Promise<void>{
 if(typeof pool.connect!=='function')throw Error('native_input_proof_reset_requires_real_client')
 const c=await pool.connect()
 try{
  await c.query('BEGIN')
  const identity=(await c.query(`SELECT current_database() AS database_name,current_user AS role_name,
   (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
   to_regclass('public.native_source_publications') IS NOT NULL AS publications,
   to_regclass('public.native_installation_starts') IS NOT NULL AS starts,
   NOT EXISTS(SELECT 1 FROM pg_class WHERE oid IN(to_regclass('public.native_source_publications'),to_regclass('public.native_installation_starts')) AND relowner<>current_user::regrole) AS owns_proofs`)).rows[0]
  if(!identity||identity.database_name!==expectedDatabase||identity.role_name!==expectedDatabase||identity.superuser!==false||!identity.owns_proofs)throw Error('dedicated_native_input_proof_reset_required')
  if(identity.publications||identity.starts){
   if(!identity.publications||!identity.starts)throw Error('incomplete_native_input_proof_fixture')
   await c.query(`LOCK TABLE public.native_source_publications,public.native_installation_starts IN ACCESS EXCLUSIVE MODE NOWAIT;
    ALTER TABLE public.native_source_publications DISABLE TRIGGER native_input_no_truncate;
    ALTER TABLE public.native_installation_starts DISABLE TRIGGER native_input_no_truncate;
    TRUNCATE public.native_source_publications,public.native_installation_starts;
    ALTER TABLE public.native_source_publications ENABLE TRIGGER native_input_no_truncate;
    ALTER TABLE public.native_installation_starts ENABLE TRIGGER native_input_no_truncate;`)
  }
  await c.query('COMMIT')
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
