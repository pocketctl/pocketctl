# daemon Windows 平台抽象层重构设计

- **日期**: 2026-07-01
- **状态**: Draft（待用户 review）
- **作者**: brainstorming session 产出
- **后续**: 本 spec 获批后进入 writing-plans，产出实现计划

---

## 1. 背景与动机

pocketctl 的 daemon 当前只在 Unix（macOS / Linux）上运行。**有真实的 Windows 目标用户**，需要让 daemon 支持 Windows。本次工作的定位是：

> **借这次机会，把 daemon 架构重构成「未来能干净支持 Windows」的形态，并让 Windows 上的非交互链路立即真能跑。** ConPTY 交互（远程驱动 TUI）留作 v2，本次只留 stub。

不是「立刻实现 Windows 全功能」，也不是「探路性质」。Windows 是一等公民的长期目标，这次打地基 + 交付部分可用性。

---

## 2. 当前架构现状（探索结论）

### 2.1 已有的平台抽象（合格的，本次大部分保留）

项目已用 Go 的 **build-tag 分文件**模式做了相当多抽象：

| 文件 | 状态 |
|---|---|
| `internal/daemon/instance_{unix,windows}.go`（单实例锁） | Windows 已有 no-op 占位 |
| `cmd/pocketctl/fd_{unix,linux,windows}.go`（stderr 重定向） | 已三平台分文件 |
| `internal/daemon/oom_{linux,other}.go` | 已分文件 |
| `internal/service/service_{darwin,linux,other}.go`（launchd/systemd） | Windows 落到 `other` 返回 Unsupported |
| `pid.go`、`machineid.go`、`wsl.go`、`ws/client.go`、路径处理 | 已用跨平台 API |

**结论**：项目不是「完全没有抽象层」，build-tag 分文件就是合格的平台抽象。重写它们为 interface 体系多数是无效工作（见 §3.3）。

### 2.2 真正的洞（耦合在业务逻辑里、必须补抽象）

只有两块平台机制**直接长在业务代码里**，没有抽象：

1. **PTY** — `internal/session/pty.go:9` 直接 `import "github.com/creack/pty"`（Unix-only）。`internal/session/manager.go`（2141 行 / 44 方法）里 `ps.PTY.Write` 散落 **8 处**，集中在 `SendMessage`、`InterruptSession`、`SetPermissionMode`、`SetEffort`、`KillSession`、`drainPTY`、`ResolveInteractivePrompt`、`handlePTYExit`。
2. **审批 IPC** — `internal/approval/server.go:166` 硬编码 `net.Listen("unix", socketPath)`。

另有 `syscall.Kill`/`SIGKILL`（2 处）、`SysProcAttr{Setsid:true}` daemonize（`cmd/pocketctl/main.go:719`）等，但这些都已有 build-tag 文件或集中在一处，本次纳入 platform interface 一并收敛。

---

## 3. 目标与范围

### 3.1 本次交付

1. **`internal/platform/` 抽象层** — 把所有平台机制收敛为 interface：`PTYProvider`/`PTY`、`IPCListener`、`InstanceLocker`、`ProcessController`、`Daemonizer`、`ServiceManager`。Unix 实现从现有散落代码迁入；Windows 实现补齐非交互部分。
2. **拆分 `internal/session/manager.go`**（2141 行）— 按职责拆成 9 文件，平台依赖全部走 interface。
3. **Windows 非交互链路真能跑** — 单实例锁、审批 IPC、relay 连接、会话 watcher、Windows Service 安装，端到端在 Windows 验证。
4. **ConPTY stub** — Windows 上交互会话返回明确 `ErrUnsupported`，不 panic，留 v2 接口形状。

### 3.2 本次不交付

- ConPTY / 远程驱动 TUI（发消息、切 permission mode、切 effort、Ctrl+C）。
- WSL 路线文档化（`wsl.go` 保留但不作主线）。

### 3.3 抽象边界原则（贯穿全设计）

> **只有「平台特定机制」才进 `internal/platform/` interface**：PTY、signal、flock、Unix domain socket、Setsid daemonize。
> **「标准库跨平台 API」保持直接调用**：`os.Stat` / `os.ReadFile` / `os.Open` / `gorilla/websocket` / `net`（TCP）。
> 抽象的判据是「Windows 上行为不同或不可用」，**不是「能抽象就抽象」**。

