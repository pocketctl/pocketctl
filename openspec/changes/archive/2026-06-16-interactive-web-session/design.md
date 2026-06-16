## Context

pocketctl 的 daemon（web 创建）session 当前用 `claude -p`（print 模式，一次性）。PTY spike 实测确认 `-p` 硬禁所有 slash command / skill（`/help` → 合成 "isn't available"）。要让 web 达到与终端 claude 一致的交互能力（执行 `/help`、`/opsx:new` 等 skill、`/compact` 等 local command），daemon session 必须改为 **PTY 驱动的 interactive claude**。

spike 已验证三个关键前提（见 proposal「技术验证」）：
1. PTY interactive claude 能执行 slash/skill
2. 清理 `CLAUDE_CODE_*` 环境后，PTY claude 正常写 JSONL（输出通道成立）
3. stdin 用 `\r` 提交

terminal session（watcher 发现的用户终端 claude）路径**不变**——继续走 `--resume` + JSONL tailer（session-bridge）。

## Goals

- web 创建的 daemon session 能执行 slash command（local command + skill），能力对齐终端 claude
- 复用现有 JSONL tailer（session-bridge）作为输出通道，不引入 TUI/ANSI 解析
- 不破坏 terminal session 的现有 `--resume` 机制

## Non-Goals

- 不改造 terminal session 的发现/同步（session-bridge 保持现状）
- 不解析 PTY stdout TUI（仅用 JSONL 作为结构化输出）
- v1 不做空闲超时回收（进程常驻，后续优化）
- 不处理 claude TUI 的高级交互（计划模式审批流等）——v1 用 `acceptEdits` 减少提示

## Decisions

### D1: daemon session 用 PTY 持久 interactive claude 替代 `-p` 一次性
**理由**：spike 实测 `-p`（含 `--input-format stream-json`）硬禁 slash/skill；PTY interactive 能执行。
**改造**：`CreateSession`(manager.go:160) 从 `exec.CommandContext + BuildClaudeArgs(-p) + readOutput` 改为 `pty.Start` 启动 interactive claude（无 `-p`、无 `--output-format`）；`SendMessage`(manager.go:484) daemon 路径从「spawn 新 `claude -p --resume`」改为「写 PTY stdin」。

### D2: 输出走 JSONL tailer，不解析 PTY stdout
**理由**：spike v5 验证清理环境后 PTY claude 写 JSONL（`1620f581-*.jsonl` 记录 assistant 响应）；stdout 是 TUI（ANSI/spinner/光标），解析脆。
**实现**：复用 `internal/watcher/tailer.go` 的 `JSONLTailer`（session-bridge 已实现，1s 轮询 + `ParseJSONLLine`）。daemon PTY session 启动后立即起一个 tailer 监听 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`，复用 `main.go` 已有的 `SetTailer` 接入（fix-session-interaction）。`readOutput` 对 daemon session 不再使用。

### D3: PTY 启动前清理 `CLAUDE_CODE_*` 环境变量
**理由**：spike 根因——继承的 `CLAUDE_CODE_CHILD_SESSION=1` 让 claude 误判为 child session、进入 ephemeral 不写 JSONL。清理后恢复持久化。
**实现**：`pty.Start` 前构造 child env，`unset` 所有 `CLAUDE_CODE*` 前缀变量 + `CLAUDECODE` + `CLAUDE_EFFORT`（保留 `ANTHROPIC_*`、`PATH` 等正常变量）。

### D4: stdin 用 `\r`（CR）提交，禁用 `\n`
**理由**：spike 验证 claude TUI raw 模式下 `\r`=Enter 提交、`\n`=输入框内换行（不提交）。
**实现**：`SendMessage` 写 `content + "\r"` 到 PTY stdin。

### D5: session-id 从 JSONL init 记录获取（pending → real）
**理由**：PTY claude 启动后写 JSONL init（含 `session_id`），daemon 无法预知。复用 fix-session-interaction 的 pending-id 机制。
**实现**：`CreateSession` 先用 `pending-<ts>` 占位；tailer 读到 init 记录后，提取 `session_id` 并更新 session 注册（`pending-*` → real id），与现有 pending 机制一致。

### D6: daemon vs terminal session 路径区分
- **daemon（web 创建）**：PTY 持久 + stdin 写入（本变更）
- **terminal（watcher 发现）**：`--resume` + JSONL tailer（不变，session-bridge）
**理由**：不破坏 terminal session 跨设备接力。`SendMessage` 按 `ps.Source` 分流（已有 source 字段）。

### D7: PTY 生命周期与崩溃检测
- 进程常驻：idle 保持，多消息复用
- 崩溃检测：goroutine `cmd.Wait()`，非 0 退出 → `status=error/exited` + `session_status` 事件
- 优雅退出：session 结束时写 `/exit\r`，超时 SIGTERM，再 SIGKILL
- v1 不做空闲超时回收（防资源泄漏留作后续）
**理由**：最简可行；崩溃恢复的自动 `--resume` 留 open question。

### D8: PTY 库 = `github.com/creack/pty`
**理由**：Go 生态最成熟、跨 macOS/Linux 的 PTY 库，API 简洁（`pty.Start(cmd)` 返回 `*os.File`）。

## Architecture / Data Flow

```
┌─────────┐  session_create   ┌─────────┐  CreateSession   ┌──────────────────┐
│  Web    │ ───────────────▶  │  Relay  │ ──────────────▶  │ SessionManager   │
│ (Vue)   │                   │ (Fastify)│                  │  (daemon, Go)    │
└─────────┘                   └─────────┘                   └────────┬─────────┘
      ▲                                                             │
      │ agent_text/tool_call/                                 D1+D3 │ pty.Start
      │ session_status/command_receipt                  ┌────────────▼────────────┐
      │                                                  │ PTY claude (interactive)│
      │                                                  │ env: CLAUDE_CODE_* unset │
      │                                                  │ stdin ← content + "\r"   │
      │                                                  └────────────┬────────────┘
      │                                                            │ writes
      │                                                            ▼
      │                                              ~/.claude/projects/<cwd>/<sid>.jsonl
      │                                                            │
      │                                                  D2  ┌─────▼─────┐
      │ ◀──────── outputCh ─ adapter(ParseJSONLLine) ◀──── JSONLTailer │ (1s tail)
      │                                                          └──────────┘
      │
      │  send_message (follow-up)
      └──────▶ SendMessage ──▶ pty.WriteString(content + "\r")  [D4]
                              (SAME process, no respawn)
