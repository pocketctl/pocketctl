# Codex 终端、Web 与 iOS 共享控制

Pocketctl 可以让新启动的 Codex 终端会话与 Web/iOS 共享同一个长期运行的 Codex app-server。终端继续使用官方 Codex TUI；审批、问题、标准 MCP elicitation 和会话进度会投影到 Pocketctl 客户端。任一端先完成交互后，其他端会收敛为“已处理”。

该能力使用 Codex 官方 `--remote` 接口，不自行复刻 TUI。最低支持版本为 Codex CLI `0.144.1`，并且启用时还会生成本机 schema 检查必需的 app-server 能力。

> 本文只描述 **Codex CLI** 的受管控制。OpenAI Codex Desktop 创建的 rollout 会由 daemon 自动监听并以独立的 `codex-desktop` Agent 类型同步，但属于只读 Observer：Web/iOS 可查看历史和后续增量，不可输入、审批、中断、终止、恢复或创建 Desktop 会话。PocketCtl 的新建会话入口始终创建 `codex` CLI 会话。

## daemon 启动与启用

正常执行：

```bash
pocketctl daemon start
```

daemon 首次启动会检测 OpenCode 和 Codex。满足版本与能力要求且用户尚未明确选择时，会自动安装对应 Pocketctl launcher；Agent 未安装、版本过低或能力探测失败时只输出一行提示，**不影响 daemon 或其他 Agent 启动**。如需跳过本次检测与自动启用：

```bash
pocketctl daemon start --no-agent-auto-enable
```

也可以随时单独操作：

```bash
pocketctl agent codex enable
pocketctl agent codex status
pocketctl agent codex disable
```

`enable` 和 `disable` 都不要求重启 daemon。启用后若当前 shell 尚未加载新的 PATH，请开启新 shell 或重新加载登录 shell；daemon 会在第一次受管启动时按需创建 app-server。

`enable` 只安装 Pocketctl 的透明 launcher，不重新安装 Codex。Pocketctl 仅支持 macOS/Linux，默认在 `~/.pocketctl/bin/codex` 创建 shim；Windows 不再提供 launcher、二进制或验证支持。`disable` 只移除 Pocketctl 创建的 launcher/PATH 配置，不卸载 Codex，也不删除 `$CODEX_HOME` 中的 thread 数据。

## 终端命令是否变化

日常操作不变：

```bash
codex
codex "检查这个项目"
codex resume <thread-id>
```

launcher 从 daemon 取得本机 app-server 地址后，实际调用官方命令形态为：

```bash
codex --remote unix:///private/path/pocketctl-codex.sock
codex resume <thread-id> --remote unix:///private/path/pocketctl-codex.sock
```

这部分参数由 launcher 自动追加，用户不需要先执行“连接 App Server”命令，也不需要手工维护 socket。

`exec`、`review`、`login`、`logout`、`mcp`、`plugin`、`app-server`、`completion`、`update`、`doctor`、`sandbox` 等非交互或管理命令保持 Codex 原生执行；用户已明确传入 `--remote` 时也不会重写。

单次绕过 Pocketctl：

```bash
codex --native
codex --native resume <thread-id>
```

## 实现原理

```text
Official Codex TUI ── --remote ──┐
                                 ├── one Pocketctl-managed codex app-server
Pocketctl daemon client ─────────┘                │
                                                  └── Codex thread / turn / item authority

Pocketctl daemon ── authenticated Relay ── Web / iOS
```

Pocketctl 0.144.1 实机 spike 验证了同一 app-server 上的两个已初始化连接可以观察同一 thread 的待处理请求；Web/iOS 通过 daemon 回答后，app-server 向官方 TUI 发送 `serverRequest/resolved`，原生审批界面随即关闭。daemon 重连并恢复 thread 后，app-server 会重新投递仍待处理的请求。因此首版采用“官方 TUI 与 daemon 各自连接同一 app-server”，不在中间代理或重写官方 TUI 的 JSON-RPC。

app-server 是交互结果的最终权威来源。Pocketctl 在本地也做 first-writer-wins 原子收敛，避免同一 daemon 上的多个远端客户端重复写入；跨连接最终以 app-server 接受的第一个响应为准。

