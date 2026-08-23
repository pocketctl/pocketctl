#!/usr/bin/env sh
set -eu

data_dir=${1:-/var/lib/postgresql/data}
marker="$data_dir/.pocketctl-role-split-v1"

: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"

validate_password() {
  label=$1
  value=$2
  if [ "${#value}" -lt 24 ]; then
    echo "$label must contain at least 24 URI-unreserved characters" >&2
    exit 64
  fi
  case "$value" in
    *[!A-Za-z0-9._~-]*)
      echo "$label must use only URI-unreserved characters: A-Z a-z 0-9 . _ ~ -" >&2
      exit 64
      ;;
  esac
}

validate_password POSTGRES_ADMIN_PASSWORD "$POSTGRES_ADMIN_PASSWORD"
validate_password POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD"
if [ "$POSTGRES_ADMIN_PASSWORD" = "$POSTGRES_APP_PASSWORD" ]; then
  echo "POSTGRES_ADMIN_PASSWORD and POSTGRES_APP_PASSWORD must differ" >&2
  exit 64
fi

# A genuinely empty volume is initialized by the normal Postgres entrypoint,
# whose init script creates the marker only after the app role is ready.
if [ ! -f "$data_dir/PG_VERSION" ]; then
  exit 0
fi

if [ -f "$marker" ]; then
  exit 0
fi

echo "existing PostgreSQL volume is not approved for the pocketctl_admin/pocketctl_app role split" >&2
echo "run deploy/postgres/migrate-existing-superuser.md, verify app-role login/query, then create $marker" >&2
exit 42
