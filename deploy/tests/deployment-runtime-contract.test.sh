#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
helpers="$repo_root/deploy/lib/deployment-helpers.sh"
deploy_script="$repo_root/deploy/deploy.sh"
volume_gate="$repo_root/deploy/postgres/check-volume-migration.sh"
compose="$repo_root/docker-compose.prod.yml"
migration_runbook="$repo_root/deploy/postgres/migrate-existing-superuser.md"
extension_env_validator="$repo_root/relay/dist/extensions/validate-production-env.js"

fail() {
  echo "deployment runtime contract failed: $*" >&2
  exit 1
}

[[ -f "$helpers" ]] || fail "missing deployment helper library"
grep -q 'load_relay_env_value RELAY_EXTENSIONS RELAY_EXTENSIONS RELAY_EXTENSIONS' "$deploy_script" \
  || fail "redeploy does not preserve the Extension mode"
extension_validation_line=$(grep -n 'validate-production-env.js.*RELAY_ENV_STAGED' "$deploy_script" | cut -d: -f1)
postgres_mutation_line=$(grep -n '^# ---------- 5\. 配置 PostgreSQL' "$deploy_script" | cut -d: -f1)
[[ -n "$extension_validation_line" && -n "$postgres_mutation_line" \
  && "$extension_validation_line" -lt "$postgres_mutation_line" ]] \
  || fail "Relay runtime Extension validation must precede every PostgreSQL mutation"
for persisted in EXTENSION_PROVIDER_JWT_SECRET EXTENSION_CURSOR_SECRET \
  EXTENSION_GRANT_PRIVATE_KEY_B64 EXTENSION_GRANT_PUBLIC_KEY_B64 \
  RELAY_EXTENSION_PROJECTOR_BATCH RELAY_EXTENSION_FEED_RETENTION_DAYS \
  RELAY_EXTENSION_LEASE_TTL_SECONDS RELAY_EXTENSION_RATE_LIMIT_FEED; do
  grep -q "load_relay_env_value .* ${persisted} ${persisted}" "$deploy_script" \
    || fail "redeploy does not preserve ${persisted}"
done
# shellcheck source=/dev/null
source "$helpers"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

# Release identity must come from the Git worktree that actually contains the
# Relay being built. A nearby deploy-script checkout cannot vouch for copied
# or modified source bytes.
relay_sha=$(pocketctl_resolve_clean_git_sha "$repo_root/relay")
[[ "$relay_sha" == "$(git -C "$repo_root" rev-parse HEAD)" ]] \
  || fail "Relay source identity does not match its containing worktree"
non_git_relay="$fixture/non-git-relay"
mkdir -p "$non_git_relay"
printf '{}\n' > "$non_git_relay/package.json"
if pocketctl_resolve_clean_git_sha "$non_git_relay" >/dev/null 2>&1; then
  fail "non-Git copied Relay source was assigned an unverifiable identity"
fi

# Dependency installation is generated build input, not Relay source. The
# public GitHub mirror intentionally omits the private root .gitignore, so the
# identity gate must ignore node_modules itself while continuing to reject
# actual untracked source files.
unignored_repo="$fixture/unignored-repo"
mkdir -p "$unignored_repo/relay/node_modules/example"
printf '{"name":"identity-fixture"}\n' > "$unignored_repo/relay/package.json"
printf 'generated dependency\n' > "$unignored_repo/relay/node_modules/example/index.js"
git -C "$unignored_repo" init -q
git -C "$unignored_repo" add relay/package.json
git -C "$unignored_repo" \
  -c user.name=PocketCtl -c user.email=pocketctl@example.invalid \
  commit -qm 'test: seed clean relay source'
generated_sha=$(pocketctl_resolve_clean_git_sha "$unignored_repo/relay")
[[ "$generated_sha" == "$(git -C "$unignored_repo" rev-parse HEAD)" ]] \
  || fail "generated Relay dependencies changed the resolved source identity"
