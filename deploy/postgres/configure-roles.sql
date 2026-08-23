\set ON_ERROR_STOP on

\if :{?adminpass}
\else
DO $$ BEGIN RAISE EXCEPTION 'adminpass variable is missing'; END $$;
\endif
\if :{?apppass}
\else
DO $$ BEGIN RAISE EXCEPTION 'apppass variable is missing'; END $$;
\endif
\if :{?admin_superuser}
\else
DO $$ BEGIN RAISE EXCEPTION 'admin_superuser topology variable is missing'; END $$;
\endif

SELECT :'admin_superuser' IN ('true', 'false') AS admin_superuser_valid
\gset
\if :admin_superuser_valid
\else
DO $$ BEGIN RAISE EXCEPTION 'admin_superuser topology variable must be true or false'; END $$;
\endif

SET password_encryption = 'scram-sha-256';

\if :admin_superuser
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L SUPERUSER CREATEDB CREATEROLE NOREPLICATION',
  'pocketctl_admin', :'adminpass'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pocketctl_admin')
\gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L SUPERUSER CREATEDB CREATEROLE NOREPLICATION',
  'pocketctl_admin', :'adminpass'
)
\gexec
\else
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'pocketctl_admin', :'adminpass'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pocketctl_admin')
\gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'pocketctl_admin', :'adminpass'
)
\gexec
\endif

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'pocketctl_app', :'apppass'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pocketctl_app')
\gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'pocketctl_app', :'apppass'
)
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', 'pocketctl', 'pocketctl_app')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'pocketctl')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', 'pocketctl', 'pocketctl_app')
\gexec
