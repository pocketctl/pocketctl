#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

fail() {
  echo "production deploy hardening contract failed: $*" >&2
  exit 1
}

entries=(
  "$repo_root/scripts/deploy.sh"
  "$repo_root/deploy/deploy.sh"
  "$repo_root/deploy/systemd/pocketctl-relay.service"
  "$repo_root/deploy/systemd/pocketctl-relay-worker.service"
  "$repo_root/deploy/systemd/pocketctl-memory-api.service"
  "$repo_root/deploy/systemd/pocketctl-memory-worker.service"
)
for entry in "${entries[@]}"; do
  [[ -f "$entry" ]] || fail "missing deploy entry: $entry"
done

# --- no legacy root/md5/HTTP-only path survives in any public entry ----------

for entry in "${entries[@]}"; do
  ! grep -q 'User=root' "$entry" || fail "$entry still contains User=root"
  ! grep -Eq '(^|[^a-z])md5([^a-z]|$)' "$entry" || fail "$entry still references md5 auth"
  ! grep -q "sed -i 's/ident/" "$entry" || fail "$entry still rewrites pg_hba ident rules globally"
  ! grep -q "sed -i 's/peer/" "$entry" || fail "$entry still rewrites pg_hba peer rules globally"
  ! grep -q 'POCKETCTL_API_KEY' "$entry" || fail "$entry still requires or writes POCKETCTL_API_KEY"
done

# --- the Alibaba legacy script must be a hard-exit stub ----------------------

stub="$repo_root/scripts/deploy.sh"
if bash "$stub" >/dev/null 2>&1; then
  fail "scripts/deploy.sh must exit non-zero instead of deploying"
fi
stub_output="$(bash "$stub" 2>&1 || true)"
echo "$stub_output" | grep -q 'deploy/deploy.sh' \
  || fail "scripts/deploy.sh must point operators at deploy/deploy.sh"
! grep -qE 'apt-get install|yum install|git pull|CREATE DATABASE|systemctl restart' "$stub" \
  || fail "scripts/deploy.sh must not retain deployment logic"

# --- the official script must harden PostgreSQL with SCRAM -------------------

official="$repo_root/deploy/deploy.sh"
grep -q "scram-sha-256" "$official" || fail "official script must set SCRAM password encryption"
grep -q 'listen_addresses' "$official" || fail "official script must pin listen_addresses=localhost"
# Passwords must never be interpolated into SQL command lines.
! grep -Eq "PASSWORD '?\"\$\{DB_PASSWORD\}" "$official" \
  || fail "official script must pass the DB password via psql variables, not command lines"
grep -q 'pg_hba' "$official" || fail "official script must manage a pg_hba rule for the app role"
grep -q 'pre-pocketctl' "$official" || fail "official script must back up pg_hba/postgresql config before editing"
# The local postgres peer rule must stay untouched.
! grep -q "s/peer/scram" "$official" || fail "official script must not rewrite the local peer rule"
grep -q 'pocketctl_resolve_clean_git_sha' "$official" \
  || fail "official script must bind release identity to the actual Relay Git worktree"
! grep -q 'chown -R pocketctl:pocketctl.*relay' "$official" \
  || fail "service user must not own the Relay code or EnvironmentFile parent directory"
grep -q 'chown root:pocketctl "$RELAY_ENV"' "$official" \
  || fail "Relay EnvironmentFile must be root-owned and group-readable by the service"
grep -q 'chmod 640 "$RELAY_ENV"' "$official" \
  || fail "Relay EnvironmentFile must not be writable by the service account"
source_gate_line=$(grep -n 'RELAY_SOURCE_SHA=$(pocketctl_resolve_clean_git_sha' "$official" | head -1 | cut -d: -f1 || true)
build_line=$(grep -n '^npm run build$' "$official" | head -1 | cut -d: -f1 || true)
db_cutover_line=$(grep -n 'cat "$DEPLOY_SCRIPT_DIR/postgres/configure-roles.sql"' "$official" | head -1 | cut -d: -f1 || true)
ownership_gate_line=$(grep -n 'check-existing-ownership.sql' "$official" | head -1 | cut -d: -f1 || true)
env_stage_line=$(grep -n 'pocketctl_write_relay_production_env "$RELAY_ENV_STAGED"' "$official" | head -1 | cut -d: -f1 || true)
[[ -n "$source_gate_line" && -n "$build_line" && -n "$ownership_gate_line" && -n "$env_stage_line" ]] \
  || fail "official script must stage verified Relay code and env before database cutover"
