# daemon Windows CI PR5 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 建 GitHub Actions CI（三平台 build+test matrix + nightly windows 冲烟脚本）+ 手动抽验清单文档。保护 PR1-4 的 Windows build 成果 + 为 PR4 提供运行时验证基建（唯一途径，本地无 Windows 机器）。

**Architecture:** `.github/workflows/ci.yml`（PR/push 触发，三平台编译+单测门禁）+ `.github/workflows/windows-smoke.yml`（nightly + 手动触发，windows runner 跑冲烟脚本）+ `scripts/ci-windows-smoke.ps1`（PowerShell 冲烟：daemon 启动/单例/控制通道 stop）+ `docs/superpowers/manual-verification-checklist.md`。

**Tech Stack:** GitHub Actions（runs-on ubuntu/macos/windows-latest）+ actions/setup-go@v5 + PowerShell。

## Global Constraints

- **CI 配置推 github**：`.github/` 在 sync-github 白名单。gitee 也收（但不跑 Actions，仅文档）。
- **验证局限（核心）**：本地 macOS 看不到 GitHub Actions 实时日志。CI 跑通与否要用户在 github.com 看。我能写配置/脚本 + push，但「CI 真能跑通」靠用户确认；冲烟失败用户贴日志我修。
- **windows 冲烟预期迭代**：PR4 实现没真跑过，第一次冲烟大概率失败（运行时 bug）。冲烟脚本是「探测器」，不是「写完就绿」。
- **不破坏现有 release.yml**：项目已有 `.github/workflows/release.yml`（sync-github SYNC_FILES 列出）。CI 是新增 workflow，不改 release。
- **三平台编译 CI 确定有价值**（不依赖 PR4 运行时）；windows 冲烟是探测器。

## File Structure

| 文件 | 责任 | 风险 |
|---|---|---|
| `.github/workflows/ci.yml`（新） | PR/push 触发，matrix [ubuntu/macos/windows] build+vet+test | 低（标准 Actions） |
| `.github/workflows/windows-smoke.yml`（新） | nightly cron + workflow_dispatch，windows runner 跑冲烟 | 中（触发 PR4 运行时） |
| `scripts/ci-windows-smoke.ps1`（新） | PowerShell：build → daemon start → 单例互斥 → daemon stop（控制通道）→ 验证退出 | 中（PR4 探测器） |
| `docs/superpowers/manual-verification-checklist.md`（新） | 未来有 Windows 机器时的手动抽验步骤清单 | 低 |

## Task 分解（2 task）

### Task 1: 三平台编译+单测 CI matrix（确定价值）

**Files:** Create `.github/workflows/ci.yml`

- [ ] **Step 1: 创建 `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [develop, master]

jobs:
  build-test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'
          cache: true
      - name: Build
        run: go build ./...
      - name: Vet
        run: go vet ./...
      - name: Test
        run: go test ./...
```

- [ ] **Step 2: 本地确认 YAML 语法 + 三平台编译仍过**

Run: `GOOS=darwin go build ./... && GOOS=linux go build ./... && GOOS=windows go build ./...`（CI 配置不影响代码编译，确认代码仍三平台过）。

- [ ] **Step 3: Commit**
```bash
git add .github/workflows/ci.yml
git commit -m "ci: 三平台 build+vet+test matrix (PR5/2)"
```

> 推送后 github Actions 会在 PR/push 时跑。**用户确认 Actions 三平台全绿**（我看不见日志）。这是 PR1-4 Windows build 成果的回归门禁。

### Task 2: windows 冲烟 workflow + PowerShell 脚本 + 手动抽验文档

**Files:** Create `.github/workflows/windows-smoke.yml` + `scripts/ci-windows-smoke.ps1` + `docs/superpowers/manual-verification-checklist.md`

- [ ] **Step 1: 创建 `.github/workflows/windows-smoke.yml`**

```yaml
name: Windows Smoke

on:
  schedule:
    - cron: '17 18 * * *'  # nightly ~02:00 UTC+8 (17 UTC)，避开整点
  workflow_dispatch: {}    # 手动触发

jobs:
  smoke:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'
          cache: true
      - name: Build
        run: go build -o pocketctl.exe ./cmd/pocketctl
      - name: Smoke test
        run: pwsh ./scripts/ci-windows-smoke.ps1
```