daemon 为每条连接发送 `initialize`，随后发送 `initialized`，并按运行时生成的 schema 做版本/能力协商。当前只 opt in `experimentalApi`；在 Web 与 iOS 完整支持 OpenAI 扩展表单前，不声明 `mcpServerOpenaiFormElicitation`。

### 服务 PATH 与 Codex 升级收敛

LaunchAgent（macOS）和 systemd user service（Linux）不会自动获得交互 shell 的 Node 路径。执行 `pocketctl daemon service install` 时，Pocketctl 只把当时有效的 `PATH` 写入服务定义；不会写入 token、代理、API key 或其他环境变量。该修复发布前已安装的受管 daemon 需要重新生成一次服务定义：

```bash
pocketctl daemon service install
```

不支持手工编辑 plist 或 systemd unit 作为修复方式。若 Node/Codex 被移动到了另一个安装前缀，先执行 `pocketctl agent codex enable` 更新 launcher 的真实 binary 记录，再重新安装 daemon service。

每一次正常的 `codex`、`codex "prompt"` 或 `codex resume <thread-id>` 都会走 managed `Acquire`，探测真实 binary、版本与 capability schema；`codex --version` 保持原生查询，不触发 `Acquire`。若 idle app-server 的 binary、版本或 schema 与本次 Acquire 不一致，Pocketctl 会在启动 TUI 前停止旧 generation、保留已记录的 managed thread，并以递增 generation 启动新 app-server。若当前 generation 有活跃 Codex terminal lease，则保持旧 runtime；新的 Acquire 返回 native fallback，不会把新版 TUI 接到旧 app-server，也不会给旧 generation 增加 lease。daemon 重启时仍采用活跃的旧 handoff；最后一条旧 lease 释放后，下一次 Acquire 再完成 managed 收敛。

Acquire 是只读协调：不会改写 `agent-launchers.json`、shell profile、shim 或 PATH 文件，也不会执行 Codex/npm 自动升级。

## 支持的交互

- command execution、file change 和 permissions 审批。
- `requestUserInput` 单选、多选、自定义答案和 secret 输入；secret 只进入即时 app-server 响应，不进入 resolved 事件或日志。
- MCP 标准 `form` 和 `url` elicitation；支持字符串、枚举/带标题枚举、布尔、整数/数值、多选以及长度/范围/格式约束。
- MCP `accept`、`decline`、`cancel`。接受表单时，填写内容只用于即时响应，不持久化到 resolved 投影。
- 当前不远程展示 provider-specific `openai/form`；该请求保留给官方 TUI 处理。

终端、Web 和 iOS 同时看到同一个请求时，先被接受的回答获胜。其他端收到 `resolved_elsewhere` 后卡片禁用，不能再次提交。

## 生命周期、恢复与降级

app-server 按需启动，不会因为 daemon 运行就常驻一个未使用的 Codex 进程。终端启动后会绑定 generation/lease。daemon 重启时，私有 handoff 状态保存 app-server PID、endpoint、generation、活跃 lease 和 managed thread ID；新 daemon 采用原 app-server、恢复 thread 并重新订阅事件。连接意外断开时使用有界指数退避重连。

### Lifecycle ownership and mapping

Codex app-server 的 native event 是 lifecycle 的唯一输入；Pocketctl 只做下列 projection，不以单个 item 或 turn 推断 managed thread 是否可继续使用。`item/completed` 只对该 item 的 snapshot 权威，不能改变 thread availability。`turn/completed` 永不终止 managed thread：`completed` 与 `interrupted` 都收敛到 `idle`，`failed` 先发出 normalized error event，再收敛到 `idle`。只有 `thread/status` 决定 managed thread 的 availability。

| Native event | Pocketctl projection | Composer |
|---|---|---|
| `turn/started` | `running` | stop/interrupt control |
| `turn/completed: completed` | `idle` | enabled |
| `turn/completed: interrupted` | `idle` | enabled |
| `turn/completed: failed` | normalized error event + `idle` | enabled |
| `thread/status: active` | `running` | stop/steer control |
| `thread/status: idle` | `idle` | enabled |
| `thread/status: systemError` | `error` | enabled only when managed runtime remains reachable |
| `thread/status: notLoaded` | `disconnected` | disabled |
| explicit kill/close | `killed/exited` | governed by managed runtime reachability |

