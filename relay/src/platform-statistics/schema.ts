import {relaySharedTarget} from '../schema-runtime.js'
import type { Pool } from 'pg'
import { platformStatisticsConfig } from './config.js'

/** Additive forward collector. Never backfill activity from mutable snapshots. */
export async function ensurePlatformStatisticsSchema(pool: Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>, env: NodeJS.ProcessEnv = process.env, options:{migrate?:boolean}={}): Promise<void> {
  const config = platformStatisticsConfig(env)
  if (!config.enabled) return
  if (!config.valid) throw new Error('Invalid platform statistics exclusion configuration')
  if(!options.migrate&&(env.RELAY_SCHEMA_STARTUP==='verify'||await relaySharedTarget(pool))){
    const result=await pool.query(`SELECT to_regclass('public.platform_statistics_coverage') IS NOT NULL
      AND to_regclass('public.platform_statistics_collectors') IS NOT NULL
      AND to_regclass('public.platform_statistics_facts') IS NOT NULL
      AND to_regclass('public.platform_statistics_gaps') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.users')
        AND tgname='platform_statistics_account_delete' AND tgenabled IN('O','A')
        AND tgfoid=to_regprocedure('public.platform_statistics_delete_account()')) AS ready`)
    if(!result.rows[0]?.ready)throw Error('platform_statistics_migrator_required')
    return
  }
  const client = typeof pool.connect === 'function' ? await pool.connect() : null
  const target = client ?? pool
  try {
    if (client) {
      await client.query('BEGIN')
      if(options.migrate)await client.query('SET LOCAL search_path=public,pg_catalog')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-statistics-schema-v1'))")
    }
    await target.query(`
    CREATE TABLE IF NOT EXISTS platform_statistics_coverage (
      metric TEXT PRIMARY KEY, starts_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE IF NOT EXISTS platform_statistics_collectors (
      channel TEXT PRIMARY KEY CHECK(channel IN ('relay','materializer')),
      last_seen TIMESTAMPTZ NOT NULL
    );
    INSERT INTO platform_statistics_coverage(metric) VALUES ('newUsers'),('activeUsers'),('sessions') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS platform_statistics_facts (
      kind TEXT NOT NULL CHECK (kind IN ('registration','human','session')),
      source_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT, occurred_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(kind,source_id)
    );
    CREATE INDEX IF NOT EXISTS platform_statistics_facts_time ON platform_statistics_facts(occurred_at,kind);
    CREATE INDEX IF NOT EXISTS platform_statistics_facts_user ON platform_statistics_facts(user_id);
    CREATE INDEX IF NOT EXISTS platform_statistics_inbox_unresolved_time ON event_inbox(received_at)
      WHERE status IN (0,1,3) AND event_type IN ('session_created','session_status','user_message_receipt','agent_text');
    CREATE TABLE IF NOT EXISTS platform_statistics_gaps (
      metric TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL, CHECK (starts_at < ends_at)
    );
    CREATE OR REPLACE FUNCTION platform_statistics_delete_account() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $stats$
    BEGIN
      INSERT INTO platform_statistics_gaps(metric,starts_at,ends_at,reason)
      SELECT CASE kind WHEN 'registration' THEN 'newUsers' WHEN 'human' THEN 'activeUsers' ELSE 'sessions' END,
        date_trunc('day',min(occurred_at) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai',
        (date_trunc('day',max(occurred_at) AT TIME ZONE 'Asia/Shanghai') + interval '1 day') AT TIME ZONE 'Asia/Shanghai',
        'account_deleted'
      FROM platform_statistics_facts WHERE user_id=OLD.id GROUP BY kind;
      -- Installation ownership disappears during account deletion. Invalidate
      -- usage history rather than quietly losing those actors from distincts.
      IF EXISTS (SELECT 1 FROM extension_installations WHERE owner_user_id=OLD.id) THEN
        INSERT INTO platform_statistics_gaps(metric,starts_at,ends_at,reason)
        SELECT metric,starts_at,clock_timestamp(),'account_deleted'
        FROM platform_statistics_coverage WHERE metric='activeUsers';
        INSERT INTO platform_statistics_gaps(metric,starts_at,ends_at,reason)
        SELECT usage.metric,starts_at,clock_timestamp(),'account_deleted'
        FROM platform_statistics_coverage CROSS JOIN (VALUES ('memoryUsers'),('readRequests')) AS usage(metric)
        WHERE platform_statistics_coverage.metric='activeUsers';
      END IF;
      DELETE FROM platform_statistics_facts WHERE user_id=OLD.id;
      RETURN OLD;
    END $stats$;
    DROP TRIGGER IF EXISTS platform_statistics_account_delete ON users;
    CREATE TRIGGER platform_statistics_account_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION platform_statistics_delete_account();
    CREATE OR REPLACE FUNCTION platform_statistics_detach_actor() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $stats$
    BEGIN
      INSERT INTO platform_statistics_gaps(metric,starts_at,ends_at,reason)
      SELECT metric,coverage.starts_at,clock_timestamp(),'actor_identity_detached'
      FROM (VALUES ('activeUsers'),('memoryUsers'),('readRequests')) AS affected(metric)
      CROSS JOIN (SELECT starts_at FROM platform_statistics_coverage WHERE metric='activeUsers') AS coverage;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $stats$;
    DROP TRIGGER IF EXISTS platform_statistics_installation_detach ON extension_installations;
    CREATE TRIGGER platform_statistics_installation_detach BEFORE UPDATE OF owner_user_id ON extension_installations
      FOR EACH ROW WHEN (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id) EXECUTE FUNCTION platform_statistics_detach_actor();
    DROP TRIGGER IF EXISTS platform_statistics_installation_delete ON extension_installations;
    CREATE TRIGGER platform_statistics_installation_delete BEFORE DELETE ON extension_installations
      FOR EACH ROW EXECUTE FUNCTION platform_statistics_detach_actor();
    DROP TRIGGER IF EXISTS platform_statistics_membership_detach ON extension_scope_memberships;
    CREATE TRIGGER platform_statistics_membership_detach BEFORE UPDATE OF user_id ON extension_scope_memberships
      FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id) EXECUTE FUNCTION platform_statistics_detach_actor();
    DROP TRIGGER IF EXISTS platform_statistics_membership_delete ON extension_scope_memberships;
    CREATE TRIGGER platform_statistics_membership_delete BEFORE DELETE ON extension_scope_memberships
      FOR EACH ROW EXECUTE FUNCTION platform_statistics_detach_actor();
    `)
    if (client) await client.query('COMMIT')
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client?.release() }
}