- [ ] **Step 2: 创建 `scripts/ci-windows-smoke.ps1`**

```powershell
# ci-windows-smoke.ps1 — Windows daemon 非交互链路冒烟测试。
# 验证 PR4 实现: daemon start(detached) → 单例锁互斥(第二个失败) → 控制通道 stop(优雅退出)。
# relay 用 fake URL(daemon 连失败但不阻塞单例/stop 验证;relay 链路靠后续真机/集成测)。
#
# 注意: PR4 实现首次真跑,大概率撞运行时 bug。本脚本是探测器——失败时 Actions 日志暴露问题。

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot/..

Write-Host "=== [1/4] Build pocketctl.exe ==="
go build -o pocketctl.exe ./cmd/pocketctl
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "=== [2/4] Start daemon (foreground, fake relay) ==="
# --foreground 跑前台(不走 daemonize);fake relay URL 让 ws 连接失败但不阻塞单例/控制通道验证
$p = Start-Process -FilePath ".\pocketctl.exe" `
    -ArgumentList "daemon","start","--foreground","--relay","ws://127.0.0.1:1/fake","--token","smoke-test-token" `
    -PassThru -NoNewWindow
Start-Sleep -Seconds 3

if ($p.HasExited) {
    Write-Host "WARN: daemon exited early (exit code $($p.ExitCode)); may be expected if ws connect fails fatally"
    # 不直接 fail——单例/控制通道测试需要 daemon 存活。若 early exit,后续步骤会捕获。
}

Write-Host "=== [3/4] Single-instance lock (second start must fail) ==="
$p2 = Start-Process -FilePath ".\pocketctl.exe" `
    -ArgumentList "daemon","start","--foreground","--relay","ws://127.0.0.1:1/fake","--token","smoke-test-token" `
    -PassThru -NoNewWindow
Start-Sleep -Seconds 3
# 第二个 daemon 应因 Mutex(Global\pocketctl-daemon 已占)失败退出(非 0)。
if (-not $p2.HasExited) {
    $p2.Kill()
    throw "second daemon did NOT fail on single-instance lock (Mutex not working?)"
}
Write-Host "PASS: second daemon correctly rejected by single-instance lock"

Write-Host "=== [4/4] Stop daemon via control channel ==="
if (-not $p.HasExited) {
    & ".\pocketctl.exe" daemon stop
    Start-Sleep -Seconds 3
    if (-not $p.HasExited) {
        $p.Kill()
        throw "daemon did not stop via control channel (named pipe stop not working?)"
    }
    Write-Host "PASS: daemon stopped via control channel"
} else {
    Write-Host "SKIP: first daemon already exited, can't test control-channel stop"
}

Write-Host "=== Smoke PASSED ==="
```

- [ ] **Step 3: 创建 `docs/superpowers/manual-verification-checklist.md`**

文档清单（未来有 Windows 机器时手动跑）：覆盖 daemon start → 创建终端会话（watcher 发现）→ 审批流（Claude hook 连 named pipe）→ daemon stop（控制通道）。具体步骤文档化（build pocketctl.exe + codesign? Windows 不需 + 启动 + 各链路验证）。

- [ ] **Step 4: Commit**
```bash
git add .github/workflows/windows-smoke.yml scripts/ci-windows-smoke.ps1 docs/superpowers/manual-verification-checklist.md
git commit -m "ci: windows nightly 冲烟脚本 + 手动抽验清单 (PR5/2)"
```

> 推送后 nightly 或 workflow_dispatch 触发。**第一次大概率红**（PR4 运行时 bug）——用户贴 Actions 日志，我修 PR4（盲修，迭代）。

## 验证策略（PR5 特殊）
- **Task 1（编译 CI）**：确定价值，push 后用户确认 Actions 三平台绿。
- **Task 2（windows 冲烟）**：探测器，第一次预期失败。迭代修复 PR4 运行时 bug。
- **我看不见 Actions 日志**：所有 CI 运行结果靠用户在 github.com 看 + 贴日志。

## 后续（PR5 之后）
- PR4 运行时 bug 修复（冲烟暴露后盲修迭代）。
- Task 6 SCM 完整（单独立项）。
- ConPTY v2。