据此，`manager.go` 里 9 处 `os.Stat`/`os.ReadFile` 文件系统调用**全部保持原样**，不进抽象层（否决了 agent 建议的 `fs_ops` / `FSStats` interface）。

### 3.4 透明度表（「为 Windows」 vs 「顺带重构」）

| 工作 | 性质 | 量占比 | 可降级 |
|---|---|---|---|
| platform/ interface 体系 + Unix 迁移 | 为 Windows（必需） | ~35% | — |
| Windows 非交互实现（Lock/IPC/Service/Process） | 为 Windows（必需） | ~20% | — |
| manager.go 里 PTY/IPC 调用改走 interface | 为 Windows（必需） | ~10% | — |
| **manager.go 按职责拆 9 文件** | 顺带重构 | ~25% | ✅ 可降级为「只收敛依赖、不拆文件」 |
| **已有 build-tag 抽象套 interface 壳**（lock/service） | 顺带重构 | ~10% | ✅ 可降级为「只加壳、实现不动」 |

> 注：即便选了「套壳都做」，`oom_*.go` 与 `fd_*.go` **不套壳**——它们没有跨平台对应物，套壳后另一端只能是 no-op，是纯无效工作。本次只对有跨平台语义的 `lock` 与 `service` 套壳。

### 3.5 成功标准（验收）

1. `GOOS=windows go build ./...` 通过。
2. macOS / Linux 现有功能零回归（现有端到端测试全绿，每个 PR 硬门禁）。
3. Windows 上：`pocketctl daemon start` 启动 → 单实例锁生效 → 连上 relay → web/iOS 能看到终端会话与审批流。
4. ConPTY 缺失时，Windows 交互功能返回明确错误而非 panic。

---

## 4. 决策记录（本次 brainstorming 全部选择）

| 决策点 | 选择 |
|---|---|
| 核心动机 | 有真实 Windows 用户/自用需求 → 一等公民方向 |
| 技术路线 | 原生 Windows 移植（WSL 不作主线，`wsl.go` 保留） |
| 重构深度 | **方案 C** — 完整 platform 层 + 深度重构 |
| 顺带重构取舍 | 都做（C 完整形态）：manager.go 拆分 + build-tag 套壳 |
| Windows 交付边界 | 架构就位 + Windows 非交互链路真能跑（ConPTY 留 v2 stub） |
| 验证环境 | 靠 CI（GitHub Actions windows-latest runner）主导 |
| ServiceManager 实现 | 保留现有 Unix 实现（套壳）+ 手写 `service_windows.go`（低回归路线） |
| Windows 冒烟频率 | 分层：PR 轻量（编译 + 三平台单测）+ nightly 深度端到端冒烟 |

---

## 5. 设计 A：`internal/platform/` 抽象层

### 5.1 总体形态

```go
// internal/platform/platform.go        —— 平台无关的 interface 定义（全部集中）
// internal/platform/platform_unix.go   //go:build !windows  → creack/pty、flock、unix socket、signal、Setsid
// internal/platform/platform_windows.go //go:build windows   → ConPTY stub、named pipe、Mutex、TerminateProcess、DETACHED
```

每个平台文件实现同一组构造函数；daemon 入口（`cmdDaemonStart`）只调 `platform.NewPTYProvider()` 等拿实例、注入 `session.Manager`。**daemon 入口与 `session` 包业务代码完全平台无关**，平台差异封死在 `platform` 包内。

### 5.2 interface 签名

