#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
container="pocketctl-relay-production-env-test-$$"
fixture=$(mktemp -d)
relay_pid=

cleanup() {
  if [[ -n "$relay_pid" ]]; then
    kill "$relay_pid" >/dev/null 2>&1 || true
    wait "$relay_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT

fail() {
  echo "relay production env integration failed: $*" >&2
  [[ ! -f "$fixture/relay.log" ]] || tail -80 "$fixture/relay.log" >&2
  exit 1
}

sql="$repo_root/deploy/postgres/configure-roles.sql"
admin_password=admin-safe-password-0123456789
app_password=app-safe-password-012345678901
release_version=v9.8.7
git_sha=0123456789abcdef0123456789abcdef01234567
build_time=2026-08-18T00:00:00Z

docker run -d --name "$container" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$admin_password" postgres:17-alpine >/dev/null
stable_ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
    stable_ready=$((stable_ready + 1))
    if [[ "$stable_ready" -ge 3 ]]; then break; fi
  else
    stable_ready=0
  fi
  sleep 1
done
[[ "$stable_ready" -ge 3 ]] || fail "PostgreSQL did not remain ready"
docker exec "$container" pg_isready -U postgres >/dev/null 2>&1 \
  || fail "PostgreSQL did not become ready"

{
	printf "\\set admin_superuser false\n"
	printf "\\set adminpass '%s'\n" "$admin_password"
  printf "\\set apppass '%s'\n" "$app_password"
  cat "$sql"
} | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null

postgres_port=$(docker port "$container" 5432/tcp | awk -F: 'END { print $NF }')
[[ "$postgres_port" =~ ^[0-9]+$ ]] || fail "could not resolve published PostgreSQL port"
relay_port=$(node -e "const n=require('node:net'),s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

env -u DEV_EMAIL -u DEV_EMAIL_CODE \
  DATABASE_URL="postgresql://pocketctl_app:${app_password}@127.0.0.1:${postgres_port}/pocketctl" \
  PORT="$relay_port" RELAY_HOST=127.0.0.1 NODE_ENV=production POCKETCTL_MODE=self-hosted \
  QUOTA_ENFORCEMENT=enforce \
  JWT_SECRET=jwt-secret-0123456789abcdef0123456789abcdef \
  AUTH_CODE_PEPPER=pepper-0123456789abcdef0123456789abcdef \
  RELAY_EXTENSIONS=off \
  ALLOWED_ORIGINS=https://relay.contract.test \
  WEB_APP_URL=https://relay.contract.test \
  PUBLIC_ISSUER_URL=https://relay.contract.test \
  RELEASE_VERSION="$release_version" GIT_SHA="$git_sha" BUILD_TIME="$build_time" \
  node "$repo_root/relay/dist/server.js" >"$fixture/relay.log" 2>&1 &
relay_pid=$!

health="$fixture/health.json"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${relay_port}/health" -o "$health" 2>/dev/null; then
    break
  fi
  kill -0 "$relay_pid" >/dev/null 2>&1 || fail "Relay exited before becoming healthy"
  sleep 1
done
[[ -s "$health" ]] || fail "Relay health endpoint did not become ready"

EXPECTED_RELEASE="$release_version" EXPECTED_SHA="$git_sha" EXPECTED_BUILD_TIME="$build_time" \
  node - "$health" <<'NODE' || fail "health identity did not match the supplied production environment"
const fs = require('node:fs')
const health = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (health.status !== 'ok') process.exit(1)
if (health.release_version !== process.env.EXPECTED_RELEASE) process.exit(2)
if (health.git_sha !== process.env.EXPECTED_SHA) process.exit(3)
if (health.build_time !== process.env.EXPECTED_BUILD_TIME) process.exit(4)
NODE

echo "relay production env integration passed"
