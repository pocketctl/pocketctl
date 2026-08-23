# OpenCode 终端、Web 与 iOS 共享控制

Pocketctl 可以让**新启动的 OpenCode 终端会话**与 Web/iOS 使用同一个 OpenCode runtime。终端仍显示官方 OpenCode TUI；内容、状态、permission、question 和处理结果通过 Relay 同步到 Pocketctl 客户端，任一端完成交互后其他端会收敛到同一状态，并可继续从终端、Web 或 iOS 输入。

当前版本在 daemon 首次启动时自动检测 OpenCode。只要用户没有明确执行过 `disable`，检测通过后就会安装或修复 Pocketctl launcher；该过程不会重新安装或替换真实 OpenCode binary。

## 前提与启用

- 已安装 OpenCode `1.17.11` 或更高版本。
- 已安装并登录 Pocketctl。
- daemon 可在本机启动；Relay 是否在线不影响终端启动和 native fallback。

daemon 启动时会输出 Agent 检测版本、enable 结果和实际运行模式。也可以随时明确执行：

```bash
pocketctl agent opencode enable
pocketctl agent opencode status
```

`enable` 安装的是 **Pocketctl 提供的透明 launcher**，不是 OpenCode 官方另一个 launcher，也不会重新安装 OpenCode。Pocketctl 仅支持 macOS/Linux：在 `~/.pocketctl/bin/opencode` 创建 standalone resilient shim，将共享 PATH 配置写入 `~/.pocketctl/shell/path.sh`，并从 `~/.zshrc`、`~/.bash_profile`、`~/.bashrc` 加载。Windows 不再提供 launcher、二进制或验证支持。重复执行 `enable` 或再次启动 daemon 会 reconciliation launcher、真实 binary 路径和 PATH 配置。

新 shell 会自动加载 launcher。已有 shell 可执行：

```bash
source ~/.pocketctl/shell/path.sh
hash -r
command -v opencode
```

最后一条命令应解析到 `~/.pocketctl/bin/opencode`。如果仍解析到 `/opt/homebrew/bin/opencode` 等真实安装路径，该 shell 仍在 native mode；即使 daemon 的 shared runtime 可连接，也不会自动接管这个 shell 已启动的命令。

不希望本次 daemon 启动执行 Agent 自动检测和 enable/reconciliation，可使用：

```bash
pocketctl daemon start --no-agent-auto-enable
```

该参数只跳过本次自动处理，不等同于 `disable`。`--no-agent-prompt` 是它的 deprecated 兼容别名。daemon service 会在安装 service 时完成一次自动处理，受监督的 daemon child 使用 `--no-agent-auto-enable`，避免每次重启重复修改 shell 配置。

## 日常使用

启用后仍使用普通 OpenCode 命令：

```bash
opencode
opencode -c
opencode -s <session-id>
opencode run "检查这个项目"
```

常规 TUI 启动会被透明路由到 shared runtime。`opencode`、`-c/--continue`、`-s/--session`、`--fork` 和 `run` 的受支持组合进入 managed mode。launcher 会把交互式命令转换为官方 `opencode attach`，把 `run` 转换为官方 `opencode run --attach`，并绑定 daemon 分配的 session。

`serve`、显式 `attach`、`web`、`auth`、`models`、`upgrade`、`uninstall`、`mcp`、`export`、`import`、`stats`、`completion`、`debug`、`github`、`agent`、`session`、`db`、`acp` 等管理型子命令保持 native execution。尚未支持的参数组合也会给出一行提示并 native execution。

单次绕过 Pocketctl：

```bash
opencode --native
opencode --native -c
```

关闭集成：

```bash
pocketctl agent opencode disable
```

`disable` 只移除 Pocketctl 自己创建的 shim/PATH 配置并记录用户选择，不卸载 OpenCode，也不删除 OpenCode session 数据。

## 实现原理

