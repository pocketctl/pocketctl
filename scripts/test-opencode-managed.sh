#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[A-D/1] Go control, runtime, interaction, lifecycle and E2E tests"
go test -race \
  ./internal/agentcontrol \
  ./internal/config \
  ./internal/discovery \
  ./internal/platform \
  ./internal/protocol \
  ./internal/watcher \
  ./internal/adapter \
  ./internal/daemon \
  ./internal/session \
  ./internal/ws \
  ./internal/e2e \
  ./internal/i18n \
  ./cmd/pocketctl \
  -count=1

echo "[A-D/2] Windows launcher and IPC compile contract"
GOOS=windows GOARCH=amd64 go test -exec=true \
  ./internal/agentcontrol \
  ./internal/config \
  ./internal/platform \
  ./cmd/pocketctl \
  -count=1

echo "[C-D/3] Relay persistence, routing and release-contract tests"
(
  cd relay
  npx vitest run \
    src/__tests__/opencode-interactions-db.test.ts \
    src/__tests__/opencode-interactions-router.test.ts \
    src/__tests__/opencode-managed-session.test.ts \
    src/__tests__/opencode-release-contract.test.ts \
    src/__tests__/opencode-telemetry.test.ts
)

echo "[C-D/4] Web managed-session and interaction-card tests"
(
  cd web
  npx vitest run \
    src/views/__tests__/SessionDetailOpenCodeManaged.test.ts \
    src/components/messages/__tests__/ApprovalCardActions.test.ts \
    src/components/messages/__tests__/OpenCodeQuestionCard.test.ts
)

if [[ -d ios ]] && command -v swift >/dev/null 2>&1; then
  echo "[C-D/5] iOS OpenCode source-regression tests"
  for test_file in ios/Tests/OpenCode*RegressionTests.swift; do
    swift "$test_file"
  done
else
  echo "[C-D/5] SKIP iOS source-regression tests: iOS source or swift is unavailable"
fi

if [[ "${POCKETCTL_RELEASE_GATE:-0}" == "1" ]]; then
  echo "[D/6] Relay and Web production builds"
  (cd relay && npm run build)
  (cd web && npm run build)

  echo "[D/7] Pocketctl six-platform build matrix"
  make build-all

  if [[ -d ios ]] && command -v xcodebuild >/dev/null 2>&1; then
    echo "[D/8] iOS simulator Debug build"
    xcodebuild \
      -project ios/Pocketctl.xcodeproj \
      -scheme Pocketctl \
      -sdk iphonesimulator \
      -configuration Debug \
      build \
      CODE_SIGNING_ALLOWED=NO
  else
    echo "[D/8] SKIP iOS simulator build: iOS source or xcodebuild is unavailable"
  fi
fi

echo "OpenCode managed terminal Milestone A-D test gate passed"
