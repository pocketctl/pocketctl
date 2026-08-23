#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[Codex/1] Go launcher, app-server, lifecycle, interaction and E2E race tests"
go test -race -p 1 \
  ./internal/agentcontrol \
  ./internal/codexapp \
  ./internal/daemon \
  ./internal/platform \
  ./internal/protocol \
  ./internal/session \
  ./internal/e2e \
  ./cmd/pocketctl \
  -count=1

echo "[Codex/2] Web managed composer, interaction projection and cards"
(
  cd web
  npx vitest run \
    src/views/__tests__/SessionDetailCodexManaged.test.ts \
    src/views/__tests__/SessionDetailOpenCodeManaged.test.ts \
    src/views/__tests__/SessionDetailProcessEvent.test.ts \
    src/components/messages/__tests__/ApprovalCardActions.test.ts \
    src/components/messages/__tests__/McpElicitationCard.test.ts \
    src/utils/__tests__/agentFileChange.test.ts \
    src/utils/__tests__/unifiedDiff.test.ts \
    src/components/messages/__tests__/FileChangeCard.test.ts \
    src/components/messages/__tests__/FileChangeBottomSheet.test.ts
)

if [[ -d ios ]] && command -v swift >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1; then
  echo "[Codex/3] iOS Codex and generic session source-regression tests"
  for test_file in ios/Tests/Codex*RegressionTests.swift; do
    swift "$test_file"
  done

  swift ios/Tests/SessionComposerRegressionTests.swift
  (
    swift_test_dir="$(mktemp -d)"
    trap 'rm -rf "$swift_test_dir"' EXIT
    swiftc \
      ios/Pocketctl/Models/AgentPlan.swift \
      ios/Tests/AgentPlanRegressionTests.swift \
      -o "$swift_test_dir/AgentPlanRegressionTests"
    "$swift_test_dir/AgentPlanRegressionTests"
    swiftc \
      ios/Pocketctl/Models/AgentFileChange.swift \
      ios/Pocketctl/Models/ChatMessage.swift \
      ios/Pocketctl/Models/AgentPlan.swift \
      ios/Pocketctl/Models/AgentPermissionConfig.swift \
      ios/Pocketctl/Models/OpenCodeInteraction.swift \
      ios/Pocketctl/Models/Session.swift \
      ios/Pocketctl/Models/SubAgent.swift \
      ios/Pocketctl/Models/User.swift \
      ios/Pocketctl/Models/WebSocketEvent.swift \
      ios/Pocketctl/Utils/SessionEventPolicy.swift \
      ios/Pocketctl/Utils/UnifiedDiffParser.swift \
      ios/Tests/SessionEventRegressionTests.swift \
      -o "$swift_test_dir/SessionEventRegressionTests"
    "$swift_test_dir/SessionEventRegressionTests"
    swiftc \
      ios/Pocketctl/Models/AgentFileChange.swift \
      ios/Pocketctl/Utils/UnifiedDiffParser.swift \
      ios/Pocketctl/Utils/SessionEventPolicy.swift \
      ios/Tests/AgentFileChangeRegressionTests.swift \
      -o "$swift_test_dir/AgentFileChangeRegressionTests"
    "$swift_test_dir/AgentFileChangeRegressionTests"
  )
else
  echo "[Codex/3] SKIP iOS source-regression tests: iOS source or swift/swiftc is unavailable"
fi

if [[ "${POCKETCTL_RELEASE_GATE:-0}" == "1" ]]; then
  echo "[Codex/4] Full Relay and Web tests/builds"
  (cd relay && env -u TEST_DATABASE_URL -u RUN_POSTGRES_INTEGRATION npm test && npm run build)
  (cd web && npm test && npm run build)

  echo "[Codex/5] Pocketctl four-platform release build matrix"
  make build-all

  if [[ -d ios ]] && command -v xcodebuild >/dev/null 2>&1; then
    echo "[Codex/6] iOS simulator Debug build"
    xcodebuild \
      -project ios/Pocketctl.xcodeproj \
      -scheme Pocketctl \
      -sdk iphonesimulator \
      -configuration Debug \
      build \
      CODE_SIGNING_ALLOWED=NO
  else
    echo "[Codex/6] SKIP iOS simulator build: iOS source or xcodebuild is unavailable"
  fi
fi

echo "Codex managed terminal test gate passed"