```text
terminal: opencode
        │ Pocketctl launcher（本机连接 daemon 的预算为 200 ms）
        ▼
agent-control socket / named pipe
        ▼
Pocketctl daemon ── 管理官方 opencode serve（loopback）
        │                         ▲
        └── HTTP/SSE adapter ─────┤
                                  │ 官方 opencode attach
                                  └──────── terminal TUI

daemon ── authenticated WebSocket ── Relay ── Web / iOS
```

Pocketctl 提供 launcher、local IPC、runtime coordinator、terminal lease、session projection 和跨设备并发收敛；`opencode serve`、`opencode attach` 与 session 本身是 OpenCode 的能力。OpenCode server 是内容与交互状态的权威来源，daemon 的 process watcher 是当前终端生命周期状态的权威来源。

launcher 在约 200 ms 内判断本地 daemon 是否可连接；连接成功后允许最多 10 秒准备 shared runtime 和目标 session，随后执行真实 OpenCode binary 的 `attach` 或 `run --attach`。server 密码只经当前用户可访问的本地 IPC 返回，并通过 `OPENCODE_SERVER_PASSWORD` 环境变量交给 OpenCode，不进入 argv、Relay 或生命周期日志。

终端子进程启动后会绑定 lease。daemon 正常停止或升级时，若仍有活跃 terminal lease，会把 shared server、managed session registry、pending fork、generation 和 lease 状态写入私有 handoff state，下一 daemon 校验进程身份和 runtime health 后接管，而不会杀掉 TUI。Unix `exec` 会话退出后由 PID/process-start reaper 异步释放 lease，最后一个 lease 退出后才允许清理无人使用的 runtime。

## 会话发现、内容同步与状态收敛

managed launcher 调用 `Acquire` 后，daemon 会先创建或恢复目标 session，再异步发送幂等的 `session_discovered`。这个事件不会因为 Relay 离线或 daemon outbound channel 暂时背压而丢失：本地 terminal startup 不等待 Relay，通道恢复容量后事件会进入 durable WebSocket spool，并在连接恢复后按原 sequence 重放。

daemon 同时通过 shared `opencode serve` 定期发现 terminal session，并为每个 session 启动 message sync。同步查询携带 session directory，避免不同 project 中的同名或相邻 session 读取到错误内容。首次加载历史内容时遵循以下顺序：

1. 保留并按原顺序发送历史 `user_text`、`agent_text`、tool 等内容事件。
2. 丢弃历史记录中的 `session_status`，因为它描述的是旧 turn，而不是当前 terminal process。
3. 最后追加 process watcher 观察到的当前权威状态。

因此，一次 OpenCode turn 执行完成只表示当前生成结束。只要 session 仍为 `managed` 且 runtime 可连接，Web/iOS 应显示可继续输入的 idle session，不应因为历史 `completed` 或 `exited` 事件隐藏输入框并显示“Session 已结束”。

Relay 断线重连时，daemon 的发送顺序为：完成 register、按 sequence 重放 durable backlog、再发送当前内存 session 的 `Resync session_discovered` snapshot。这样最新 snapshot 总在历史 backlog 之后，旧状态不能覆盖当前状态。Relay 使用 daemon event sequence 去重，因此该流程是 at-least-once delivery，不要求事件只发送一次。

## 会话兼容策略

客户端依据 `control_mode` 和 capability 决定是否允许远程交互：

| 模式 | 含义 | Web/iOS 行为 |
|---|---|---|
| `managed` | 经 Pocketctl launcher 连接 shared runtime | 可继续输入，并可处理 permission/question |
| `unmanaged_active` | 启用前启动的原生 OpenCode 进程仍在运行 | 只读，不热接管当前交互 |
| `legacy_read_only` | 可发现的历史 OpenCode session，尚未安全提升 | 只读，提示从终端重新进入 |

Pocketctl 不会向已经运行的独立 OpenCode 进程注入代码或迁移其内存中的审批。请先退出旧 TUI，再执行：