[[ "$source_gate_line" -lt "$db_cutover_line" && "$build_line" -lt "$db_cutover_line" && "$env_stage_line" -lt "$db_cutover_line" ]] \
  || fail "source/build/env failures must occur before PostgreSQL password rotation"
[[ "$ownership_gate_line" -lt "$db_cutover_line" ]] \
  || fail "existing database ownership must be verified before PostgreSQL password rotation"
grep -q '^trap cleanup_deploy_temp EXIT$' "$official" \
  || fail "official script must delete a secret-bearing staged env on every early exit"

# --- official script must serve TLS only (no HTTP-only vhost) ----------------

! grep -q 'listen 80;$' <(grep -A3 'return 30' "$official" >/dev/null && echo ok) || true
http_block=$(awk '/listen 80;/{flag=1} flag{print} flag && /^}/{exit}' <(sed -n '/cat > \/etc\/nginx\/sites-available/,/^EOF$/p' "$official"))
[[ -z "$http_block" ]] || echo "$http_block" | grep -q 'return 30' \
  || fail "official script's port-80 vhost must redirect to HTTPS"
grep -q 'listen 443 ssl' "$official" || fail "official script must serve HTTPS"

# --- systemd units keep the non-root hardened baseline ------------------------

for unit in "$repo_root/deploy/systemd/pocketctl-relay.service" \
            "$repo_root/deploy/systemd/pocketctl-relay-worker.service" \
            "$repo_root/deploy/systemd/pocketctl-memory-api.service" \
            "$repo_root/deploy/systemd/pocketctl-memory-worker.service"; do
  unit_section=$(sed -n '/^\[Unit\]$/,/^\[Service\]$/p' "$unit")
  service_section=$(sed -n '/^\[Service\]$/,/^\[Install\]$/p' "$unit")
  echo "$unit_section" | grep -q '^StartLimitBurst=' \
    || fail "$unit must configure StartLimitBurst in [Unit]"
  echo "$unit_section" | grep -q '^StartLimitIntervalSec=' \
    || fail "$unit must configure StartLimitIntervalSec in [Unit]"
  ! echo "$service_section" | grep -q '^StartLimit' \
    || fail "$unit must not put StartLimit directives in [Service]"
  grep -q 'User=pocketctl' "$unit" || fail "$unit must run as the dedicated user"
  grep -q '^Environment=PATH=/usr/bin:/bin$' "$unit" \
    || fail "$unit must pin the executable lookup path"
  grep -q '^ExecStart=/usr/bin/env node ' "$unit" \
    || fail "$unit must use a verifiable absolute launcher for Node.js"
  grep -q 'NoNewPrivileges=true' "$unit" || fail "$unit must set NoNewPrivileges"
  grep -q 'ProtectSystem=strict' "$unit" || fail "$unit must set ProtectSystem=strict"
  grep -q 'ProtectHome=true' "$unit" || fail "$unit must set ProtectHome"
  grep -q 'PrivateTmp=true' "$unit" || fail "$unit must set PrivateTmp"
  grep -q 'PrivateDevices=true' "$unit" || fail "$unit must set PrivateDevices"
  grep -q 'ProtectKernelTunables=true' "$unit" || fail "$unit must set ProtectKernelTunables"
  grep -q 'ProtectKernelModules=true' "$unit" || fail "$unit must set ProtectKernelModules"
  grep -q 'ProtectControlGroups=true' "$unit" || fail "$unit must set ProtectControlGroups"
  grep -q 'RestrictSUIDSGID=true' "$unit" || fail "$unit must set RestrictSUIDSGID"
  ! grep -q 'ReadWritePaths=.*/relay/logs' "$unit" \
    || fail "$unit must not retain a service-writable directory inside the verified Relay source tree"
done

# Syntax check both scripts.
bash -n "$stub" || fail "scripts/deploy.sh has syntax errors"
bash -n "$official" || fail "deploy/deploy.sh has syntax errors"

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify \
    "$repo_root/deploy/systemd/pocketctl-relay.service" \
    "$repo_root/deploy/systemd/pocketctl-relay-worker.service" \
    "$repo_root/deploy/systemd/pocketctl-memory-api.service" \
    "$repo_root/deploy/systemd/pocketctl-memory-worker.service" \
    || fail "systemd-analyze rejected the units"
else
  echo "NOT RUN: systemd-analyze unavailable (CI/Linux must run it)"
fi

echo "production deploy hardening contract passed"
