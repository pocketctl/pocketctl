#!/usr/bin/env bash

# GitHub HTTPS can stall before it returns a transport error. Bound each git
# attempt with Git's HTTP timeouts, then retry the transport operation a small,
# configurable number of times.
github_sync_run_with_timeout() {
  local timeout_seconds="$1"
  shift

  if command -v timeout >/dev/null 2>&1; then
    env GIT_TERMINAL_PROMPT=0 timeout --foreground "${timeout_seconds}s" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    env GIT_TERMINAL_PROMPT=0 gtimeout --foreground "${timeout_seconds}s" "$@"
  elif command -v perl >/dev/null 2>&1; then
    env GIT_TERMINAL_PROMPT=0 perl -e 'alarm(shift @ARGV); exec { $ARGV[0] } @ARGV' "$timeout_seconds" "$@"
  else
    printf 'No timeout command is available for GitHub sync.\n' >&2
    return 127
  fi
}

github_sync_git_with_retry() {
  local label="$1"
  shift

  local max_attempts="${GITHUB_SYNC_RETRY_ATTEMPTS:-3}"
  local retry_delay="${GITHUB_SYNC_RETRY_DELAY_SECONDS:-2}"
  local connect_timeout="${GITHUB_SYNC_CONNECT_TIMEOUT_SECONDS:-15}"
  local low_speed_timeout="${GITHUB_SYNC_LOW_SPEED_TIMEOUT_SECONDS:-30}"
  local transport_timeout="${GITHUB_SYNC_TRANSPORT_TIMEOUT_SECONDS:-60}"

  if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ && "$retry_delay" =~ ^[0-9]+$ && "$connect_timeout" =~ ^[1-9][0-9]*$ && "$low_speed_timeout" =~ ^[1-9][0-9]*$ && "$transport_timeout" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Invalid GitHub sync retry configuration\n' >&2
    return 2
  fi

  local attempt
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if github_sync_run_with_timeout "$transport_timeout" git \
      -c "http.connectTimeout=${connect_timeout}" \
      -c "http.lowSpeedLimit=1" \
      -c "http.lowSpeedTime=${low_speed_timeout}" \
      "$@"; then
      return 0
    fi

    if (( attempt < max_attempts )); then
      printf 'GitHub %s failed (attempt %d/%d); retrying in %ss...\n' \
        "$label" "$attempt" "$max_attempts" "$((retry_delay * attempt))" >&2
      sleep "$((retry_delay * attempt))"
    fi
  done

  printf 'GitHub %s failed after %d attempts.\n' "$label" "$max_attempts" >&2
  return 1
}
