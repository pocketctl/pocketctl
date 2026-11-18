import type pg from 'pg'

const utcToday = "(statement_timestamp() AT TIME ZONE 'UTC')::date"
// A snapshot issued just before UTC midnight may include the previous oldest
// day until its signed token expires. Near-midnight normalized source
// timestamps can legitimately fall on the following UTC day.
const minDay = `${utcToday}-365`
const maxDay = `${utcToday}+1`

const sources = {
  usage_token_projection: {
    columns: "owner_user_id, daemon_id, (occurred_at AT TIME ZONE 'UTC')::date AS day",
    projection: true,
  },
  usage_call_facts: {
    columns: "owner_user_id, daemon_id, (occurred_at AT TIME ZONE 'UTC')::date AS day",
  },
  usage_skill_facts: {
    columns: "owner_user_id, daemon_id, (occurred_at AT TIME ZONE 'UTC')::date AS day",
  },
  token_daily_stats: {
    columns: 'user_id AS owner_user_id, daemon_id, date AS day',
    legacy: true,
  },
  token_usage_facts: {
    columns: 'user_id AS owner_user_id, daemon_id, usage_date AS day',
    legacy: true,
  },
  usage_source_metadata: { columns: '', legacy: true },
} as const

const operations = ['INSERT', 'UPDATE', 'DELETE'] as const

function invalidationTriggers(): string {
  return Object.entries(sources).flatMap(([table, source]) =>
    operations.map(operation => {
      const old = operation !== 'INSERT' ? 'history_old' : undefined
      const next = operation !== 'DELETE' ? 'history_new' : undefined
      const changes = [old, next].filter(Boolean)
      const transitionTables = [
        old && `OLD TABLE AS ${old}`,
        next && `NEW TABLE AS ${next}`,
      ].filter(Boolean).join(' ')

      const legacy = 'legacy' in source ? source.legacy : undefined
      const affected = source.columns
        ? changes.map(relation => `SELECT ${source.columns}, ${Boolean(legacy)} AS legacy FROM ${relation}`)
        : changes.map(relation => `
          SELECT f.user_id AS owner_user_id, f.daemon_id, f.usage_date AS day, TRUE AS legacy
          FROM ${relation} m JOIN public.token_usage_facts f USING (fact_key)`)

      if ('projection' in source) {
        // A projection's existence can affect residuals on the original legacy
        // fact date. Occurred-at and model corrections do not change the match
        // while this projection key exists.
        const columns = 'owner_user_id, daemon_id, source_session, logical_usage_id'
        const keys = (relation: string) => `SELECT ${columns} FROM ${relation}`
        const changedKeys = old && next
          ? `(${keys(old)} EXCEPT ${keys(next)}) UNION ALL (${keys(next)} EXCEPT ${keys(old)})`
          : `SELECT DISTINCT ${columns} FROM ${old ?? next}`
        affected.push(`
          SELECT f.user_id AS owner_user_id, f.daemon_id, f.usage_date AS day, TRUE AS legacy
          FROM (${changedKeys}) k
          JOIN public.usage_source_metadata m USING (source_session, logical_usage_id)
          JOIN public.token_usage_facts f ON f.fact_key=m.fact_key
            AND f.user_id=k.owner_user_id AND f.daemon_id=k.daemon_id
            AND f.usage_date BETWEEN ${minDay} AND ${maxDay}`)
      }

      // Do not require a rollup to exist yet. A concurrent rollup can
      // commit before this change, and a signed read in between must not
      // accept the changed residual under its earlier watermark.
      // Queue current-day writes too: a transaction can span UTC midnight.
      const name = `history_${table}_${operation.toLowerCase()}`
      return `
        CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $invalidate$
        BEGIN
          IF TG_RELID<>'public.${table}'::regclass OR TG_OP<>'${operation}' THEN
            RAISE EXCEPTION 'unexpected usage history source';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM public.usage_history_owners) THEN RETURN NULL; END IF;
          INSERT INTO usage_history_private.invalidations AS queued
            (transaction_id, owner_user_id, daemon_id, day, legacy)
          SELECT txid_current(), a.owner_user_id, a.daemon_id, a.day, bool_or(a.legacy)
          FROM (${affected.join(' UNION ALL ')}) a
          JOIN public.usage_history_owners e USING (owner_user_id)
          JOIN public.users u ON u.id=e.owner_user_id
          WHERE a.day BETWEEN ${minDay} AND ${maxDay}
          GROUP BY a.owner_user_id, a.daemon_id, a.day
          ON CONFLICT (transaction_id, owner_user_id, daemon_id, day) DO UPDATE
          SET legacy=queued.legacy OR EXCLUDED.legacy
          WHERE EXCLUDED.legacy AND NOT queued.legacy;
          RETURN NULL;
        END
        $invalidate$;
        REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
        DROP TRIGGER IF EXISTS ${name} ON public.${table};
        CREATE TRIGGER ${name} AFTER ${operation} ON public.${table}
          REFERENCING ${transitionTables} FOR EACH STATEMENT EXECUTE FUNCTION public.${name}();
      `
    })
  ).join('\n')
}

