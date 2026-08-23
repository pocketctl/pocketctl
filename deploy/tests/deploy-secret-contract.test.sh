#!/bin/bash
# M-7 deploy.sh secret contract: placeholder rejection, fail-fast, and never
# echoing secrets. Runs deploy.sh in --check-secrets mode only (no system
# changes). Exit 0 = contract holds.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail() { echo "FAIL: $1" >&2; exit 1; }

SENTINEL_PW="Sentinel-Password-9f8e7d6c"
SENTINEL_DOMAIN="deploy-contract.example.test"

run_check() { bash deploy/deploy.sh --check-secrets; }

# 1. Default placeholder domain/password must abort.
if DOMAIN="pocketctl.yourdomain.com" \
  POSTGRES_ADMIN_PASSWORD="$SENTINEL_PW-admin" POSTGRES_APP_PASSWORD="$SENTINEL_PW-app" \
  run_check >/tmp/deploy-check-1.out 2>&1; then
  fail "placeholder domain must be rejected"
fi
if DOMAIN="$SENTINEL_DOMAIN" \
  POSTGRES_ADMIN_PASSWORD="change-me-to-a-strong-db-password" POSTGRES_APP_PASSWORD="$SENTINEL_PW-app" \
  run_check >/tmp/deploy-check-2.out 2>&1; then
  fail "placeholder password must be rejected"
fi
if DOMAIN="$SENTINEL_DOMAIN" \
  POSTGRES_ADMIN_PASSWORD="" POSTGRES_APP_PASSWORD="$SENTINEL_PW-app" \
  run_check >/tmp/deploy-check-3.out 2>&1; then
  fail "empty password must be rejected"
fi
if DOMAIN="$SENTINEL_DOMAIN" \
  POSTGRES_ADMIN_PASSWORD="short" POSTGRES_APP_PASSWORD="$SENTINEL_PW-app" \
  run_check >/tmp/deploy-check-4.out 2>&1; then
  fail "too-short password must be rejected"
fi
if DOMAIN="$SENTINEL_DOMAIN" \
  POSTGRES_ADMIN_PASSWORD="$SENTINEL_PW-admin" POSTGRES_APP_PASSWORD="$SENTINEL_PW-admin" \
  run_check >/tmp/deploy-check-5.out 2>&1; then
  fail "admin and app passwords must differ"
fi

# 2. Valid values pass the check phase without leaking any secret.
DOMAIN="$SENTINEL_DOMAIN" \
  POSTGRES_ADMIN_PASSWORD="$SENTINEL_PW-admin" POSTGRES_APP_PASSWORD="$SENTINEL_PW-app" \
  run_check >/tmp/deploy-check-ok.out 2>&1 || fail "valid configuration must pass --check-secrets"

for f in /tmp/deploy-check-ok.out; do
  grep -q "$SENTINEL_PW" "$f" && fail "secret value leaked to output"
  grep -qi "api.key\|API_KEY" "$f" && fail "API key output must be gone"
done

# 3. Syntax check of the full script.
bash -n deploy/deploy.sh || fail "deploy.sh has syntax errors"

echo "Deploy secret contract passed"
