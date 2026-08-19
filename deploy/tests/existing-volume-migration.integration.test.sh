#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
container="pocketctl-existing-migration-test-$$"
old_password=old-superuser-password-0123456789
admin_password=admin-safe-password-0123456789
app_password=app-safe-password-012345678901

legacy_gate_log=""
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  [[ -z "$legacy_gate_log" ]] || rm -f "$legacy_gate_log"
}
trap cleanup EXIT
fail() { echo "existing-volume migration integration failed: $*" >&2; exit 1; }

docker run -d --name "$container" \
  -e POSTGRES_USER=pocketctl -e POSTGRES_PASSWORD="$old_password" -e POSTGRES_DB=pocketctl \
  -v "$repo_root/deploy/postgres/configure-roles.sql:/opt/pocketctl/configure-roles.sql:ro" \
  -v "$repo_root/deploy/postgres/check-volume-migration.sh:/opt/pocketctl/check-volume-migration.sh:ro" \
  postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$container" pg_isready -U pocketctl -d pocketctl >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U pocketctl -d pocketctl >/dev/null 2>&1 \
  || fail "legacy PostgreSQL did not become ready"

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d pocketctl <<'SQL' >/dev/null
CREATE TABLE legacy_owned_data(id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO legacy_owned_data VALUES (1, 'preserved');
SQL

legacy_gate_log=$(mktemp)
if cat "$repo_root/deploy/postgres/check-existing-ownership.sql" \
  | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d pocketctl \
    >"$legacy_gate_log" 2>&1; then
  fail "ownership gate accepted a legacy-owned database"
fi
grep -q 'existing PocketCtl database ownership migration required' "$legacy_gate_log" \
  || fail "ownership gate did not explain the required migration"
rm -f "$legacy_gate_log"
legacy_gate_log=""

{
	printf "\\set admin_superuser true\n"
	printf "\\set adminpass '%s'\n" "$admin_password"
	printf "\\set apppass '%s'\n" "$app_password"
  cat "$repo_root/deploy/postgres/configure-roles.sql"
} | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d postgres >/dev/null

cat "$repo_root/deploy/postgres/migrate-existing-ownership.sql" \
  | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d pocketctl >/dev/null

cat "$repo_root/deploy/postgres/check-existing-ownership.sql" \
  | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d pocketctl >/dev/null \
  || fail "ownership gate rejected a completed migration"

value=$(docker exec -e PGPASSWORD="$app_password" "$container" \
  psql -X -h 127.0.0.1 -U pocketctl_app -d pocketctl -Atc \
  "SELECT value FROM legacy_owned_data WHERE id=1")
[[ "$value" == preserved ]] || fail "application role could not read migrated data"

docker exec -e PGPASSWORD="$app_password" "$container" \
  psql -X -h 127.0.0.1 -U pocketctl_app -d pocketctl -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE migration_smoke(id integer); DROP TABLE migration_smoke;' >/dev/null \
  || fail "application role cannot perform Relay DDL after migration"

new_old_password=retired-old-role-password-0123456789
printf "\\set old_pw '%s'\nALTER ROLE pocketctl PASSWORD :'old_pw';\n" "$new_old_password" \
  | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d postgres >/dev/null
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U pocketctl -d postgres \
  -c 'ALTER ROLE pocketctl_admin SUPERUSER CREATEDB CREATEROLE; ALTER ROLE pocketctl NOLOGIN' >/dev/null

docker exec "$container" sh -ceu \
  'test -f "$PGDATA/PG_VERSION"; install -m 600 /dev/null "$PGDATA/.pocketctl-role-split-v1"'
docker exec \
  -e POSTGRES_ADMIN_PASSWORD="$admin_password" -e POSTGRES_APP_PASSWORD="$app_password" \
  "$container" /bin/sh /opt/pocketctl/check-volume-migration.sh /var/lib/postgresql/data >/dev/null \
  || fail "migration marker did not satisfy the volume gate"

roles=$(docker exec -e PGPASSWORD="$admin_password" "$container" \
  psql -X -h 127.0.0.1 -U pocketctl_admin -d postgres -Atc \
  "SELECT rolname || ':' || rolsuper || ':' || rolcanlogin FROM pg_roles WHERE rolname IN ('pocketctl','pocketctl_admin','pocketctl_app') ORDER BY rolname")
[[ "$roles" == $'pocketctl:true:false\npocketctl_admin:true:true\npocketctl_app:false:true' ]] \
	|| fail "post-migration maintenance/app role boundary is wrong: $roles"

# The documented migration is repeatable after cutover. Re-running it through
# the only login-capable maintenance superuser must neither self-demote that
# role nor abort halfway through password rotation.
{
	printf "\\set admin_superuser true\n"
	printf "\\set adminpass '%s'\n" "$admin_password"
	printf "\\set apppass '%s'\n" "$app_password"
	cat "$repo_root/deploy/postgres/configure-roles.sql"
} | docker exec -e PGPASSWORD="$admin_password" -i "$container" \
	psql -X -h 127.0.0.1 -v ON_ERROR_STOP=1 -U pocketctl_admin -d postgres >/dev/null \
	|| fail "role configuration was not repeatable after Compose cutover"

admin_after_rerun=$(docker exec -e PGPASSWORD="$admin_password" "$container" \
	psql -X -h 127.0.0.1 -U pocketctl_admin -d postgres -Atc \
	"SELECT rolsuper || ':' || rolcanlogin FROM pg_roles WHERE rolname='pocketctl_admin'")
[[ "$admin_after_rerun" == 'true:true' ]] \
	|| fail "repeat role configuration demoted the maintenance superuser: $admin_after_rerun"

echo "existing-volume migration integration passed"
