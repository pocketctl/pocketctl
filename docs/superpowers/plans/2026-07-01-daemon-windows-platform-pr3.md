# daemon manager.go 拆分 PR3（move-only 重构）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps use checkbox (`- [ ]`) syntax。

**Goal:** 把 `internal/session/manager.go`（PR2 后约 2165 行 / 53 方法）按职责拆成 9 个文件，**纯 move-only 重构，不改任何方法体逻辑/签名/行为**。Unix daemon/session 行为零回归。

**Architecture:** `SessionManager`/`ProcessState` struct + 构造 + `SetApprovalServer`/`ResyncSessions`/`SetProviders` + package defaults 留 `manager.go`；其余 48 方法按职责搬到 8 个新文件。方法仍是 `*SessionManager` 接收者或包级函数（共享 struct 字段），不做 struct 组合拆分。

**Tech Stack:** Go 1.25.0；纯内部搬移，不加依赖、不改签名、不改 platform 接入（PR2 已完成）。

## Global Constraints

- **move-only 纪律（核心）**：每个 task 只把方法从 manager.go **搬**（cut）到目标文件，**不改方法体、不改签名、不改行为**。任何「顺手优化」留独立 PR。每搬一组 `go test ./internal/session/...` 必须全绿。
- **共享 struct 不拆**：`SessionManager`(238-265) + `ProcessState`(29-54) + `NotifyFunc`(227) 留 manager.go。搬走的方法仍接收 `*SessionManager`，共享 `mu`/`sessions`/`outputCh`/`ptyProvider`/`proc` 等字段。
- **manager.go 保留**：package defaults（defaultPTYProvider/defaultProc）+ 两个 struct + NotifyFunc + `NewSessionManager`(267) + `SetProviders`(282) + `SetApprovalServer`(293) + `ResyncSessions`(2128)。
- **循环依赖**：无（同 package 跨文件调用，agent 已确认）。`tryResumeHistorical` 归 lifecycle.go。
- **import 按需**：每个新文件只 import 自己用到的包。manager.go 搬完删不再用的 import（编译/goimports 确认）。
- **Unix 零回归硬门禁**：每 task 后 `go build ./... && go vet ./... && go test ./...` 全绿。session 包 Windows 编译仍通过。
- **staging 纪律**：每 task 只 add 该 task 涉及的 manager.go + 新文件。不 `git add -A`（工作区有 .superpowers gitignored，但避免误加）。

## File Structure（9 文件，agent 映射）

| 文件 | 方法数 | 职责 | 平台依赖 |
|---|---|---|---|
| `manager.go` | 5 | struct + 构造 + 协调 + package defaults | 无 |
| `lifecycle.go` | 10 | 创建/生命周期/KillSession/agent CLI | 走 platform |
| `state.go` | 13 | 状态查询/更新 + SessionInfo struct | 无 |
| `permissions.go` | 8 | 权限/effort/中断 + ValidEffortLevels + isValidEffort | 走 platform |
| `models.go` | 8 | 模型解析 + indexOfString + slot struct | 无 |
| `approval.go` | 5 | 审批流 | 依赖 approval |
| `watcher.go` | 6 | 监控/终端会话/PTY drain/cwd 提取 | 走 platform |
| `registry.go` | 6 | cwd 注册/验证 | 无 |
| `messages.go` | 4 | 消息注入/交互提示/readOutput | 走 platform |

## 关键决策

1. **struct 不拆**（spec §6.2 方案 1）：字段留 manager.go，方法分散。
2. **helper 归属**（agent）：`indexOfString`→models（被 models+permissions 用，同包调用 OK）；`isValidEffort`+`ValidEffortLevels`→permissions；`isProcessAlive`→lifecycle（被 messages+lifecycle 用）；`agentCLIName`/`findAgentCLI`→lifecycle。
3. **`UpdateSessionTitle`/`GenerateTitle`→state.go**（状态相关，非 lifecycle）。
4. **补测可选**：0% 覆盖率文件（approval/models/permissions/watcher）的补测作为 Task 7 可选收尾，不阻塞 move-only 主线。

