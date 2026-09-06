#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(mktemp -d)
container="pocketctl-nginx-bootstrap-test-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT

mkdir -p "$fixture/ssl" "$fixture/web" "$fixture/landing"
printf 'window.__POCKETCTL_BOOTSTRAP_TEST__ = true;\n' > "$fixture/web/bootstrap.js"
printf '<!doctype html><title>landing</title>\n' > "$fixture/landing/index.html"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -keyout "$fixture/ssl/privkey.pem" -out "$fixture/ssl/fullchain.pem" >/dev/null 2>&1

docker run -d --name "$container" -p 127.0.0.1::443 \
  -v "$repo_root/landing/nginx-online.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$fixture/ssl:/etc/nginx/ssl:ro" \
  -v "$fixture/web:/opt/pocketctl/web/dist:ro" \
  -v "$fixture/landing:/opt/pocketctl/landing:ro" \
  -v "$repo_root/nginx/html:/opt/pocketctl/nginx/html:ro" \
  nginx:alpine >/dev/null

port=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "443/tcp") 0).HostPort}}' "$container")
for _ in $(seq 1 30); do
  if curl -ksS "https://127.0.0.1:${port}/app/bootstrap.js" -o "$fixture/body" -D "$fixture/headers"; then break; fi
  sleep 1
done

grep -qxF 'window.__POCKETCTL_BOOTSTRAP_TEST__ = true;' "$fixture/body" \
  || { echo "nginx online bootstrap test failed: wrong response body" >&2; exit 1; }
grep -qi '^Cache-Control: no-cache' "$fixture/headers" \
  || { echo "nginx online bootstrap test failed: missing no-cache header" >&2; exit 1; }

# /install.sh 必须返回安装脚本本体（而非 SPA fallback 的 landing 首页），
# 且 Content-Type 标为 shell 脚本 —— GitHub issue #6 的回归断言。
curl -ksS "https://127.0.0.1:${port}/install.sh" -o "$fixture/install-body" -D "$fixture/install-headers"
grep -q '^#!/bin/bash' "$fixture/install-body" \
  || { echo "nginx online bootstrap test failed: /install.sh did not return the install script" >&2; exit 1; }
grep -qi '^Content-Type: application/x-sh' "$fixture/install-headers" \
  || { echo "nginx online bootstrap test failed: /install.sh missing application/x-sh content type" >&2; exit 1; }

echo "nginx online bootstrap test passed"
