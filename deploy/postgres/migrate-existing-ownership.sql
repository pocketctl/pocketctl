\set ON_ERROR_STOP on

BEGIN;

ALTER DATABASE pocketctl OWNER TO pocketctl_app;
ALTER SCHEMA public OWNER TO pocketctl_app;

-- REASSIGN OWNED is unsafe for legacy images where the old POSTGRES_USER is
-- also the bootstrap superuser: it owns PostgreSQL-required system objects.
-- Move only user objects outside pg_catalog/information_schema.
SELECT format('ALTER TABLE %I.%I OWNER TO pocketctl_app', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE r.rolname = 'pocketctl'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  AND c.relkind IN ('r', 'p')
\gexec

SELECT format('ALTER SEQUENCE %I.%I OWNER TO pocketctl_app', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE r.rolname = 'pocketctl'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  AND c.relkind = 'S'
\gexec

SELECT format(
  'ALTER %s %I.%I OWNER TO pocketctl_app',
  CASE c.relkind
    WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATERIALIZED VIEW'
    WHEN 'f' THEN 'FOREIGN TABLE'
  END,
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE r.rolname = 'pocketctl'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  AND c.relkind IN ('v', 'm', 'f')
\gexec

SELECT format(
  'ALTER %s %I.%I(%s) OWNER TO pocketctl_app',
  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
  n.nspname,
  p.proname,
  pg_get_function_identity_arguments(p.oid)
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE r.rolname = 'pocketctl'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  AND p.prokind IN ('f', 'p', 'w')
\gexec

SELECT format(
  'ALTER %s %I.%I OWNER TO pocketctl_app',
  CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
  n.nspname,
  t.typname
)
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_roles r ON r.oid = t.typowner
WHERE r.rolname = 'pocketctl'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
  AND t.typtype IN ('d', 'e')
\gexec

GRANT CONNECT ON DATABASE pocketctl TO pocketctl_admin;
GRANT USAGE ON SCHEMA public TO pocketctl_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pocketctl_admin;

COMMIT;