```

terminal session 路径（不变）：`SendMessage` 检测 `source=terminal` → `sendToIdleTerminal`（`--resume` + 现有 tailer pause/resume）。

## Key Implementation Points

1. **`CreateSession`(manager.go:160)**：
   - 移除 `BuildClaudeArgs(-p)` + `StdoutPipe` + `readOutput`
   - 改为：构造 `exec.Cmd`（`claude --permission-mode acceptEdits`，无 `-p`）→ 清理 env（D3）→ `pty.Start(cmd)` → 起 `JSONLTailer`（D2）→ session `idle`
   - `ProcessState` 加 `PTY *os.File`（stdin 写入句柄）

2. **`SendMessage`(manager.go:484)**：
   - `source=daemon && PTY alive` 分支：`ps.PTY.WriteString(content + "\r")`（D4），更新 `LastActivityAt`，status→running
   - 移除 daemon 路径的 `exec.CommandContext(--resume)` spawn
   - `source=terminal` 路径完全保留

3. **新增 PTY helper**（`internal/session/pty.go` 或 manager 内）：
   - `startPTYCli(cliPath, args, cwd, env) (*os.File, *exec.Cmd, error)`：env 清理 + `pty.Start`
   - `waitAndNotify(cmd, ps, sm)`：goroutine `Wait()` + 崩溃→status 上报（D7）

4. **tailer 复用**（`internal/watcher/tailer.go`）：现有 `JSONLTailer` 直接服务 daemon PTY session；`main.go` 已有 `SetTailer` 接入点（fix-session-interaction）。

5. **session-id 更新**：tailer 读到 init 记录 → 提取 `session_id` → `sm.renameSession(pending-* → real)`（D5，复用 pending 机制）。

6. **`BuildClaudeArgs`**：保留（仍服务 terminal session 的 `--resume`）；新增 `BuildInteractiveArgs`（仅 `--permission-mode acceptEdits`，无 `-p`/`--output-format`）。

## Risks / Trade-offs

| 风险 | 影响 | 缓解 |
|------|------|------|
| 每个 daemon session 常驻一个 claude 进程 | 内存/CPU 占用 | v1 接受；后续加空闲超时回收 |
| JSONL tailer 1s 轮询延迟 | 首字延迟 ~1s | 可接受；后续可换 fsnotify |
| PTY claude 崩溃 | session 进入 error | D7 检测 + 上报；用户重试或 `--resume` |
| macOS codesign（PTY re-exec 子进程） | `Killed: 9` | 已有 codesign 流程（每次更新二进制后 `codesign --force`，见 memory） |
| claude TUI 权限/计划模式提示 | 卡住等待输入 | `acceptEdits` 减少提示；v1 不处理高级审批流 |

## Open Questions

- PTY 崩溃后是否自动 `claude --resume <sid>` 重建（v1 不做，报 error 让用户重试）
- JSONL tailer 间隔是否需要从 1s 调小或换 fsnotify（v1 保持 1s，与 session-bridge 一致）
- claude TUI 的多行输入/特殊按键（如 Esc 中断）是否需要 web 支持（v1 仅单行 + `\r`）
