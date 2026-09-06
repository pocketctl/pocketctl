#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for the durable-ingress release gate}"

cd "$REPO_ROOT"

go test -p 1 ./internal/protocol ./internal/ws ./internal/session ./internal/daemon ./cmd/pocketctl -count=1
(cd relay && env -u TEST_DATABASE_URL -u RUN_POSTGRES_INTEGRATION npm test && npm run build)
(cd relay && RUN_POSTGRES_INTEGRATION=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run --no-file-parallelism \
  src/__tests__/durable-ingress-fault-postgres.integration.test.ts \
  src/__tests__/mixed-agent-durable-ingress-postgres.integration.test.ts \
  src/__tests__/token-usage-postgres.integration.test.ts \
  src/__tests__/quota-binding-postgres.integration.test.ts \
  src/__tests__/session-message-admission-postgres.integration.test.ts)
make test-opencode-managed
make test-codex-managed
