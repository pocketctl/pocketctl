#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
init_script="$repo_root/deploy/postgres/001-create-app-role.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

fail() { echo "postgres init secret contract failed: $*" >&2; exit 1; }

mkdir -p "$fixture/bin" "$fixture/pgdata"
cat > "$fixture/bin/psql" <<'PSQL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$PSQL_ARGV_CAPTURE"
cat > "$PSQL_STDIN_CAPTURE"
PSQL
chmod +x "$fixture/bin/psql"

export PATH="$fixture/bin:$PATH"
export POSTGRES_USER=pocketctl_admin
export POSTGRES_DB=pocketctl
export POSTGRES_PASSWORD=admin-safe-password-0123456789
export PGDATA="$fixture/pgdata"
export PSQL_ARGV_CAPTURE="$fixture/psql.argv"
export PSQL_STDIN_CAPTURE="$fixture/psql.stdin"

POSTGRES_APP_PASSWORD='unsafe/password+value' \
  bash "$init_script" >/dev/null 2>&1 && fail "unsafe app password was accepted"
[[ ! -e "$PSQL_ARGV_CAPTURE" ]] || fail "psql ran before unsafe password rejection"

export POSTGRES_APP_PASSWORD=app-safe-password-012345678901
bash "$init_script" >/dev/null
[[ -f "$PGDATA/.pocketctl-role-split-v1" ]] || fail "successful initialization did not write the marker"
! grep -Fq "$POSTGRES_APP_PASSWORD" "$PSQL_ARGV_CAPTURE" \
  || fail "application password leaked into psql argv"
grep -Fq "\\set app_password '$POSTGRES_APP_PASSWORD'" "$PSQL_STDIN_CAPTURE" \
  || fail "application password was not delivered through stdin"

echo "postgres init secret contract passed"