| interface | 方法 | 用途 |
|---|---|---|
| `PTYProvider` | `Start(cmd *exec.Cmd, size *Size) (PTY, error)` | 工厂：启动进程并附到 PTY |
| `PTY` | `io.ReadWriteCloser` + `SetSize(rows, cols uint16) error` | PTY 实例的**原始字节 IO** |
| `IPCListener` | `Listen(name string) (net.Listener, error)` + `DefaultPath(name) string` | 审批 IPC |
| `InstanceLocker` | `Acquire(key string) (Lock, error)`（`Lock.Release()`） | 单实例锁 |
| `ProcessController` | `IsAlive(pid)` / `Terminate(pid)` / `Kill(pid)` | 进程存活/优雅停/强杀 |
| `Daemonizer` | `ForkDetached(self, args, env)` / `Restart(self, args)` | 后台化 + re-exec 重启 |
| `ServiceManager` | `Install(opts)` / `Uninstall()` / `Status()` | 系统服务（launchd/systemd/Win svc） |

### 5.3 各平台实现策略

| interface | Unix 实现 | Windows 实现（本次） |
|---|---|---|
| `PTYProvider`/`PTY` | 迁移 `creack/pty`（`pty.go`） | **stub**：返回 `ErrUnsupported`；`manager.go` 调用处降级（§7.2） |
| `IPCListener` | `net.Listen("unix", path)` | **named pipe**（`go-winio`）：`\\.\pipe\pocketctl-approval-{daemonID}` |
| `InstanceLocker` | 迁移 `flock`（`instance_unix.go`） | **全局命名 Mutex**（`CreateMutex`，进程退出自动释放） |
| `ProcessController` | 迁移 `syscall.Kill`/`SIGTERM`/`SIGKILL` | `IsAlive`=`OpenProcess`；`Kill`=`TerminateProcess`；`Terminate`=**named pipe 控制命令**（§5.4②） |
| `Daemonizer` | 迁移 `SysProcAttr{Setsid:true}`（`main.go:719`） | `CREATE_NO_WINDOW \| DETACHED_PROCESS` 创建 detached 子进程 |
| `ServiceManager` | 套壳现有 `service_darwin/linux.go` | 新建 `service_windows.go`（SCM，`golang.org/x/sys/windows/svc`） |

### 5.4 四个工程判断

**① PTY 分层 — 原始 IO 与业务语义分家**
`platform.PTY` 只管原始字节（`Read/Write/Close/SetSize`）；「Shift+Tab = `\x1b[Z`」「Ctrl+C = `0x03`」「退出 = `/exit\r`」「effort = `/effort X\r`」这些 **Claude TUI 业务语义留在 `session` 层**。platform 层不认识 Claude。Windows 未来上 ConPTY 时，platform 层零改动，只换实现。

**② Windows 优雅停止 — named pipe 控制通道替代信号**
Unix 上 `pid.Stop()` 靠 `SIGTERM`→等 5s→`SIGKILL`。Windows 无信号等价物。方案：daemon 启动时**额外开一个控制 named pipe**（`\\.\pipe\pocketctl-control-{daemonID}`），`ProcessController.Terminate(pid)` 在 Windows 上向该通道发 `stop` 命令，daemon 主循环 `select` 收到后优雅退出；超时则 `TerminateProcess` 强杀。

**③ oom/fd 不套壳 — 收缩范围**
`oom_*.go`（写 `/proc/self/oom_score_adj`）和 `fd_*.go`（stderr dup2）没有跨平台对应物，套 interface 后另一端只能是 no-op。本次只对有跨平台语义的 `lock` 和 `service` 套壳，`oom`/`fd` 保持 build-tag 现状。

**④ IPC 选 named pipe 而非 TCP**
审批 IPC 在 Windows 上用 named pipe（`go-winio`），语义与 unix socket 对齐（本地、有 ACL、不占端口、`POCKETCTL_APPROVAL_SOCK` 环境变量传 pipe 名，hook 侧改动最小）。TCP localhost 备选但需额外鉴权 token，本次不取。

### 5.5 daemon 入口消费方式（platform 无关）

```go
// cmdDaemonStart 重构后
pty := platform.NewPTYProvider()
ipc := platform.NewIPCListener()
lock := platform.NewInstanceLocker()
proc := platform.NewProcessController()
daemon := platform.NewDaemonizer()
svc := platform.NewServiceManager()
mgr := session.NewManager(pty, ipc, /* ... */)  // 注入，Manager 只依赖 interface
```

所有平台分支从 daemon 入口消失，业务代码只面向 interface。

---

## 6. 设计 B：`manager.go` 拆分蓝图

