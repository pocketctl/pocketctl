#!/bin/bash
# M-7: docker-entrypoint-initdb.d script — runs once on an EMPTY data volume
# as the bootstrap superuser. Creates the application role (pocketctl_app)
# with the minimum privileges Relay needs and hands the application database
# to it. The admin (POSTGRES_USER) stays a separate maintenance identity.
#
# Secrets are passed as psql variables and referenced with :'var' / :"var"
# so no value is ever interpolated into the SQL source or the shell.
set -euo pipefail

: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

if [[ "$POSTGRES_USER" == "pocketctl_app" ]]; then
  echo "refusing to bootstrap: application role must not be the bootstrap admin" >&2
  exit 1
fi
if [[ "$POSTGRES_APP_PASSWORD" == "$POSTGRES_PASSWORD" ]]; then
  echo "refusing to bootstrap: application and admin passwords must differ" >&2
  exit 1
fi
if [[ ${#POSTGRES_APP_PASSWORD} -lt 24 || ! "$POSTGRES_APP_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "refusing to bootstrap: POSTGRES_APP_PASSWORD must be at least 24 URI-unreserved characters" >&2
  exit 1
fi

# .sh init scripts do not inherit the entrypoint's -U/-d defaults: connect
# explicitly as the bootstrap role (there is no OS-user "postgres" role when
# POSTGRES_USER is customized).
{
  # Password is URI-unreserved, so it cannot terminate this psql assignment.
  # Deliver it on stdin so it never appears in docker exec/psql process argv.
  printf "\\set app_password '%s'\n" "$POSTGRES_APP_PASSWORD"
  cat <<'SQL'
\if :{?app_password}
\else
\echo 'app_password variable is missing'
\quit
\endif
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
              :'app_role', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec
ALTER ROLE pocketctl_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
-- The application owns its database: Relay initDB needs CREATE on schema
-- public (durable-ingress tables, indexes, ALTERs on upgrade).
ALTER DATABASE :"db_name" OWNER TO pocketctl_app;
SQL
} | psql -X -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --set=app_role=pocketctl_app \
  --set=db_name="$POSTGRES_DB"

touch "${PGDATA:?PGDATA is required}/.pocketctl-role-split-v1"
chmod 600 "${PGDATA}/.pocketctl-role-split-v1"

echo "pocketctl_app role and database ownership configured"
