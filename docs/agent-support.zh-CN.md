# Agent 支持详情

[返回 README](../README.zh-CN.md)

## Agent 支持范围

PocketCtl 按真实能力开放控制。发现一个会话，并不代表它会自动获得远程控制能力。

| Agent | 查看能力 | 远程交互 | 集成方式 |
|---|---|---|---|
| **Claude Code** | 实时历史与输出 | 用户独立启动的终端会话可在空闲或退出后通过 `--resume` 接力；PocketCtl 创建的 PTY 支持 Web/iOS 审批，独立终端会话仍以原生终端为权威。 | 自动发现，不宣称共享 Runtime。详见 [Claude 跨端控制](claude-cross-device-control.md)。 |
| **Codex CLI 0.144.1+** | Thread、Turn、Item、计划与交互 | 受管会话支持共享输入、Steer/Interrupt、审批、问题、标准 MCP Elicitation，以及带自动补全的 `/` 命令与技能显式调用。 | 可选 Launcher 将官方 TUI 和 Daemon 连接到同一个 App Server。详见 [Codex 受管终端控制](codex-managed-terminal.md)。 |
| **Codex Desktop** | 增量同步 rollout 历史、状态、模型、Token、工具、计划和文件改动 | 只读，不支持远程输入、审批、中断、终止、恢复或创建会话。 | 自动发现的 Observer；以 `codex-desktop` 与 Codex CLI 分开显示。 |
| **OpenCode 1.17.11+** | 会话、内容、状态、命令与交互 | 受管会话支持共享输入、Permission 和 Question；已独立运行的进程保持只读，直到通过 Launcher 安全恢复。 | 可选 Launcher 将官方 TUI 和 Daemon 连接到同一个共享 Server。详见 [OpenCode 受管终端控制](opencode-managed-terminal.md)。 |
| **DeepSeek Harness 0.2.0-rc.2（预览）** | 原生会话历史、流式输出、工具和 Turn | 共享输入、排队/steer、取消、单次审批与提问 | 显式接入本地 DSH Web 客户端使用的同一个 `dsh web` Host。 |
| **ZCode Desktop** | 从本地 SQLite 增量同步历史 | 只读，不支持远程输入、审批、恢复或控制。 | 针对 Desktop 拥有会话、显式启用的 Observer。 |
| **ZCode Runtime** | 原生 ZCode 会话的实时事件与 Turn 状态 | PocketCtl 创建的会话支持远程创建、共享输入和中断活动 Turn；其余反向交互请求保持不支持。 | Daemon 拥有的 `zcode app-server --stdio` 运行时，与 ZCode Desktop Observer 分开显示。 |

PocketCtl 可通过 Agent Provider 扩展。公共适配协议见
[添加 Agent](adding-an-agent.md)。