export async function initHistorySchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.usage_history_owners (
      owner_user_id INT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS public.usage_history_days (
      owner_user_id INT NOT NULL REFERENCES public.usage_history_owners(owner_user_id) ON DELETE CASCADE,
      daemon_id TEXT NOT NULL,
      day DATE NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1,
      built_revision BIGINT,
      tokens JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tokens)='array'),
      residual JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(residual)='array'),
      calls JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(calls)='array'),
      skills JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(skills)='array'),
      retry_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
      PRIMARY KEY (owner_user_id, daemon_id, day)
    );
    ALTER TABLE public.usage_scope_changes ADD COLUMN IF NOT EXISTS legacy_day BOOLEAN NOT NULL DEFAULT FALSE;

    -- Scratch rows are private to the writing transaction. On commit the
    -- deferred trigger consumes the entire set after source locks have been
    -- taken. On rollback PostgreSQL discards the staged rows.
    CREATE SCHEMA IF NOT EXISTS usage_history_private;
    REVOKE ALL ON SCHEMA usage_history_private FROM PUBLIC;
    CREATE UNLOGGED TABLE IF NOT EXISTS usage_history_private.invalidations (
      transaction_id BIGINT NOT NULL,
      owner_user_id INT NOT NULL,
      daemon_id TEXT NOT NULL,
      day DATE NOT NULL,
      legacy BOOLEAN NOT NULL,
      PRIMARY KEY (transaction_id, owner_user_id, daemon_id, day)
    );
    REVOKE ALL ON TABLE usage_history_private.invalidations FROM PUBLIC;
    CREATE OR REPLACE FUNCTION usage_history_private.flush_invalidations() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $flush$
    BEGIN
      IF TG_RELID<>'usage_history_private.invalidations'::regclass OR TG_OP<>'INSERT'
        OR NEW.transaction_id<>txid_current() THEN
        RAISE EXCEPTION 'unexpected usage history invalidation transaction';
      END IF;
      -- Additional deferred events see no rows for this transaction. No other
      -- trigger writes back to this table during the flush.
      WITH pending AS (
        DELETE FROM usage_history_private.invalidations WHERE transaction_id=NEW.transaction_id
        RETURNING owner_user_id, daemon_id, day, legacy
      ), eligible AS MATERIALIZED (
        SELECT e.owner_user_id
        FROM public.usage_history_owners e
        JOIN (SELECT DISTINCT owner_user_id FROM pending) p USING (owner_user_id)
        JOIN public.users u ON u.id=e.owner_user_id
        ORDER BY e.owner_user_id FOR KEY SHARE OF e
      ), dirty AS (
        INSERT INTO public.usage_history_days AS h (owner_user_id, daemon_id, day)
        SELECT p.owner_user_id, p.daemon_id, p.day
        FROM pending p JOIN eligible e USING (owner_user_id)
        ORDER BY p.owner_user_id, p.daemon_id, p.day
        ON CONFLICT (owner_user_id, daemon_id, day) DO UPDATE SET revision=h.revision+1
        RETURNING owner_user_id, daemon_id, day
      )
      INSERT INTO public.usage_scope_changes(owner_user_id, daemon_id, from_at, to_exclusive, legacy_day)
      SELECT p.owner_user_id, p.daemon_id, p.day::timestamp AT TIME ZONE 'UTC',
        (p.day+1)::timestamp AT TIME ZONE 'UTC', TRUE
      FROM pending p JOIN dirty USING (owner_user_id, daemon_id, day)
      WHERE p.legacy AND p.day<${utcToday};
      RETURN NULL;
    END
    $flush$;
    REVOKE ALL ON FUNCTION usage_history_private.flush_invalidations() FROM PUBLIC;
    DROP TRIGGER IF EXISTS flush_usage_history_invalidations ON usage_history_private.invalidations;
    CREATE CONSTRAINT TRIGGER flush_usage_history_invalidations AFTER INSERT ON usage_history_private.invalidations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION usage_history_private.flush_invalidations();

    CREATE INDEX IF NOT EXISTS usage_history_dirty_days
      ON public.usage_history_days(day DESC, owner_user_id, daemon_id)
      WHERE built_revision IS DISTINCT FROM revision;
    CREATE INDEX IF NOT EXISTS usage_history_retention ON public.usage_history_days(day);
    CREATE INDEX IF NOT EXISTS usage_source_metadata_history_key
      ON public.usage_source_metadata(source_session, logical_usage_id) INCLUDE (fact_key);

    ${invalidationTriggers()}
  `)
}

export async function assertHistorySchema(db: Pick<pg.Pool, 'query'>, options: { write?: boolean } = {}): Promise<void> {
  const privileges = options.write ? ['SELECT', 'UPDATE', 'DELETE'] : ['SELECT']
  const result = await db.query<{ ready: boolean }>(`
    SELECT COALESCE(bool_and(has_table_privilege(current_user,
      to_regclass('public.usage_history_days'), privilege)), FALSE)
      AND COALESCE(has_table_privilege(current_user,
        to_regclass('public.usage_history_owners'), 'SELECT'), FALSE) AS ready
    FROM unnest($1::text[]) AS p(privilege)
  `, [privileges])
  if (!result.rows[0]?.ready) throw new Error('usage_history_schema_not_ready')
}
