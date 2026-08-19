#!/bin/bash
# M-7 database role separation: throwaway compose project + volume only.
# Verifies pocketctl_app is NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION
# yet can perform the DDL/DML Relay initDB needs.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="pocketctl-role-test-$$"
VOLUME="${PROJECT}_pgdata"

cleanup() {
  docker compose -p "$PROJECT" -f docker-compose.prod.yml down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

[[ "$PROJECT" =~ ^pocketctl-role-test-[0-9]+$ ]] || fail "unexpected project name"

export POSTGRES_ADMIN_PASSWORD="throwaway-admin-password-0123456789-$$"
export POSTGRES_APP_PASSWORD="throwaway-app-password-012345678901-$$"
export POSTGRES_PASSWORD="$POSTGRES_ADMIN_PASSWORD"
export TLS_CERT_PATH=/tmp/does-not-matter
export TLS_KEY_PATH=/tmp/does-not-matter
export AUTH_CODE_PEPPER=throwaway-32-characters-aaaaaaaaaaaaa
export JWT_SECRET=throwaway-jwt-32-characters-aaaaaaaaaaaa

[[ "$POSTGRES_ADMIN_PASSWORD" != "$POSTGRES_APP_PASSWORD" ]] || fail "test setup requires distinct passwords"

docker compose -p "$PROJECT" -f docker-compose.prod.yml up -d postgres >/dev/null || fail "postgres up failed"

# Wait for health.
for i in $(seq 1 60); do
  if docker exec "${PROJECT}-postgres-1" pg_isready -U pocketctl_admin >/dev/null 2>&1; then break; fi
  sleep 1
done

container="${PROJECT}-postgres-1"
role_row="$(docker exec "$container" psql -U pocketctl_admin -d pocketctl -tAc \
  "SELECT rolname || ',' || rolsuper || ',' || rolcreatedb || ',' || rolcreaterole || ',' || rolreplication FROM pg_roles WHERE rolname='pocketctl_app'")"
[[ "$role_row" == "pocketctl_app,f,f,f,f" || "$role_row" == "pocketctl_app,false,false,false,false" ]] \
  || fail "pocketctl_app privileges wrong: $role_row"

db_owner="$(docker exec "$container" psql -U pocketctl_admin -d pocketctl -tAc \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='pocketctl'")"
[[ "$db_owner" == "pocketctl_app" ]] || fail "pocketctl database owner is $db_owner, want pocketctl_app"

# App-role DDL/DML smoke: create/drop a table as pocketctl_app.
docker exec "$container" psql -U pocketctl_app -d pocketctl -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE IF NOT EXISTS _role_smoke (id INT PRIMARY KEY); INSERT INTO _role_smoke VALUES (1) ON CONFLICT DO NOTHING; DROP TABLE _role_smoke;" \
  >/dev/null || fail "pocketctl_app DDL/DML smoke failed"

# The app role must NOT be able to escalate.
if docker exec "$container" psql -U pocketctl_app -d pocketctl -c "CREATE ROLE escalate_attempt" >/dev/null 2>&1; then
  fail "pocketctl_app must not be able to CREATE ROLE"
fi

echo "PostgreSQL role separation contract passed (throwaway project: $PROJECT)"
