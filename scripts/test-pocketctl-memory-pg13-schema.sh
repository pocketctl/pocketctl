#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
container_name="pocketctl-memory-pg13-schema-$$"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  echo 'Memory PostgreSQL 13 schema gate requires docker' >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo 'Memory PostgreSQL 13 schema gate requires a running Docker daemon' >&2
  exit 1
}

docker run --rm -d \
  --name "$container_name" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
  -e POSTGRES_PASSWORD=memory-pg13-admin-test \
  -p 127.0.0.1::5432 \
  postgres:13-alpine >/dev/null

ready=false
for _ in $(seq 1 30); do
  if docker exec "$container_name" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || {
  echo 'Memory PostgreSQL 13 schema gate database did not become ready' >&2
  exit 1
}

docker exec "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres \
  -c "CREATE ROLE pocketctl_memory_pg13_test LOGIN PASSWORD 'pocketctl_memory_pg13_test' NOSUPERUSER" >/dev/null
docker exec "$container_name" createdb -U postgres \
  -O pocketctl_memory_pg13_test pocketctl_memory_pg13_test
docker exec "$container_name" psql -X -v ON_ERROR_STOP=1 -U postgres \
  -d pocketctl_memory_pg13_test \
  -c 'ALTER SCHEMA public OWNER TO pocketctl_memory_pg13_test' >/dev/null

host_port=$(docker port "$container_name" 5432/tcp | sed -n 's/.*://p' | tail -1)
[[ "$host_port" =~ ^[0-9]+$ ]] || {
  echo 'Memory PostgreSQL 13 schema gate could not resolve the loopback port' >&2
  exit 1
}

cd "$repo_root/memory"
RUN_MEMORY_POSTGRES_INTEGRATION=1 \
MEMORY_TEST_DATABASE_URL="postgresql://pocketctl_memory_pg13_test:pocketctl_memory_pg13_test@127.0.0.1:${host_port}/pocketctl_memory_pg13_test" \
  npx vitest run --no-file-parallelism src/__tests__/schema-postgres.integration.test.ts

echo 'Memory PostgreSQL 13 schema gate passed'
