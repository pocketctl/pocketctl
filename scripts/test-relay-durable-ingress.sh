#!/usr/bin/env bash
set -euo pipefail

# Durable-ingress release gate: serialized Go core-package tests plus the
# destructive Postgres integration suite. The Relay unit suite, Relay build,
# and the OpenCode/Codex managed terminal gates are owned by
# scripts/release-preflight.sh (steps opencode-managed, codex-managed,
# relay-tests, relay-build) and must not be duplicated here — enforced by
# scripts/tests/release-contract.test.sh
# (openspec/changes/dedupe-local-release-gates).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for the durable-ingress release gate}"

cd "$REPO_ROOT"

go test -p 1 ./internal/protocol ./internal/ws ./internal/session ./internal/daemon ./cmd/pocketctl -count=1
(cd relay && RUN_POSTGRES_INTEGRATION=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run --no-file-parallelism \
  src/__tests__/durable-ingress-fault-postgres.integration.test.ts \
  src/__tests__/mixed-agent-durable-ingress-postgres.integration.test.ts \
  src/__tests__/token-usage-postgres.integration.test.ts \
  src/__tests__/quota-binding-postgres.integration.test.ts \
  src/__tests__/session-message-admission-postgres.integration.test.ts)