---

## Task 1: state.go + models.go + registry.go（无 platform 依赖三件套）

**Files:** Create `internal/session/state.go` + `models.go` + `registry.go`; Modify `manager.go`（cut 这三组方法）。

**搬移清单（从 manager.go cut 到新文件，方法体不改）：**

`state.go`（13 方法 + SessionInfo struct）: UpdateSessionTitle(1322), GenerateTitle(1340), SetSessionExited(1393), DropGhostSession(1430), SetSessionStatus(1481), ListSessions(1996), UpdateLastActivity(2030), GetSessionCwd(2040), GetWorktreeInfo(2052), GetSessionAgent(2066), GetSessionModel(2083), SetSessionModel(2095), GetSessionSlashCommands(2107) + SessionInfo struct(2117-2124)
- import: `fmt`, `sort`, `time`, `internal/adapter`, `internal/protocol`

`models.go`（8 方法/helper + slot struct）: indexOfString(217), stripModelSuffix(600), resolveCleanModel(612), ListAvailableModels(648), ListModelsForAgent(685), listCodexModels(704), codexConfigModel(722), resolveModelAlias(752) + slot struct(663)
- import: `encoding/json`, `fmt`, `os`, `path/filepath`, `strings`, `internal/adapter`, `internal/protocol`

`registry.go`（6 方法）: resolveCwd(525), normalizeCwd(547), registerCwd(560), unregisterCwd(574), CwdSessionCount(590), validateCwd(762)
- import: `fmt`, `os`, `path/filepath`

- [ ] **Step 1**: 创建 state.go（package session + import + 13 方法 + SessionInfo struct，从 manager.go 原样搬）
- [ ] **Step 2**: 创建 models.go（8 方法/helper + slot struct）
- [ ] **Step 3**: 创建 registry.go（6 方法）
- [ ] **Step 4**: 从 manager.go **删除**上述 27 方法 + SessionInfo/slot struct（已搬到新文件）
- [ ] **Step 5**: `go build ./internal/session/ && go vet ./... && go test ./...` — 全绿（move-only，行为零变化）。若编译失败说明有方法漏搬/重复，定位修复
- [ ] **Step 6**: commit `feat(session): 拆分 manager.go → state/models/registry (PR3/7 move-only)`

## Task 2: approval.go（审批流）

**Files:** Create `approval.go`; Modify `manager.go`（cut 5 方法）。

**搬移清单**: handleApprovalRequest(308), handleApprovalCancel(363), handleOpencodePermission(403), clearOpencodePermissionReplied(448), ResolveApproval(469)
- import: `context`, `encoding/json`, `fmt`, `log/slog`, `time`, `internal/approval`, `internal/protocol`

- [ ] **Step 1-4**: 创建 approval.go + 从 manager.go cut 5 方法 + go test + commit `feat(session): 拆分 manager.go → approval (PR3/7)`

## Task 3: permissions.go（权限/effort/中断）

**Files:** Create `permissions.go`; Modify `manager.go`（cut 8 方法/常量）。

**搬移清单**: SetPermissionMode(68), isValidEffort(108), ValidEffortLevels 常量(105), SetEffort(127), GetSessionEffort(153), InterruptSession(168), UpdatePermissionMode(199), GetPermissionMode(208)
- import: `context`, `fmt`, `strings`, `time`, `internal/platform`, `internal/protocol`
- 注意: SetPermissionMode 调用 indexOfString（Task 1 已搬到 models.go，同包调用 OK）

- [ ] **Step 1-4**: 创建 permissions.go + cut + go test + commit `feat(session): 拆分 manager.go → permissions (PR3/7)`

## Task 4: watcher.go（监控/终端会话/PTY drain）

**Files:** Create `watcher.go`; Modify `manager.go`（cut 6 方法）。