### 6.1 session 包拆分（9 文件）

`session` 包拆完后**不再 import `creack/pty` 或 `syscall`**——8 处 `ps.PTY.Write` 改调注入的 `platform.PTY`，`syscall.Kill`/`SIGKILL` 改调 `platform.ProcessController`，`startPTYCli` 改调 `platform.PTYProvider.Start`。

| 新文件 | ~行 | 容纳的方法（来自 manager.go） | 平台依赖 |
|---|---|---|---|
| `manager.go` | 300 | `SessionManager`/`ProcessState` struct、`NewSessionManager`、`SetApprovalServer`、`ResyncSessions` | 无 |
| `lifecycle.go` | 550 | `CreateSession`、`servePTYSession`、`handlePTYExit`、`watchdogBusy`、`tryResumeHistorical`、`KillSession` | 走 platform |
| `messages.go` | 420 | `SendMessage`、`sendToIdleTerminal`、`ResolveInteractivePrompt`、`readOutput` | 走 platform |
| `permissions.go` | 160 | `SetPermissionMode`、`SetEffort`、`InterruptSession`、`Get*/Update*` | 走 platform |
| `watcher.go` | 320 | `drainPTY`、`RegisterTerminalSession`、`ReviveTerminalSessionOnActivity`、`AbortSession`、`DropGhostSession`、`SetTailer`、`extractCwdFromJSONL`、`cwdFromProjectsDir` | 走 platform |
| `state.go` | 320 | 所有 `Set*/Get*/ListSessions/UpdateLastActivity` + `UpdateSessionTitle`、`GenerateTitle` | 无 |
| `approval.go` | 250 | `handleApprovalRequest/Cancel`、`ResolveApproval`、`handleOpencodePermission` | 无（依赖 approval 包） |
| `registry.go` | 100 | `registerCwd`/`unregisterCwd`/`CwdSessionCount`、`resolveCwd`、`normalizeCwd`、`validateCwd` | 无 |
| `models.go` | 250 | `resolveCleanModel`、`ListAvailableModels/ForAgent`、codex 系列、`resolveModelAlias` | 无 |

### 6.2 共享状态策略

`SessionManager` struct 所有字段**保留在 `manager.go`**，方法按文件拆分但仍接收 `*SessionManager`。不做 struct 组合拆分——简单、零破坏、易测。所有方法共享同一把 `mu sync.RWMutex`。

### 6.3 循环依赖预防

`lifecycle.CreateSession` ↔ `messages.SendMessage`：当前 `SendMessage` 里夹了 `tryResumeHistorical`。**把 `tryResumeHistorical` 移到 `lifecycle.go`**，`messages.SendMessage` 只管「向已存在会话写字节」。单向调用，无环。

### 6.4 测试迁移（现 14 个测试 → 归位）+ 补测

- `state_test.go`：6 个 `TestSetSession*/UpdateLastActivity/ListSessions`
- `lifecycle_test.go`：`TestKillSession_SetsKilledStatus` + 新增 `CreateSession`/`servePTYSession`
- `messages_test.go`：2 个 `TestSendMessage*` + 新增（用 mock PTY）
- `registry_test.go`：`TestResolveCwd`/`TestValidateCwd`
- **新增**（现覆盖率 0%，借拆分补关键路径，每文件 1–3 个核心方法单测，不追覆盖率）：`permissions_test.go`、`watcher_test.go`、`approval_test.go`、`models_test.go`

拆分是 **move-only 重构**：每搬一组方法跑一次 `go test ./internal/session/...`，逻辑零改动。

---

## 7. 设计 C：运行时数据流与错误降级

### 7.1 daemon 启动流程（重构后主干，平台无关）

```
cmdDaemonStart
 → platform.New*() 构造 6 个平台实例
 → locker.Acquire(daemonID)              ← 单实例：Unix flock / Win 全局 Mutex
 → 写 PID 文件
 → 若首次：daemonizer.ForkDetached()     ← Unix Setsid / Win DETACHED_PROCESS
 → ipc.Listen(approvalSock)              ← 审批：Unix socket / Win named pipe
 → [Windows 额外] 开控制 named pipe       ← 接收 stop 命令（替代信号）
 → session.NewManager(注入 platform 实例)  ← 只依赖 interface
 → ws.Client 连 relay
 → watcher 扫 ~/.claude/sessions/
 → 主循环
```