`control_mode=managed` 表示 Web/iOS composer 在 managed runtime 与 daemon 均可达时保持可恢复，即使一个 turn 已结束。reconnect 的 hydration 必须恢复 thread snapshot 和当前 `thread/status`；不论先收到 `turn/completed` 后收到 `thread/status: idle`，还是顺序相反，最终都必须稳定为 `idle`。Relay 保持 protocol-neutral，只转发既有的规范化 projection；此生命周期调整不重写 production Relay，也不引入 DB migration。

旧的 `codex exec --json` backend 仍保留为功能和版本回退。受管能力不可用时：

- 终端 launcher 快速回退真实 Codex binary，保留 argv、env、cwd 和退出码。
- Web/iOS 仍可使用原有 subprocess backend 发起非受管 Codex 工作，但不伪造受管 TUI 的跨端审批能力。

| 情况 | 行为 |
|---|---|
| Codex 未安装 | daemon 提示并继续；Codex launcher 不会自动启用 |
| Codex `< 0.144.1` | daemon 提示并继续；保持原生 TUI/旧 backend |
| 版本满足但 schema 缺少核心或 `--remote` 能力 | 不启用受管模式，输出 capability 原因 |
| daemon/local IPC 不可达 | launcher 在短预算内原生启动 Codex |
| Relay/网络中断 | 本机 TUI 与 app-server 继续运行，远端重连后收敛 |
| daemon 重启且 TUI 活跃 | 通过 handoff/lease 采用原 app-server，不创建第二份 thread |
| daemon client 掉线 | 有界重连、恢复 managed thread 和待处理交互 |
| idle runtime 的 binary/version/schema 已变化 | 下次 managed Acquire 滚动到下一 generation，保留 managed thread registry |
| runtime identity 已变化但 terminal lease 活跃 | 保持当前 generation；新 Acquire native fallback 且不增加旧 lease；daemon 重启仍采用旧 handoff；待后续 idle Acquire 再收敛 |

如果 Codex 在启用后被降级到旧版本，配置可保持“已启用”，但 effective mode 会显示 native fallback；升级回兼容版本后再次执行 `status` 或直接启动即可，无需重启 daemon。

## 安全与可观测性

- Unix app-server socket 位于当前用户私有 `0700` 目录，socket/handoff/config 文件为当前用户私有权限；endpoint 不经 Relay 暴露。
- Windows 不在支持或发布验证范围内。
- Relay 只接收规范化后的 thread/turn/item 与交互投影；不会接收 app-server endpoint、认证材料或 MCP 表单提交内容。
- JSON-RPC request ID 保留 number/string 类型并绑定 generation、thread 和 request；旧 generation 或已解决请求会被拒绝。
- 日志不记录 prompt、answer、secret、token、认证头或私有路径。
- `~/.pocketctl/codex-telemetry.json` 只保存固定枚举 fallback 次数、重连次数和最后 generation，不保存错误原文或内容。

排查命令：

```bash
pocketctl agent codex status
pocketctl daemon status
pocketctl daemon logs
pocketctl daemon doctor
codex doctor
```

遇到上游兼容问题时先用 `codex --native`；长期关闭则执行 `pocketctl agent codex disable`。

## 发布前验证

日常受管回归：

```bash
make test-codex-managed
```

完整发布门禁（含 Web build、六平台 Go build 与可用时的 iOS simulator build）：

```bash
make test-codex-managed-release
```

官方 CLI smoke 使用 `npm install --global @openai/codex` 安装当前版本，检查最低版本、schema、Unix app-server initialize/second-client 和 runtime acquire。该 smoke 不发起模型 turn，不需要消耗模型调用。

逐项需求、自动化映射与真实环境步骤见 [Codex Managed Terminal Control 测试用例](codex-managed-terminal-test-cases.md)。
