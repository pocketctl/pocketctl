## Why

web 客户端创建的 daemon session 当前用 `claude -p`（print 模式，一次性非交互）。**实测确认：`-p` 模式硬禁所有 slash command 和 skill** —— 无论 `--input-format text` 还是 `stream-json`，`/help` 都返回合成 `"/help isn't available in this environment"`（`model: <synthetic>`、`num_turns: 0`、`duration_ms: 4`）。根因：`-p`（print）模式设计为非交互一次性输出，故意绕过 Claude Code 客户端的 slash 解析层（该层负责识别 `/cmd` → 执行 local command 或加载 skill 的 SKILL.md）。

这导致诊断报告里的三类「无响应」：
- **skill 不执行**（/opsx:new 等）→ 返回合成 "No response requested." / "isn't available"
- **/compact 等需 LLM 的本地命令**→ 反馈延迟/异常
- **偶发进程崩溃**（b8a8faef）→ stdout 不完整、web 收不到响应

对比：用户在**终端**开的 claude（interactive 模式）skill 正常执行，web 通过 JSONL tailer（session-bridge 已实现）能看到结果。问题仅存在于 **web 创建的 daemon session**（-p 模式）——它们无法执行 skill / 部分 local command，与终端体验不一致。

## What Changes

- daemon 创建的 web session 从 `claude -p`（一次性）改为 **PTY 跑 interactive claude**（持久进程，slash command / skill 可执行，达到与终端 claude 一致的能力）
- daemon 起 PTY claude 前必须**清理 `CLAUDE_CODE_*` 环境变量**（关键：否则继承的 `CLAUDE_CODE_CHILD_SESSION=1` 让 claude 误判为 child session、进入 ephemeral 不写 JSONL）；stdin 用 `\r`（Enter）提交（TUI raw 模式下 `\n` 只换行不提交）
- **复用 session-bridge 的 JSONL tailer 机制** 同步会话内容到 web（输出侧已有成熟机制）
- 新增 **web WS 消息 → daemon → PTY stdin** 转发链路（输入侧）
- 新增 **PTY 进程生命周期管理**：启动、空闲保持、崩溃恢复、优雅退出
- **BREAKING**：daemon session 生命周期从一次性 `running → completed` 改为持久 `running ↔ idle`（进程在会话期间常驻，多条消息复用同一进程，保持 claude 上下文）
- PTY 的实时 stdout 含 ANSI/TUI 控制序列，需清洗策略（主走 JSONL，stdout 作为实时性补充 —— design 定）

## Capabilities

### New Capabilities
- `interactive-command-execution`: web 创建的 daemon session 通过 PTY interactive claude 执行 slash command（local command + skill），能力对齐终端 claude；含 PTY 进程管理、stdin 转发、输出采集

### Modified Capabilities
- `session-lifecycle`: daemon session 生命周期模型从一次性（`running → completed`）改为持久交互（`running ↔ idle`，进程常驻、多消息复用、空闲超时回收）
- `claude-adapter`: 适配 PTY interactive claude 输出 —— 复用 JSONL tailer 作为主要结构化数据源，新增 PTY stdin 写入与实时 stdout 捕获（含 ANSI 清洗）

## Impact

- **Go daemon**：
  - `internal/session/manager.go`：session 创建改用 PTY 启动 interactive claude；`SendMessage` 改为写 PTY stdin（替代当前 spawn `claude -p --resume`）；新增持久进程的生命周期/空闲管理
  - `internal/watcher/tailer.go`：复用现有 JSONL tailer（session-bridge 已实现），可能微调以服务 daemon session
  - `internal/adapter/`：新增 PTY stdout 适配（ANSI 清洗 + 实时转发），JSONL 解析复用 `claude_jsonl.go`
  - 新增 `internal/pty/`（或类似）：PTY 创建、stdin/stdout 管道、进程信号、崩溃恢复
- **Relay**：事件类型基本复用（`session_status` / `agent_text` / `tool_call` / `command_receipt`），可能微调 `session_status` 的 idle/running 语义
- **Web**：`SessionDetail.vue` 命令执行 UI 反馈（复用 command_receipt 卡片）；可能调整"会话保持"提示
- **依赖**：新增 `github.com/creack/pty`（Go PTY 库）
- **风险**：
  - PTY TUI 输出含 ANSI/光标控制序列，需可靠清洗（否则 web 显示乱码）
  - JSONL 实时延迟（~1s tail 间隔），实时性需 stdout 补充
  - PTY 进程崩溃恢复（interactive claude 异常退出的检测与重建）
  - macOS Sequoia codesign（PTY 子进程 re-exec 受益于已有 codesign 流程，需验证）
- **设计验证**：PTY spike 已完成（见下方「技术验证」），两个关键假设均已证实

## 技术验证（PTY Spike 结论）

通过 5 轮 Python `pty.fork` 实测，确认方案 A' 两个关键假设成立：

**1. PTY interactive claude 能执行 slash command / skill**（对比 -p 禁用）
- `/help` 在 PTY interactive 下显示完整帮助内容（-p 模式返回合成 `"/help isn't available in this environment"`）
- 普通消息正常往返（"reply PONG" → `⏺PONG`）

**2. PTY claude 写 JSONL 的关键前提：清理 `CLAUDE_CODE_*` 环境变量**
- 初始 spike：PTY claude 处理消息（stdout 有响应）但**不写 JSONL**（ephemeral）
- 根因：继承的 `CLAUDE_CODE_CHILD_SESSION=1` + `CLAUDECODE=1` + `CLAUDE_CODE_ENTRYPOINT=cli` 等标记，让 claude 误判为 child session（subagent），进入 ephemeral 模式跳过持久化
- 修复：exec 前 `unset` 所有 `CLAUDE_CODE_*` → PTY claude 正常写 JSONL（实测新建 `1620f581-*.jsonl` 记录了 assistant "PONG"）
- → 输出通道走 **JSONL tailer（复用 session-bridge）** 成立

**3. stdin 提交键：`\r`（Enter）**，非 `\n`（claude TUI raw 模式下 `\n` 只是换行）

**4. `-p` 模式仍正常写 JSONL**（对比验证：现有 `74147d83.jsonl` 即 -p stream-json 测试所写）—— 当前 daemon session 的 -p JSONL 持久化不受本次变更影响

**衍生结论**：session-bridge（terminal session JSONL tailer）在真实终端下健康——真实终端 claude 无 `CLAUDE_CODE_CHILD_SESSION` 标记，正常写 JSONL。ephemeral 仅在继承该标记时发生。

**方案 A' 技术可行**。daemon 起 PTY claude 时：(a) 清理 `CLAUDE_CODE_*` 环境、(b) stdin 用 `\r` 提交、(c) 输出走 JSONL tailer。