**搬移清单**: SetTailer(57), drainPTY(1060), RegisterTerminalSession(1262), ReviveTerminalSessionOnActivity(1453), extractCwdFromJSONL(1788), cwdFromProjectsDir(1809)
- import: `bufio`, `context`, `fmt`, `os`, `path/filepath`, `strings`, `internal/ptyscan`, `internal/protocol`, `internal/watcher`

- [ ] **Step 1-4**: 创建 watcher.go + cut + go test + commit `feat(session): 拆分 manager.go → watcher (PR3/7)`

## Task 5: messages.go（消息注入）

**Files:** Create `messages.go`; Modify `manager.go`（cut 4 方法）。

**搬移清单**: ResolveInteractivePrompt(1091), readOutput(1501), SendMessage(1580), sendToIdleTerminal(1820)
- import: `bufio`, `context`, `fmt`, `io`, `os/exec`, `time`, `internal/adapter`, `internal/platform`, `internal/protocol`
- 注意: SendMessage/sendToIdleTerminal 调用 isProcessAlive（Task 6 搬到 lifecycle.go，同包调用 OK；但 Task 5 时 isProcessAlive 还在 manager.go，Task 6 才搬——同包调用无碍，顺序无关）

- [ ] **Step 1-4**: 创建 messages.go + cut + go test + commit `feat(session): 拆分 manager.go → messages (PR3/7)`

## Task 6: lifecycle.go（生命周期，最大块）

**Files:** Create `lifecycle.go`; Modify `manager.go`（cut 10 方法）。

**搬移清单**: CreateSession(782), servePTYSession(954), watchdogBusy(1144), handlePTYExit(1207), AbortSession(1367), tryResumeHistorical(1755), isProcessAlive(1918), KillSession(1922), agentCLIName(2146), findAgentCLI(2158)
- import: `bufio`, `context`, `fmt`, `io`, `os`, `os/exec`, `path/filepath`, `strings`, `time`, `github.com/google/uuid`, `internal/adapter`, `internal/approval`, `internal/discovery`, `internal/filelock`, `internal/platform`, `internal/protocol`, `internal/ptyscan`, `internal/watcher`

- [ ] **Step 1-4**: 创建 lifecycle.go + cut + go test + commit `feat(session): 拆分 manager.go → lifecycle (PR3/7)`

## Task 7: manager.go 收尾 + 集成验证

**Files:** Modify `manager.go`（确认只剩核心 + 清理 import）。

- [ ] **Step 1**: 确认 manager.go 只剩: package defaults(defaultPTYProvider/defaultProc) + ProcessState struct(29-54) + SessionManager struct(238-265) + NotifyFunc(227) + NewSessionManager(267) + SetProviders(282) + SetApprovalServer(293) + ResyncSessions(2128)。约 300 行。
- [ ] **Step 2**: 清理 manager.go import（删搬走方法用的：bufio/json/slog/os/exec/filepath/sort/strings/uuid/adapter/discovery/ptyscan/watcher 等，只留 struct/构造/协调必需：context/fmt/sync/time + approval/filelock/platform/protocol）。用 `go build` 确认每个删除安全。
- [ ] **Step 3**: 集成验证: `go build ./... && go vet ./... && go test ./...` 全绿; `GOOS=windows go build ./internal/session/` 通过; `gofmt -l internal/session/*.go` 空。
- [ ] **Step 4**: commit `chore(session): manager.go 收尾,清理 import (PR3/7 done)`

---

## 执行模式
逐 task（同 PR2）：task-brief → implementer（move-only 用 haiku，机械搬）→ review（sonnet，确认 move-only 无逻辑改动 + 编译绿）→ commit。每 task 后 session 包编译+测试全绿才进下一个。

## Self-Review（plan 写完）
- ✅ 53 方法全覆盖（agent 清单），无遗漏。
- ✅ 每 task 方法清单 + 目标文件 + import 明确。
- ✅ 共享 struct 留 manager.go，helper 归属清晰。
- ✅ 无循环依赖（agent 确认同 package 跨文件调用）。
- ✅ move-only 纪律贯穿（不改方法体）。
