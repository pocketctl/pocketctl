#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

with_docker=false
if [[ "${1:-}" == "--with-docker" ]]; then
  with_docker=true
elif [[ $# -ne 0 ]]; then
  echo "usage: bash scripts/test-production-deployment-gate.sh [--with-docker]" >&2
  exit 64
fi

# These contracts share production code paths with deploy/deploy.sh and the
# Compose/Nginx definitions. Node dependencies must already be installed.
npm run build --prefix relay
bash deploy/tests/deploy-secret-contract.test.sh
bash deploy/tests/deployment-runtime-contract.test.sh
bash deploy/tests/postgres-init-secret-contract.test.sh
bash scripts/tests/production-deploy-hardening.test.sh
bash scripts/tests/production-tls-contract.test.sh
bash scripts/test-csp-contract.sh

if [[ "$with_docker" == true ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo "production deployment Docker gate requires docker" >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "production deployment Docker gate requires a running Docker daemon" >&2
    exit 1
  }
  node scripts/tests/relay-extension-compose-contract.test.mjs
  bash deploy/tests/postgres-role-sql.integration.test.sh
  bash deploy/tests/existing-volume-migration.integration.test.sh
  bash deploy/tests/relay-production-env.integration.test.sh
  env -u JWT_SECRET bash scripts/test-postgres-role-separation.sh
  bash scripts/test-postgres-existing-volume-gate.sh
  bash scripts/tests/nginx-online-bootstrap.test.sh
fi

echo "production deployment gate passed (docker=$with_docker)"
