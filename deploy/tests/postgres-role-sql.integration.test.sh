#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
sql="$repo_root/deploy/postgres/configure-roles.sql"
[[ -f "$sql" ]] || { echo "postgres role SQL integration failed: missing $sql" >&2; exit 1; }

container="pocketctl-role-sql-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" \
  -e POSTGRES_PASSWORD=throwaway-bootstrap-password \
  -v "$sql:/opt/pocketctl/configure-roles.sql:ro" \
  postgres:17-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null 2>&1 \
  || { echo "postgres role SQL integration failed: postgres not ready" >&2; exit 1; }

run_sql() {
	local admin_password=$1 app_password=$2
	{
		printf "\\set admin_superuser false\n"
		printf "\\set adminpass '%s'\n" "$admin_password"
    printf "\\set apppass '%s'\n" "$app_password"
    cat "$sql"
  } | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
}

if {
	printf "\\set adminpass '%s'\n" 'admin-without-topology-0123456789'
	printf "\\set apppass '%s'\n" 'app-without-topology-012345678901'
	cat "$sql"
} | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null 2>&1; then
	echo "postgres role SQL integration failed: missing admin_superuser topology mode was accepted" >&2
	exit 1
fi

if {
	printf "\\set admin_superuser sometimes\n"
	printf "\\set adminpass '%s'\n" 'admin-invalid-topology-0123456789'
	printf "\\set apppass '%s'\n" 'app-invalid-topology-012345678901'
	cat "$sql"
} | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null 2>&1; then
	echo "postgres role SQL integration failed: invalid admin_superuser topology mode was accepted" >&2
	exit 1
fi

run_sql 'admin-safe-password-0123456789' 'app-safe-password-0123456789'
run_sql 'admin-rotated-password-012345' 'app-rotated-password-012345'

cat "$repo_root/deploy/postgres/check-existing-ownership.sql" \
  | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d pocketctl >/dev/null \
  || { echo "postgres role SQL integration failed: clean app-owned database failed the ownership gate" >&2; exit 1; }

role_rows=$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "SELECT rolname || ':' || rolsuper || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolreplication FROM pg_roles WHERE rolname IN ('pocketctl_admin','pocketctl_app') ORDER BY rolname")
[[ "$role_rows" == $'pocketctl_admin:false:false:false:false\npocketctl_app:false:false:false:false' ]] \
  || { echo "postgres role SQL integration failed: privilege rows=$role_rows" >&2; exit 1; }

owner=$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='pocketctl'")
[[ "$owner" == pocketctl_app ]] \
  || { echo "postgres role SQL integration failed: owner=$owner" >&2; exit 1; }

verifiers=$(docker exec "$container" psql -X -U postgres -d postgres -Atc \
  "SELECT count(*) FROM pg_authid WHERE rolname IN ('pocketctl_admin','pocketctl_app') AND rolpassword LIKE 'SCRAM-SHA-256$%'")
[[ "$verifiers" == 2 ]] \
  || { echo "postgres role SQL integration failed: SCRAM verifier count=$verifiers" >&2; exit 1; }

docker exec -e PGPASSWORD='app-rotated-password-012345' "$container" \
  psql -X -h 127.0.0.1 -U pocketctl_app -d pocketctl -Atc 'SELECT 1' \
  | grep -qx 1 || { echo "postgres role SQL integration failed: app login/query failed" >&2; exit 1; }

echo "postgres role SQL integration passed"