```bash
opencode -c
# 或
opencode -s <session-id>
```

launcher 的 continue/resume 请求是显式提升信号；coordinator 确认没有活跃冲突后，才会在共享 server 上恢复并把 session 标记为 `managed`。存在冲突时保持原生/只读，不伪造远程审批卡片。

## 审批和问题的并发规则

- 终端和 Web/iOS 看到同一个 managed session 的待处理交互。
- 第一个被 OpenCode 接受的回答获胜。
- 其他设备收到 `resolved_elsewhere`，卡片显示“已在其他设备处理”，不能重复提交。
- Relay 暂时断线时，终端仍直接连接本机 OpenCode server；daemon 重连后先重放 durable backlog，再通过 session resync、SSE 和 pending snapshot 恢复远端状态。
- Web/iOS 永远不直连本机 OpenCode server，也不接收 server URL 或密码。

## 数据与安全边界

- OpenCode 自己的 session 数据仍由 OpenCode 保存在其本地存储中。Pocketctl 不会默认启用 OpenCode `/share`；OpenCode Share 是一条独立于 Pocketctl Relay 的链路。
- 为实现远程查看和控制，daemon 会把规范化后的会话内容、状态、permission/question 以及处理结果发送到用户配置并已认证的 Pocketctl Relay。不要把不受信任的 Relay 当作本地存储。
- macOS/Linux local IPC 使用当前用户私有目录和 `0600` 权限。OpenCode server 只绑定 loopback；Windows 不在支持范围内。
- launcher 配置原子写入 `~/.pocketctl/agent-launchers.json`，权限为 `0600`。损坏或未知版本配置会 fail closed，不静默覆盖。
- command/Agent 名称由 daemon 向 OpenCode 实时验证；permission action、question 结构、文本长度和 request/session 所有权都在 daemon/Relay 边界校验。
- lifecycle 日志不记录 server 密码、完整 prompt 或 question answer。
- 灰度计数保存在 `~/.pocketctl/opencode-telemetry.json`（`0600`），只包含固定枚举的 fallback 累计数与 runtime health 成功/失败累计数。daemon heartbeat 只发送这些数字；Relay 再次过滤未知键并仅保留当前连接的内存快照，不接收错误原文、路径、prompt、answer、session ID 或 server credential。

## 故障与回退

| 情况 | 结果 |
|---|---|
| pocketctl daemon 未运行或 local IPC 不可达 | launcher 在约 200 ms 连接预算内 fallback 到真实 OpenCode，保留 argv、env、cwd 和退出码 |
| Pocketctl binary 被移除或不可执行 | resilient shim 直接执行 enable 时验证过的真实 OpenCode binary |
| Relay/网络中断 | 本机终端继续；远端恢复连接后收敛 |
| Relay outbound channel 暂时满 | `Acquire` 和 terminal startup 不阻塞；生命周期事件异步等待容量并最终进入 durable spool |
| daemon/Relay 重连时有历史 backlog | 先 replay backlog，再发送当前 session resync，保证当前 snapshot 最后生效 |
| OpenCode 版本低于最低版本 | 不启动 managed runtime，提示原因并原生执行 |
| session 正被独立 OpenCode 进程占用 | 不热接管；客户端保持只读 |
| daemon 停止/升级且 TUI 活跃 | lease 保护 TUI 和共享 server，下一 daemon 恢复控制 |
| launcher 配置或 shim 异常 | 使用 `opencode --native`，再运行 status/disable 修复 |
| 内容完整但客户端显示“Session 已结束” | 检查 session 的 `control_mode` 和最后一个状态事件；managed session 应由当前 watcher/resync 状态覆盖历史完成状态 |

排查命令：

```bash
pocketctl agent opencode status
pocketctl daemon status
pocketctl daemon logs
pocketctl daemon doctor
pocketctl agent opencode help
```

