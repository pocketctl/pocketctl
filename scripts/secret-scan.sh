#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

tmp_files="$(mktemp)"
trap 'rm -f "$tmp_files"' EXIT

{
  git ls-files -z
  git ls-files --others --exclude-standard -z
} | tr '\0' '\n' | awk '
  NF &&
  $0 !~ /^scripts\/secret-scan\.sh$/ &&
  $0 !~ /^scripts\/sync-github\.sh$/ &&
  $0 !~ /(^|\/)package-lock\.json$/ &&
  $0 !~ /(^|\/)node_modules\// &&
  $0 !~ /(^|\/)dist\// &&
  $0 !~ /(^|\/)build\// &&
  $0 !~ /(^|\/)coverage\//
' > "$tmp_files"

patterns=(
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'sk-[A-Za-z0-9_-]{20,}'
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  'BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY'
  '(PASSWORD|PASSWD|SECRET|API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN)\s*[=:]\s*["'\'']?[^"'\'']?[A-Za-z0-9_./+=:-]{16,}'
  '(COS_SECRET_ID|COS_SECRET_KEY|SES_SECRET_ID|SES_SECRET_KEY|JWT_SECRET|DEEPSEEK_API_KEY|POCKETCTL_API_KEY)\s*=\s*[^[:space:]#][^[:space:]]{7,}'
)

failed=0
for pattern in "${patterns[@]}"; do
  if matches="$(rg -n -I --pcre2 --file "$tmp_files" --regexp "$pattern" 2>/dev/null)"; then
    printf 'Sensitive-looking data found for pattern: %s\n' "$pattern" >&2
    printf '%s\n' "$matches" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  printf '\nSecret scan failed. Remove real secrets or add a narrowly scoped exception after review.\n' >&2
  exit 1
fi

printf 'Secret scan passed.\n'