printf 'untracked source\n' > "$unignored_repo/relay/untracked.ts"
if pocketctl_resolve_clean_git_sha "$unignored_repo/relay" >/dev/null 2>&1; then
  fail "untracked Relay source was assigned a clean release identity"
fi

# Generated database credentials must be URI-unreserved so they can be used in
# PostgreSQL userinfo without ambiguous parsing or percent-encoding bugs.
for _ in $(seq 1 32); do
  secret=$(pocketctl_generate_url_safe_secret)
  [[ ${#secret} -ge 32 ]] || fail "generated secret is too short"
  [[ "$secret" =~ ^[A-Za-z0-9._~-]+$ ]] || fail "generated secret is not URL-safe"
done
pocketctl_validate_database_password TEST_DB_PASSWORD 'safe-Database_Password.0123456789~' \
  || fail "valid URL-safe database password was rejected"
if pocketctl_validate_database_password TEST_DB_PASSWORD 'unsafe/password+value' >/dev/null 2>&1; then
  fail "unsafe database password was accepted"
fi

# Render the exact production EnvironmentFile consumed by systemd, then parse
# its DATABASE_URL with Node's WHATWG URL implementation (the Relay boundary).
env_file="$fixture/relay.env"
DOMAIN=relay.contract.test
RELAY_PORT=8080
POSTGRES_APP_PASSWORD='safe-Database_Password.0123456789~'
JWT_SECRET_VALUE='jwt-secret-0123456789abcdef0123456789abcdef'
AUTH_CODE_PEPPER_VALUE='pepper-0123456789abcdef0123456789abcdef'
RELAY_EXTENSIONS=enabled
EXTENSION_PROVIDER_JWT_SECRET_VALUE='provider-jwt-secret-0123456789abcdef'
EXTENSION_CURSOR_SECRET_VALUE='cursor-secret-0123456789abcdef0123'
grant_private_key="$fixture/extension-grant-private.pem"
grant_public_key="$fixture/extension-grant-public.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$grant_private_key" >/dev/null 2>&1
openssl pkey -in "$grant_private_key" -pubout -out "$grant_public_key" >/dev/null 2>&1
EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE=$(openssl base64 -A -in "$grant_private_key")
EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE=$(openssl base64 -A -in "$grant_public_key")
EXTENSION_GRANT_KEY_ID_VALUE='grant-key-2026-08'
EXTENSION_PROVIDER_PUBLIC_ORIGINS_VALUE='{"pocketctl-memory":"https://memory.relay.contract.test"}'
RELAY_EXTENSION_PROJECTOR_BATCH_VALUE=123
RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE=14
RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE=90
QUOTA_ENFORCEMENT=enforce
RELEASE_VERSION_VALUE=v9.8.7
GIT_SHA_VALUE=0123456789abcdef0123456789abcdef01234567
BUILD_TIME_VALUE=2026-08-18T00:00:00Z
APNS_KEY_PATH_VALUE=
APNS_KEY_ID_VALUE=
APNS_TEAM_ID_VALUE=
APNS_BUNDLE_ID_VALUE=com.pocketctl.app
APNS_ENVIRONMENT_VALUE=production
pocketctl_write_relay_production_env "$env_file"

[[ $(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file") == 600 ]] \
  || fail "production env file must be mode 0600"
for expected in \
  'NODE_ENV=production' \
  'POCKETCTL_MODE=self-hosted' \
  'ALLOWED_ORIGINS=https://relay.contract.test' \
  'WEB_APP_URL=https://relay.contract.test' \
  'PUBLIC_ISSUER_URL=https://relay.contract.test' \
  'RELEASE_VERSION=v9.8.7' \
  'GIT_SHA=0123456789abcdef0123456789abcdef01234567' \
  'BUILD_TIME=2026-08-18T00:00:00Z'; do
  grep -qxF "$expected" "$env_file" || fail "production env missing $expected"
done
for expected in \
  'RELAY_EXTENSIONS=enabled' \
  'EXTENSION_PROVIDER_JWT_SECRET=provider-jwt-secret-0123456789abcdef' \
  'EXTENSION_CURSOR_SECRET=cursor-secret-0123456789abcdef0123' \
  'EXTENSION_GRANT_KEY_ID=grant-key-2026-08' \
  'RELAY_EXTENSION_PROJECTOR_BATCH=123' \
  'RELAY_EXTENSION_FEED_RETENTION_DAYS=14' \
  'RELAY_EXTENSION_LEASE_TTL_SECONDS=90'; do
  grep -qxF "$expected" "$env_file" || fail "production env missing $expected"
done
grep -qxF "EXTENSION_GRANT_PRIVATE_KEY_B64=$EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE" "$env_file" \
  || fail "production env changed the RSA private key encoding"
grep -qxF "EXTENSION_GRANT_PUBLIC_KEY_B64=$EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE" "$env_file" \
  || fail "production env changed the RSA public key encoding"
[[ -f "$extension_env_validator" ]] || fail "Relay Extension runtime validator was not built"
node "$extension_env_validator" "$env_file" >/dev/null \
  || fail "valid production Extension EnvironmentFile failed runtime validation"
invalid_env_file="$fixture/relay-invalid-key.env"
invalid_private_key_b64=$(printf 'not-a-private-key%.0s' {1..3} | openssl base64 -A)
awk -v replacement="EXTENSION_GRANT_PRIVATE_KEY_B64=$invalid_private_key_b64" \
  '/^EXTENSION_GRANT_PRIVATE_KEY_B64=/{print replacement; next} {print}' \
  "$env_file" > "$invalid_env_file"
if node "$extension_env_validator" "$invalid_env_file" >/dev/null 2>&1; then
  fail "canonical base64 containing a non-PEM private key passed runtime validation"
fi
database_url=$(grep '^DATABASE_URL=' "$env_file" | cut -d= -f2-)
DATABASE_URL="$database_url" EXPECTED_PASSWORD="$POSTGRES_APP_PASSWORD" node <<'NODE'
const parsed = new URL(process.env.DATABASE_URL)
if (parsed.protocol !== 'postgresql:' || parsed.username !== 'pocketctl_app') process.exit(1)
if (parsed.password !== process.env.EXPECTED_PASSWORD) process.exit(2)
NODE

# EnvironmentFile values are not a general shell-escaping surface. Reject an
# inherited secret containing whitespace/metacharacters and preserve the last
# known-good file instead of replacing it with a partial production config.
env_before=$(shasum -a 256 "$env_file" 2>/dev/null || sha256sum "$env_file")
JWT_SECRET_VALUE='invalid secret with spaces'
if pocketctl_write_relay_production_env "$env_file" >/dev/null 2>&1; then
  fail "unsafe JWT secret was accepted for the systemd EnvironmentFile"
fi
env_after=$(shasum -a 256 "$env_file" 2>/dev/null || sha256sum "$env_file")
[[ "$env_before" == "$env_after" ]] || fail "failed env rendering replaced the last known-good file"
JWT_SECRET_VALUE='jwt-secret-0123456789abcdef0123456789abcdef'

# Existing broad md5/trust rules must never shadow PocketCtl's managed SCRAM
# rule. The rewrite is idempotent and preserves local peer administration.
hba="$fixture/pg_hba.conf"
cat > "$hba" <<'HBA'
local   all             postgres                                peer
host    all             all             127.0.0.1/32            md5
host    all             all             ::1/128                 trust
HBA
pocketctl_install_pg_hba_rules "$hba"
first_host=$(awk '!/^[[:space:]]*(#|$)/ && $1 ~ /^host/ { print; exit }' "$hba")
[[ "$first_host" == 'host pocketctl pocketctl_app 127.0.0.1/32 scram-sha-256' ]] \
  || fail "first matching host rule is not the PocketCtl SCRAM rule: $first_host"
before=$(shasum -a 256 "$hba" 2>/dev/null || sha256sum "$hba")
pocketctl_install_pg_hba_rules "$hba"
after=$(shasum -a 256 "$hba" 2>/dev/null || sha256sum "$hba")
[[ "$before" == "$after" ]] || fail "pg_hba rewrite is not idempotent"
grep -qE '^local[[:space:]]+all[[:space:]]+postgres[[:space:]]+peer$' "$hba" \
  || fail "postgres peer administration rule was not preserved"

# PostgreSQL processes include/include_dir records in place. A broad host rule
# in an included file must not run before the managed PocketCtl rules.
included_hba="$fixture/pg_hba-with-include.conf"
cat > "$included_hba" <<'HBA'
local   all             postgres                                peer
include_dir 'conf.d'
host    all             all             127.0.0.1/32            md5
HBA
pocketctl_install_pg_hba_rules "$included_hba"
managed_line=$(grep -n '^# BEGIN pocketctl managed SCRAM rules$' "$included_hba" | cut -d: -f1)
include_line=$(grep -n "^include_dir " "$included_hba" | cut -d: -f1)
[[ "$managed_line" -lt "$include_line" ]] \
  || fail "an include directive can shadow the managed SCRAM rules"

# A truncated/duplicated managed block is ambiguous. Never consume everything
# after a stray BEGIN marker and silently replace the operator's other rules.
broken_hba="$fixture/pg_hba-broken-managed-block.conf"
cat > "$broken_hba" <<'HBA'
local   all             postgres                                peer
# BEGIN pocketctl managed SCRAM rules
host    all             all             127.0.0.1/32            md5
HBA
broken_before=$(shasum -a 256 "$broken_hba" 2>/dev/null || sha256sum "$broken_hba")
if pocketctl_install_pg_hba_rules "$broken_hba" >/dev/null 2>&1; then
  fail "a truncated managed pg_hba block was accepted"
fi
broken_after=$(shasum -a 256 "$broken_hba" 2>/dev/null || sha256sum "$broken_hba")
[[ "$broken_before" == "$broken_after" ]] \
  || fail "failed pg_hba validation modified the original file"

# A pre-existing data volume without the role-split marker must block startup;
# empty or explicitly migrated volumes may proceed.
[[ -x "$volume_gate" ]] || fail "missing executable volume migration gate"
empty_volume="$fixture/empty-volume"
legacy_volume="$fixture/legacy-volume"
migrated_volume="$fixture/migrated-volume"
mkdir -p "$empty_volume" "$legacy_volume" "$migrated_volume"
touch "$legacy_volume/PG_VERSION" "$migrated_volume/PG_VERSION"
touch "$migrated_volume/.pocketctl-role-split-v1"
gate_env=(env POSTGRES_ADMIN_PASSWORD=admin-safe-password-0123456789 POSTGRES_APP_PASSWORD=app-safe-password-012345678901)
"${gate_env[@]}" "$volume_gate" "$empty_volume" >/dev/null || fail "empty volume was rejected"
if env POSTGRES_ADMIN_PASSWORD=admin-safe-password-0123456789 \
  POSTGRES_APP_PASSWORD='unsafe/password+value' "$volume_gate" "$empty_volume" >/dev/null 2>&1; then
  fail "volume gate accepted an unsafe application password"
fi
if "${gate_env[@]}" "$volume_gate" "$legacy_volume" >/dev/null 2>&1; then
  fail "unmigrated existing volume was accepted"
fi
"${gate_env[@]}" "$volume_gate" "$migrated_volume" >/dev/null || fail "migrated volume was rejected"

grep -q 'postgres-volume-gate:' "$compose" || fail "Compose has no volume migration gate service"
grep -q 'condition: service_completed_successfully' "$compose" \
  || fail "Postgres is not ordered after the migration gate"
grep -q 'pocketctl_app.*SELECT 1' "$compose" \
  || fail "Postgres healthcheck does not authenticate and query as pocketctl_app"
grep -qF '.pocketctl-role-split-v1' "$migration_runbook" \
  || fail "existing-volume runbook does not document the migration marker"
grep -qF 'check-volume-migration.sh' "$migration_runbook" \
  || fail "existing-volume runbook does not require a final gate verification"

echo "deployment runtime contract passed"