`实际模式/Effective mode: managed` 仅在 launcher 已安装、当前 PATH 实际解析到该 launcher、runtime 可连接且版本兼容时成立。`Runtime 可连接/Runtime reachable: yes` 只表示 daemon 已准备好 shared runtime，不代表当前 shell 已启用 launcher。排查时应同时确认 `真实 binary/Real binary` 指向用户安装的 OpenCode，`Launcher` 指向 `~/.pocketctl/bin/opencode`，并用 `command -v opencode` 验证当前 shell。

## 发布前 smoke checklist

日常 A-D 自动化回归执行 `make test-opencode-managed`；完整本地发布门禁执行 `make test-opencode-managed-release`。测试使用假的 OpenCode HTTP/SSE 服务和本地 IPC，不调用模型；逐项用例和自动化映射见 [OpenCode Managed Terminal Control Milestone A-D 测试用例](opencode-managed-terminal-test-cases.md)。真实 CLI 生命周期 smoke 仅在显式设置 `POCKETCTL_OPENCODE_SMOKE=1` 时运行，避免普通发布门禁受宿主机上未固定版本 CLI 的启动延迟影响。独立的 `OpenCode Official CLI Smoke` workflow 每晚及手动触发时安装当前官方 `opencode-ai`，启用该变量并验证 `serve` health/session API 和 Pocketctl managed-runtime 兼容性。该 workflow 允许失败，不阻断主 CI 或 release；上游兼容失败仍应在发布前调查。

每次正式发布还应在一台装有官方 OpenCode 的机器手工验证：

1. 运行 `pocketctl agent opencode help`，确认 enable/disable/status/`--native` 帮助完整。
2. 正常启动 daemon，确认启动输出包含 OpenCode 检测版本、enable/reconciliation 结果和实际模式；再确认 `pocketctl agent opencode status` 显示 launcher PATH 生效、runtime reachable 为 Yes。
3. 运行 `opencode`，确认终端 TUI 正常、Web 与 iOS 出现同一个 managed session。
4. 触发 permission：先在终端回答，确认远端卡片收敛；再次触发并从 Web/iOS 回答，确认终端解除阻塞。
5. 触发含单选、多选、自定义答案的问题，确认多端结构和最终答案一致。
6. 两个客户端同时回答同一请求，确认只有一个获胜，另一端显示“已在其他设备处理”。
7. 暂停 Relay 网络，确认终端继续工作；恢复网络后 pending 状态在数秒内收敛。
8. TUI 活跃时停止并重启 daemon，确认 TUI 和 session 未被杀死或分叉。
9. daemon 完全停止后运行 `opencode -c`，确认在短暂的一行提示后原生启动，并保留退出码。
10. 启用前先启动一个原生 session，确认 Web/iOS 只读；退出后通过 `opencode -c` 或 `-s` 重新进入并提升为 managed。
11. 运行 `opencode --native`，再运行 `pocketctl agent opencode disable`，确认真实 OpenCode 与本地 session 数据仍完整。
12. 断开 Relay 后创建并完成一个 managed session，再恢复连接，确认历史内容完整、session 最终状态正确且 Web/iOS 输入框可用。
13. 制造 outbound backlog 后重连，确认 durable replay 先于 session resync，历史 `completed/exited` 不会覆盖当前 idle/busy 状态。

## 灰度与回滚

默认 rollout 策略是 daemon 启动时自动检测并 enable/reconcile 尚未明确禁用的 OpenCode；用户执行 `disable` 后会持久记录选择，后续自动处理不会重新启用。发布阶段应观察 runtime health 与 fallback reason 的匿名计数，但不得采集 prompt、answer 或 server credential。

发生问题时按以下顺序回滚：单次命令使用 `opencode --native`；用户级关闭执行 `pocketctl agent opencode disable`；版本级关闭 managed OpenCode feature，同时保持 native fallback 和历史 session 数据不变。