### 7.2 两种会话流

**流 A · 终端会话（watcher 发现，全平台可用 ⭐ Windows 核心价值）**

```
用户在 Windows Terminal 跑 claude
 → watcher 监到 ~/.claude/sessions/*.jsonl → tailer 解析
 → outputCh → ws → relay → web/iOS 实时展示
 → Claude PreToolUse hook 连审批 named pipe → daemon → relay → web/iOS 批审批
```

Windows 上这条链路完整可用——**用户在终端跑 claude，手机能看实时输出、批工具权限**。

**流 B · daemon 交互会话（PTY 驱动，Windows = stub）**

```
web/iOS 发 send_message → relay → ws → manager.SendMessage
 → [Unix]  platform.PTY.Write → claude TUI → drainPTY 读回 → 上报
 → [Win]   platform.PTY.Start/Write 返回 ErrUnsupported → manager 回明确错误 → UI 提示
```

### 7.3 Windows 错误降级（8 处 PTY 调用点）

| 调用点 | Windows 行为 | 用户可见 |
|---|---|---|
| `CreateSession`（主动建 PTY） | `ErrUnsupported` | web/iOS「新建会话」提示「Windows 请在终端启动」 |
| `SendMessage`（daemon 会话） | `ErrUnsupported` | 仅 daemon 会话；终端会话仍可（走 `--resume`，不依赖 PTY） |
| `SetPermissionMode`/`SetEffort`/`InterruptSession` | `ErrUnsupported` | 这些控件对 Windows daemon 会话隐藏 |
| `KillSession` | `/exit` 写失败 → 降级 `ProcessController.Kill`（TerminateProcess） | 仍可终止，只是不优雅 |
| `drainPTY`/`handlePTYExit` | 不触发（无 PTY 会话） | — |

**底线：PTY stub 不准 panic**，一律返回 `ErrUnsupported` 经 `outputCh` 上报，relay/web 转成用户可读提示。

### 7.4 测试 / CI 策略（CI 主导）

| 层级 | 触发 | 跑什么 | runner |
|---|---|---|---|
| **编译门禁** | 每次 PR | `GOOS={windows,darwin,linux} go build ./...` | ubuntu 交叉编译，秒级 |
| **单测矩阵** | 每次 PR | `go test ./...` 全量 | ubuntu + macos + **windows-latest** 三平台 |
| **Windows 端到端冒烟** | nightly + 发版标签 | 启 daemon → 验单例/PID/审批 pipe → 连 relay → 触发审批 → 验 PTY stub 不 panic → `daemon stop` 优雅退出 | **windows-latest**，跑 `scripts/ci-windows-smoke.ps1` |
| **Unix 回归门禁（硬）** | 每次 PR + 每个 move-only commit | 现有 `test-all.js`/`test-session-bridge.js` + session 单测 | ubuntu + macos |

**CI 局限（spec 如实写明）**：
- 无法验「真实 Claude TUI 交互」（PTY stub 本就不支持）→ 靠代码审查 + 未来 ConPTY。
- 无法验「iOS/web 连真实 relay」→ 附**手动抽验清单**（附录 B）作为 CI 补充。

---

## 8. 执行计划

5 个阶段 / PR，每个阶段有独立验收门禁，**任何阶段停下都不留破窗**。核心纪律：Unix 零回归是每个 PR 的硬门禁。

