#!/usr/bin/env bash

# Shared, side-effect-free deployment primitives. deploy/deploy.sh sources
# this file, and the deployment contracts execute the same functions directly.

pocketctl_generate_url_safe_secret() {
  # Hex is cryptographically random and entirely URI-unreserved. Sixty-four
  # characters represent 256 bits, while remaining safe in PostgreSQL userinfo.
  openssl rand -hex 32
}

pocketctl_validate_database_password() {
  local label=$1 value=$2
  if [[ ${#value} -lt 24 ]]; then
    echo "${label} must contain at least 24 URL-safe characters" >&2
    return 1
  fi
  if [[ ! "$value" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    echo "${label} must use only URI-unreserved characters: A-Z a-z 0-9 . _ ~ -" >&2
    return 1
  fi
}

pocketctl_validate_domain() {
  local value=$1
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)+[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]]
}

pocketctl_validate_runtime_identity() {
  local release=$1 sha=$2 build_time=$3
  [[ -n "$release" && "$release" != dev && "$release" != unknown ]] || return 1
  [[ "$release" =~ ^[A-Za-z0-9._+-]+$ ]] || return 1
  [[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || return 1
  [[ "$build_time" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
}

pocketctl_resolve_clean_git_sha() {
  local source_dir=$1 git_top git_prefix status sha scope generated
  [[ -d "$source_dir" ]] || {
    echo "Relay source directory does not exist: $source_dir" >&2
    return 1
  }
  git_top=$(git -C "$source_dir" rev-parse --show-toplevel 2>/dev/null) || {
    echo "Relay source must belong to a Git worktree: $source_dir" >&2
    return 1
  }
  git_prefix=$(git -C "$source_dir" rev-parse --show-prefix 2>/dev/null) || return 1
  scope="${git_prefix:-.}"
  # Generated build inputs/outputs are not Relay source identity. The public
  # GitHub mirror omits the private root .gitignore, so this gate must ignore
  # regenerable artifacts — dependencies, compiled output, runtime logs, and
  # stray tsc artifacts beside sources — while still rejecting untracked or
  # modified source files.
  local excludes=()
  for generated in node_modules dist logs; do
    if [[ "$scope" == "." ]]; then
      excludes+=(":(exclude)$generated")
    else
      excludes+=(":(exclude)${scope}${generated}")
    fi
  done
  if [[ "$scope" == "." ]]; then
    excludes+=(":(exclude,glob)src/**/*.js" ":(exclude,glob)src/**/*.d.ts")
  else
    excludes+=(":(exclude,glob)${scope}src/**/*.js" ":(exclude,glob)${scope}src/**/*.d.ts")
  fi
  status=$(git -C "$git_top" status --porcelain --untracked-files=all -- \
    "$scope" "${excludes[@]}") || return 1
  [[ -z "$status" ]] || {
    echo "Relay source contains tracked or untracked changes; refusing unverifiable release identity" >&2
    return 1
  }
  sha=$(git -C "$git_top" rev-parse HEAD 2>/dev/null) || return 1
  [[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

pocketctl_reject_env_line_breaks() {
  local name=$1 value=$2
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "${name} contains a line break" >&2
    return 1
  fi
}

pocketctl_validate_env_secret() {
  local name=$1 value=$2
  if [[ ${#value} -lt 32 || ! "$value" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
    echo "${name} must contain at least 32 EnvironmentFile-safe characters" >&2
    return 1
  fi
}

pocketctl_validate_optional_env_token() {
  local name=$1 value=$2
  [[ -z "$value" || "$value" =~ ^[A-Za-z0-9._/-]+$ ]] || {
    echo "${name} contains characters unsafe for an unquoted EnvironmentFile value" >&2
    return 1
  }
}

pocketctl_validate_env_base64() {
  local name=$1 value=$2
  if [[ -z "$value" || $(( ${#value} % 4 )) -ne 0 || ! "$value" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
    echo "${name} must be a non-empty canonical base64 EnvironmentFile value" >&2
    return 1
  fi
}

pocketctl_validate_bounded_decimal() {
  local name=$1 value=$2 minimum=$3 maximum=$4
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "${name} must be a positive decimal integer" >&2
    return 1
  }
  (( value >= minimum && value <= maximum )) || {
    echo "${name} must be between ${minimum} and ${maximum}" >&2
    return 1
  }
}

pocketctl_validate_positive_decimal() {
  local name=$1 value=$2
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "${name} must be a positive decimal integer" >&2
    return 1
  }
}

pocketctl_write_relay_production_env() {
  local path=$1
  pocketctl_validate_domain "$DOMAIN" || {
    echo "DOMAIN is not a valid DNS hostname" >&2
    return 1
  }
  pocketctl_validate_database_password POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD" || return 1
  pocketctl_validate_runtime_identity "$RELEASE_VERSION_VALUE" "$GIT_SHA_VALUE" "$BUILD_TIME_VALUE" || {
    echo "release identity is incomplete or invalid" >&2
    return 1
  }
  [[ "$RELAY_PORT" =~ ^[0-9]+$ ]] || return 1
  [[ "$QUOTA_ENFORCEMENT" =~ ^(enforce|observe|off)$ ]] || return 1
  # ADR-0003: the extension platform ships off; operators flip it explicitly
  # after the schema deploy and shadow validation described in the runbook.
  RELAY_EXTENSIONS_VALUE=${RELAY_EXTENSIONS:-off}
  [[ "$RELAY_EXTENSIONS_VALUE" =~ ^(off|shadow|enabled)$ ]] || return 1
  EXTENSION_PROVIDER_JWT_SECRET_VALUE=${EXTENSION_PROVIDER_JWT_SECRET_VALUE:-${EXTENSION_PROVIDER_JWT_SECRET:-}}
  EXTENSION_CURSOR_SECRET_VALUE=${EXTENSION_CURSOR_SECRET_VALUE:-${EXTENSION_CURSOR_SECRET:-}}
  EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE=${EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE:-${EXTENSION_GRANT_PRIVATE_KEY_B64:-}}
  EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE=${EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE:-${EXTENSION_GRANT_PUBLIC_KEY_B64:-}}
  EXTENSION_GRANT_KEY_ID_VALUE=${EXTENSION_GRANT_KEY_ID_VALUE:-${EXTENSION_GRANT_KEY_ID:-}}
  EXTENSION_PROVIDER_PUBLIC_ORIGINS_VALUE=${EXTENSION_PROVIDER_PUBLIC_ORIGINS_VALUE:-${EXTENSION_PROVIDER_PUBLIC_ORIGINS:-}}
  RELAY_EXTENSION_PROJECTOR_BATCH_VALUE=${RELAY_EXTENSION_PROJECTOR_BATCH_VALUE:-${RELAY_EXTENSION_PROJECTOR_BATCH:-200}}
  RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE=${RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE:-${RELAY_EXTENSION_FEED_RETENTION_DAYS:-7}}
  RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE=${RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE:-${RELAY_EXTENSION_LEASE_TTL_SECONDS:-60}}
  RELAY_EXTENSION_RATE_LIMIT_TOKEN_VALUE=${RELAY_EXTENSION_RATE_LIMIT_TOKEN_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_TOKEN:-30}}
  RELAY_EXTENSION_RATE_LIMIT_FEED_VALUE=${RELAY_EXTENSION_RATE_LIMIT_FEED_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_FEED:-120}}
  RELAY_EXTENSION_RATE_LIMIT_ACK_VALUE=${RELAY_EXTENSION_RATE_LIMIT_ACK_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_ACK:-240}}
  RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT_VALUE=${RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT:-60}}
  RELAY_EXTENSION_RATE_LIMIT_STATUS_VALUE=${RELAY_EXTENSION_RATE_LIMIT_STATUS_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_STATUS:-120}}
  RELAY_EXTENSION_RATE_LIMIT_USAGE_VALUE=${RELAY_EXTENSION_RATE_LIMIT_USAGE_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_USAGE:-60}}
  RELAY_EXTENSION_RATE_LIMIT_PURGE_VALUE=${RELAY_EXTENSION_RATE_LIMIT_PURGE_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_PURGE:-60}}
  RELAY_EXTENSION_RATE_LIMIT_GRANT_VALUE=${RELAY_EXTENSION_RATE_LIMIT_GRANT_VALUE:-${RELAY_EXTENSION_RATE_LIMIT_GRANT:-60}}
  pocketctl_validate_env_secret JWT_SECRET_VALUE "$JWT_SECRET_VALUE" || return 1
  pocketctl_validate_env_secret AUTH_CODE_PEPPER_VALUE "$AUTH_CODE_PEPPER_VALUE" || return 1
  if [[ "$RELAY_EXTENSIONS_VALUE" == enabled ]]; then
    pocketctl_validate_env_secret EXTENSION_PROVIDER_JWT_SECRET_VALUE "$EXTENSION_PROVIDER_JWT_SECRET_VALUE" || return 1
    pocketctl_validate_env_secret EXTENSION_CURSOR_SECRET_VALUE "$EXTENSION_CURSOR_SECRET_VALUE" || return 1
    pocketctl_validate_env_base64 EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE "$EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE" || return 1
    pocketctl_validate_env_base64 EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE "$EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE" || return 1
  fi
  pocketctl_validate_bounded_decimal RELAY_EXTENSION_PROJECTOR_BATCH_VALUE "$RELAY_EXTENSION_PROJECTOR_BATCH_VALUE" 1 500 || return 1
  pocketctl_validate_bounded_decimal RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE "$RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE" 1 90 || return 1
  pocketctl_validate_bounded_decimal RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE "$RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE" 10 300 || return 1
  local rate_name
  for rate_name in RELAY_EXTENSION_RATE_LIMIT_TOKEN_VALUE RELAY_EXTENSION_RATE_LIMIT_FEED_VALUE \
    RELAY_EXTENSION_RATE_LIMIT_ACK_VALUE RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT_VALUE \
    RELAY_EXTENSION_RATE_LIMIT_STATUS_VALUE RELAY_EXTENSION_RATE_LIMIT_USAGE_VALUE \
    RELAY_EXTENSION_RATE_LIMIT_PURGE_VALUE RELAY_EXTENSION_RATE_LIMIT_GRANT_VALUE; do
    pocketctl_validate_positive_decimal "$rate_name" "${!rate_name}" || return 1
  done
  local name
  for name in JWT_SECRET_VALUE AUTH_CODE_PEPPER_VALUE APNS_KEY_PATH_VALUE APNS_KEY_ID_VALUE \
    APNS_TEAM_ID_VALUE APNS_BUNDLE_ID_VALUE APNS_ENVIRONMENT_VALUE \
    EXTENSION_PROVIDER_JWT_SECRET_VALUE EXTENSION_CURSOR_SECRET_VALUE \
    EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE \
    EXTENSION_GRANT_KEY_ID_VALUE EXTENSION_PROVIDER_PUBLIC_ORIGINS_VALUE; do
    pocketctl_reject_env_line_breaks "$name" "${!name}" || return 1
  done
  for name in APNS_KEY_PATH_VALUE APNS_KEY_ID_VALUE APNS_TEAM_ID_VALUE APNS_BUNDLE_ID_VALUE \
    APNS_ENVIRONMENT_VALUE; do
    pocketctl_validate_optional_env_token "$name" "${!name}" || return 1
  done

  local previous_umask tmp
  previous_umask=$(umask)
  umask 077
  tmp=$(mktemp "${path}.tmp.XXXXXX") || {
    umask "$previous_umask"
    return 1
  }
  chmod 600 "$tmp" || {
    rm -f "$tmp"
    umask "$previous_umask"
    return 1
  }
  if ! {
    printf 'DATABASE_URL=postgresql://pocketctl_app:%s@localhost:5432/pocketctl\n' "$POSTGRES_APP_PASSWORD"
    printf 'PORT=%s\n' "$RELAY_PORT"
    printf 'NODE_ENV=production\n'
    printf 'POCKETCTL_MODE=self-hosted\n'
    printf 'QUOTA_ENFORCEMENT=%s\n' "$QUOTA_ENFORCEMENT"
    printf 'RELAY_EXTENSIONS=%s\n' "$RELAY_EXTENSIONS_VALUE"
    printf 'EXTENSION_PROVIDER_JWT_SECRET=%s\n' "$EXTENSION_PROVIDER_JWT_SECRET_VALUE"
    printf 'EXTENSION_CURSOR_SECRET=%s\n' "$EXTENSION_CURSOR_SECRET_VALUE"
    printf 'EXTENSION_GRANT_PRIVATE_KEY_B64=%s\n' "$EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE"
    printf 'EXTENSION_GRANT_PUBLIC_KEY_B64=%s\n' "$EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE"
    printf 'EXTENSION_GRANT_KEY_ID=%s\n' "$EXTENSION_GRANT_KEY_ID_VALUE"
    printf 'EXTENSION_PROVIDER_PUBLIC_ORIGINS=%s\n' "$EXTENSION_PROVIDER_PUBLIC_ORIGINS_VALUE"
    printf 'RELAY_EXTENSION_PROJECTOR_BATCH=%s\n' "$RELAY_EXTENSION_PROJECTOR_BATCH_VALUE"
    printf 'RELAY_EXTENSION_FEED_RETENTION_DAYS=%s\n' "$RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE"
    printf 'RELAY_EXTENSION_LEASE_TTL_SECONDS=%s\n' "$RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_TOKEN=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_TOKEN_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_FEED=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_FEED_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_ACK=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_ACK_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_STATUS=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_STATUS_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_USAGE=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_USAGE_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_PURGE=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_PURGE_VALUE"
    printf 'RELAY_EXTENSION_RATE_LIMIT_GRANT=%s\n' "$RELAY_EXTENSION_RATE_LIMIT_GRANT_VALUE"
    printf 'JWT_SECRET=%s\n' "$JWT_SECRET_VALUE"
    printf 'AUTH_CODE_PEPPER=%s\n' "$AUTH_CODE_PEPPER_VALUE"
    printf 'ALLOWED_ORIGINS=https://%s\n' "$DOMAIN"
    printf 'WEB_APP_URL=https://%s\n' "$DOMAIN"
    printf 'PUBLIC_ISSUER_URL=https://%s\n' "$DOMAIN"
    printf 'RELEASE_VERSION=%s\n' "$RELEASE_VERSION_VALUE"
    printf 'GIT_SHA=%s\n' "$GIT_SHA_VALUE"
    printf 'BUILD_TIME=%s\n' "$BUILD_TIME_VALUE"
    printf 'APNS_KEY_PATH=%s\n' "$APNS_KEY_PATH_VALUE"
    printf 'APNS_KEY_ID=%s\n' "$APNS_KEY_ID_VALUE"
    printf 'APNS_TEAM_ID=%s\n' "$APNS_TEAM_ID_VALUE"
    printf 'APNS_BUNDLE_ID=%s\n' "$APNS_BUNDLE_ID_VALUE"
    printf 'APNS_ENVIRONMENT=%s\n' "$APNS_ENVIRONMENT_VALUE"
  } > "$tmp"; then
    rm -f "$tmp"
    umask "$previous_umask"
    return 1
  fi
  if ! mv -f "$tmp" "$path"; then
    rm -f "$tmp"
    umask "$previous_umask"
    return 1
  fi
  umask "$previous_umask"
}

pocketctl_install_pg_hba_rules() {
  local path=$1
  [[ -f "$path" ]] || {
    echo "pg_hba file does not exist: $path" >&2
    return 1
  }
  if ! awk '
    BEGIN { open = 0; begins = 0; ends = 0; invalid = 0 }
    /^# BEGIN pocketctl managed SCRAM rules$/ {
      if (open || begins > 0) invalid = 1
      open = 1
      begins++
      next
    }
    /^# END pocketctl managed SCRAM rules$/ {
      if (!open) invalid = 1
      open = 0
      ends++
      next
    }
    END {
      if (open || invalid) exit 1
      if (!((begins == 0 && ends == 0) || (begins == 1 && ends == 1))) exit 1
    }
  ' "$path"; then
    echo "pg_hba contains a truncated, nested, or duplicate PocketCtl managed block" >&2
    return 1
  fi
  local tmp mode
  tmp=$(mktemp "${path}.pocketctl.XXXXXX") || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path") || {
    rm -f "$tmp"
    return 1
  }
  awk '
    BEGIN { in_managed = 0; inserted = 0 }
    /^# BEGIN pocketctl managed SCRAM rules$/ { in_managed = 1; next }
    /^# END pocketctl managed SCRAM rules$/ { in_managed = 0; next }
    in_managed { next }
    function emit_rules() {
      print "# BEGIN pocketctl managed SCRAM rules"
      print "host pocketctl pocketctl_app 127.0.0.1/32 scram-sha-256"
      print "host pocketctl pocketctl_app ::1/128 scram-sha-256"
      print "# END pocketctl managed SCRAM rules"
      inserted = 1
    }
    # include/include_dir records are expanded in place and can contain broad
    # host rules, so managed rules must also precede the first active include.
    !inserted && $0 !~ /^[[:space:]]*(#|$)/ && ($1 ~ /^host/ || $1 ~ /^include/) { emit_rules() }
    { print }
    END { if (!inserted) emit_rules() }
  ' "$path" > "$tmp" || {
    rm -f "$tmp"
    return 1
  }
  chmod "$mode" "$tmp" || {
    rm -f "$tmp"
    return 1
  }
  if stat -c '%u:%g' "$path" >/dev/null 2>&1; then
    chown "$(stat -c '%u:%g' "$path")" "$tmp" || {
      rm -f "$tmp"
      return 1
    }
  fi
  mv -f "$tmp" "$path"
}
