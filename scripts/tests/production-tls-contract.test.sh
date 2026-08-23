#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

fail() {
  echo "production TLS contract failed: $*" >&2
  exit 1
}

# --- compose nginx service must require explicit TLS material ---------------

compose="$repo_root/docker-compose.prod.yml"
grep -q 'TLS_CERT_PATH:?TLS_CERT_PATH is required' "$compose" \
  || fail "compose must require TLS_CERT_PATH (no silent empty default)"
grep -q 'TLS_KEY_PATH:?TLS_KEY_PATH is required' "$compose" \
  || fail "compose must require TLS_KEY_PATH (no silent empty default)"
grep -q ':/etc/nginx/ssl/fullchain.pem:ro' "$compose" \
  || fail "compose must mount the fullchain at the unified container path"
grep -q ':/etc/nginx/ssl/privkey.pem:ro' "$compose" \
  || fail "compose must mount the private key at the unified container path"
# The old ambiguous whole-directory mount must be gone.
! grep -q './nginx/ssl:/etc/nginx/ssl:ro' "$compose" \
  || fail "compose must not mount a possibly-empty ssl directory"

# Compose refuses to render without the required TLS variables.
if POSTGRES_PASSWORD=tls-contract-only docker compose --env-file /dev/null \
     -f "$compose" config --quiet >/dev/null 2>&1; then
  fail "compose must fail closed without TLS_CERT_PATH/TLS_KEY_PATH"
fi

# --- nginx/nginx.conf: 80 only redirects, 443 serves TLS --------------------

conf="$repo_root/nginx/nginx.conf"

# Extract the port-80 server block (from 'listen 80' to the closing brace of
# its server stanza) via awk.
http_server=$(awk '/listen 80;/{flag=1} flag{print} flag && /^    }/{exit}' "$conf")
[ -n "$http_server" ] || fail "nginx.conf must keep a port-80 server"
echo "$http_server" | grep -Eq 'return 30[18] https://\$host\$request_uri;' \
  || fail "port-80 server must redirect to https://\$host\$request_uri (301/308)"
! echo "$http_server" | grep -q 'proxy_pass' \
  || fail "port-80 server must not proxy health/API/WS"
! echo "$http_server" | grep -q 'Strict-Transport-Security' \
  || fail "HSTS must only be sent by the TLS server"

grep -q 'listen 443 ssl;' "$conf" || fail "nginx.conf must listen on 443 ssl"
grep -q 'ssl_certificate ' "$conf" || fail "nginx.conf must load a certificate"
grep -q 'ssl_certificate_key ' "$conf" || fail "nginx.conf must load a private key"
grep -q '/etc/nginx/ssl/fullchain.pem' "$conf" || fail "nginx.conf must use the unified fullchain path"
grep -q '/etc/nginx/ssl/privkey.pem' "$conf" || fail "nginx.conf must use the unified privkey path"

# The 443 server must forward the real scheme and only allow wss: connects.
tls_server=$(awk '/listen 443 ssl;/{flag=1} flag{print} flag && /^    }/{exit}' "$conf")
echo "$tls_server" | grep -q 'X-Forwarded-Proto \$scheme' \
  || fail "443 server must set X-Forwarded-Proto \$scheme on proxied locations"
! grep -q 'connect-src[^;]*[^s]ws:' "$conf" \
  || fail "CSP connect-src must not allow plaintext ws: (wss: only)"

# --- landing template must not be a deployable HTTP-only production vhost ----

landing="$repo_root/landing/nginx-online.conf"
grep -q 'listen 443 ssl;' "$landing" \
  || fail "landing/nginx-online.conf must grow a 443 TLS server"
landing_http=$(awk '/listen 80;/{flag=1} flag{print} flag && /^}/{exit}' "$landing")
! echo "$landing_http" | grep -q 'proxy_pass' \
  || fail "landing port-80 server must redirect instead of proxying"

# --- deploy/nginx/pocketctl.conf keeps the same minimum contract -------------

deployconf="$repo_root/deploy/nginx/pocketctl.conf"
grep -q 'listen 443 ssl;' "$deployconf" || fail "deploy conf must listen 443 ssl"
grep -q '/etc/nginx/ssl/fullchain.pem' "$deployconf" || fail "deploy conf must use the unified fullchain path"
grep -q '/etc/nginx/ssl/privkey.pem' "$deployconf" || fail "deploy conf must use the unified privkey path"
deploy_http=$(awk '/listen 80;/{flag=1} flag{print} flag && /^}/{exit}' "$deployconf")
echo "$deploy_http" | grep -Eq 'return 30[18] https://\$host\$request_uri;' \
  || fail "deploy conf port-80 server must redirect"

echo "production TLS contract passed"