| 阶段 | PR | 交付物 | 验收门禁 | 可降级 |
|---|---|---|---|---|
| **0. platform 骨架** | PR1 | 建 `internal/platform/`，定义 6 interface；`platform_unix.go` 从现有代码搬实现；`platform_windows.go` 放 stub 构造函数。**业务代码暂不接入** | `GOOS={windows,darwin,linux} go build` 全过；Unix 行为零变化 | — |
| **1. 接入 interface** ⚠️最关键 | PR2 | `manager.go` 8 处 PTY/2 处 syscall、`approval/server.go`、daemon 单例锁、`cmdDaemonStart` 全部改调 platform interface | **Unix 现有测试 + `test-all.js`/`test-session-bridge.js` 端到端全绿**；行为零变化 | — |
| **2. 拆 manager.go** | PR3 (a–e) | 按第 6 节蓝图 move-only 搬到 9 文件；借机补 0% 文件关键路径单测 | 每 commit `go test ./internal/session/...` 绿；Unix 端到端绿 | ✅ 整阶段可降级为「只收敛依赖不拆文件」 |
| **3. Windows 非交互实现** | PR4 | `platform_windows.go` 真实实现（Mutex/named pipe/TerminateProcess/控制通道/DETACHED）；`service_windows.go`（SCM）；PTY stub；manager 调用点 ErrUnsupported 降级 | nightly `ci-windows-smoke.ps1` 全过 | — |
| **4. CI + 文档** | PR5 | CI 矩阵（三平台单测 + 编译门禁 + nightly Windows 冒烟）；`scripts/ci-windows-smoke.ps1`；手动抽验清单文档 | CI 全套就位并绿 | — |

**阶段 1 是全重构风险最高的点**——它把 Unix 真实行为从「直接 syscall」改成「经 interface」。要求：单独成 PR、充分端到端测试、合并前在 branch 上人工跑一轮真实 daemon。

### 8.1 回归保护纪律

1. **move-only 纪律**：阶段 2 每次只搬一组方法 + 立即跑测试，逻辑零改动。任何「顺手优化」留到拆分完成后的独立 PR。
2. **每个 PR 过 Unix 全套**：编译 + 三平台单测 + 现有端到端 JS 测试。
3. **build tag 隔离**：Unix 上跑的就是 Unix 实现，不需要 feature flag——阶段 1 接入后 Unix 行为应当字节级一致。
4. **小步可回滚**：PR3 拆成 a–e 子 PR，任一子步失败只回滚那一步，不波及全局。

### 8.2 风险登记

| 风险 | 概率 | 缓解 |
|---|---|---|
| 阶段 1 接入 interface 引入 Unix 回归 | 中 | 单独 PR + 充分端到端 + 合并前人工跑真实 daemon |
| Windows named pipe 与 Claude hook 集成（hook 要解析 pipe 名） | 中 | hook 侧 `POCKETCTL_APPROVAL_SOCK` 解析改造 + CI 冒烟覆盖 |
| `go-winio` 依赖引入 | 低 | Microsoft 官方成熟库 |
| 拆分 manager.go 时共享 mutex/状态出错 | 中 | move-only 纪律 + struct 字段不动（§6.2） |
| Windows 真实环境与 CI runner 差异 | 中 | 手动抽验清单 + 发布前人工一轮 |

### 8.3 工作量估算

- 阶段 0+1（platform + 接入）：~1.5 周
- 阶段 2（拆分 + 补测）：~1.5 周
- 阶段 3（Windows 非交互）：~1.5 周
- 阶段 4（CI + 文档）：~0.5 周
- **合计 ~5 周（±1）**

其中阶段 2 的「拆分」和阶段 0 的「build-tag 套壳」属「顺带重构」（§3.4），随时可降级砍到 ~3.5 周。

---

## 附录 A：本次明确不做的事（防 scope creep）

- ConPTY / 远程驱动 TUI（v2）
- `oom_*.go` / `fd_*.go` 套 interface 壳（无跨平台对应物）
- `fs_ops` / `FSStats` 文件系统抽象（标准库已跨平台）
- WSL 路线文档化
- `manager.go` 拆分之外的「顺手优化」（留独立 PR）
- 引入 `kardianos/service` 统一三平台（本次选低回归路线，Unix 保留手写）

## 附录 B：手动抽验清单（CI 补充，发布前在有 Windows 机器时跑一轮）

> 占位：实现阶段 PR4/PR5 时由实现者填充具体步骤。覆盖 CI 无法验证的「真实 relay + 真实 web/iOS 客户端」链路。

---

## 后续

本 spec 获批后，进入 **writing-plans** skill，基于第 8 节的 5 阶段产出可执行的实现计划（含每个 PR 的具体 task 分解）。**不直接进入实现**。
