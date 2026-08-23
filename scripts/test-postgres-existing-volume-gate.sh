#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

project="pocketctl-volume-gate-test-$$"
volume="${project}_pgdata"

cleanup() {
  docker compose -p "$project" -f docker-compose.prod.yml down -v >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "existing-volume migration gate failed: $*" >&2; exit 1; }

export POSTGRES_ADMIN_PASSWORD="throwaway-admin-password-0123456789"
export POSTGRES_APP_PASSWORD="throwaway-app-password-012345678901"
export TLS_CERT_PATH=/tmp/does-not-matter
export TLS_KEY_PATH=/tmp/does-not-matter
export AUTH_CODE_PEPPER=throwaway-pepper-32-characters-aaaaaaaa
export JWT_SECRET=throwaway-jwt-32-characters-aaaaaaaaaaa

docker volume create "$volume" >/dev/null
docker run --rm -v "$volume:/var/lib/postgresql/data" postgres:17-alpine \
  sh -c "printf '17\n' > /var/lib/postgresql/data/PG_VERSION"

set +e
compose_output=$(docker compose -p "$project" -f docker-compose.prod.yml up -d postgres 2>&1)
compose_status=$?
set -e

[[ $compose_status -ne 0 ]] || fail "Compose accepted an unmarked existing pgdata volume"
gate_log=$(docker compose -p "$project" -f docker-compose.prod.yml logs --no-color postgres-volume-gate 2>&1 || true)
grep -q 'existing PostgreSQL volume is not approved for the pocketctl_admin/pocketctl_app role split' <<<"$gate_log" \
  || fail "gate failure did not explain the required migration"

postgres_id=$(docker compose -p "$project" -f docker-compose.prod.yml ps -aq postgres)
if [[ -n "$postgres_id" ]]; then
  running=$(docker inspect -f '{{.State.Running}}' "$postgres_id")
  [[ "$running" == false ]] || fail "Postgres started despite the failed migration gate"
fi

echo "existing-volume migration gate passed"
