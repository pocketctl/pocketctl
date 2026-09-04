#!/bin/bash
# M-8 CSP contract: dist has no inline executable script / inline handlers,
# every production nginx config ships script-src without unsafe-*,
# and bootstrap.js is served no-cache (it carries environment logic).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. Build the web bundle fresh and scan the deployed HTML.
(cd web && npm run build >/dev/null 2>&1) || fail "web build failed"
html="web/dist/index.html"
[[ -f "$html" ]] || fail "web/dist/index.html missing"

# src-less executable <script> tags (JSON/importmap data blocks allowed).
if python3 - "$html" <<'PY'
import re, sys
html = open(sys.argv[1]).read()
for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script>', html, re.I):
    attrs, body = m.group(1), m.group(2)
    if 'src=' in attrs.lower():
        continue
    if re.search(r'type\s*=\s*["\']?(application/json|application/ld\+json|importmap|speculationrules)', attrs, re.I):
        continue
    sys.exit(1)
sys.exit(0)
PY
then :; else fail "dist/index.html still contains an inline executable <script>"; fi

if grep -qEi '<[a-z]+[^>]+[[:space:]]on[a-z]+[[:space:]]*=' "$html"; then
  fail "dist/index.html contains inline event handlers"
fi

[[ -f web/dist/bootstrap.js ]] || fail "web/dist/bootstrap.js missing"

# bootstrap.js itself must stay free of dynamic-code and query parsing.
if grep -qE 'eval\(|new[[:space:]]+Function\(|document\.write|location\.search|URLSearchParams' web/dist/bootstrap.js; then
  fail "bootstrap.js contains forbidden dynamic-code/query constructs"
fi

# 2. Every production nginx config serving the web app must ship a strict
# script-src (no unsafe-inline / unsafe-eval). nginx/nginx.conf itself does
# not serve the SPA but keeps the same baseline per the plan.
configs=(
  landing/nginx.conf
  landing/nginx-online.conf
  landing/nginx-docker.conf
  deploy/nginx/pocketctl.conf
  nginx/nginx.conf
)
for conf in "${configs[@]}"; do
  [[ -f "$conf" ]] || fail "$conf missing"
  csp="$(grep -o 'Content-Security-Policy[^;]*' "$conf" | head -1)"
  [[ -n "$csp" ]] || fail "$conf has no Content-Security-Policy header"
  if grep -q "script-src[^;]*unsafe-\(inline\|eval\)" "$conf"; then
    fail "$conf: script-src contains unsafe-inline/unsafe-eval"
  fi
  # Required baseline directives per the plan.
  for directive in "default-src 'self'" "script-src 'self'" "object-src 'none'" "base-uri 'self'" "frame-ancestors 'none'"; do
    grep -q -- "$directive" "$conf" || fail "$conf: CSP missing '$directive'"
  done
done

# Memory business requests intentionally bypass Relay and connect directly to
# the provider origin delivered by the extension catalog. Keep the static
# local and canonical-production entrypoints in sync with that contract.
for conf in web/nginx.conf landing/nginx.conf landing/nginx-docker.conf; do
  grep -q "connect-src[^;]*http://127.0.0.1:8090" "$conf" \
    || fail "$conf: CSP blocks the local Memory provider"
  grep -q "connect-src[^;]*http://localhost:8090" "$conf" \
    || fail "$conf: CSP blocks the localhost Memory provider"
done
for conf in landing/nginx-online.conf deploy/nginx/pocketctl.conf nginx/nginx.conf; do
  grep -q "connect-src[^;]*https://memory.pocketctl.me" "$conf" \
    || fail "$conf: CSP blocks the canonical Memory provider"
done
grep -q 'EXTENSION_PROVIDER_CONNECT_SOURCES' deploy/deploy.sh \
  || fail "deploy/deploy.sh: generated CSP ignores configured provider origins"

# 3. bootstrap.js must not be long-cached (environment logic without hashes).
found_nocache=0
for conf in landing/nginx.conf landing/nginx-online.conf landing/nginx-docker.conf; do
  if grep -A3 "location = /app/bootstrap.js" "$conf" | grep -qE 'no-store|no-cache'; then
    found_nocache=1
  fi
done
[[ "$found_nocache" == "1" ]] || fail "no /app/bootstrap.js no-cache rule in landing configs"

echo "CSP contract passed"
