#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

fail() {
  echo "session share Nginx route contract failed: $*" >&2
  exit 1
}

share_location() {
  awk '
    /location \^~ \/share\/session\// { found = 1 }
    found { print }
    found && /^[[:space:]]*}/ { exit }
  ' "$1"
}

assert_share_route() {
  local config=$1
  local upstream=$2
  local block

  block=$(share_location "$repo_root/$config")
  [ -n "$block" ] || fail "$config must route /share/session/ before the landing fallback"
  grep -Fq "proxy_pass $upstream;" <<<"$block" \
    || fail "$config must proxy the share viewer to $upstream without rewriting its path"
  grep -Fq 'access_log off;' <<<"$block" \
    || fail "$config must not log the bearer-style share token embedded in the path"
  grep -Fq 'proxy_set_header Host $host;' <<<"$block" \
    || fail "$config must preserve the public Host header"
  grep -Fq 'proxy_set_header X-Real-IP $remote_addr;' <<<"$block" \
    || fail "$config must forward the authoritative client address"
  grep -Fq 'proxy_set_header X-Forwarded-For $remote_addr;' <<<"$block" \
    || fail "$config must replace untrusted X-Forwarded-For input"
  grep -Fq 'proxy_set_header X-Forwarded-Proto $scheme;' <<<"$block" \
    || fail "$config must forward the public scheme"
}

assert_share_route landing/nginx.conf http://127.0.0.1:8080
assert_share_route landing/nginx-online.conf http://127.0.0.1:8080
assert_share_route deploy/nginx/pocketctl.conf http://127.0.0.1:8080
assert_share_route landing/nginx-docker.conf http://relay:8080
assert_share_route nginx/nginx.conf http://relay:8080

generated_block=$(share_location "$repo_root/deploy/deploy.sh")
[ -n "$generated_block" ] \
  || fail "deploy/deploy.sh must generate the /share/session/ proxy route"
grep -Fq 'proxy_pass http://127.0.0.1:${RELAY_PORT};' <<<"$generated_block" \
  || fail "deploy/deploy.sh must preserve the share path when proxying to Relay"
grep -Fq 'access_log off;' <<<"$generated_block" \
  || fail "deploy/deploy.sh must disable access logs for path-embedded share tokens"

echo "session share Nginx route contract passed"
