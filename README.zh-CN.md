# PocketCtl

[English](README.md) | [简体中文](README.zh-CN.md)

**让 AI 编码代理始终触手可及。**

PocketCtl 是面向 Claude Code、Codex、OpenCode 和 ZCode 的跨设备控制平面。
你可以从浏览器或 iPhone 跟进任务、在 Agent 需要时响应，并在支持的会话中
继续工作，同时让代码仓库和 Agent 进程留在开发机上运行。

[官网](https://www.pocketctl.me) · [Web 客户端](https://www.pocketctl.me/app) · [iOS App](https://apps.apple.com/cn/app/pocketctl/id6778710005) · [版本发布](https://github.com/pocketctl/pocketctl/releases)

## 为什么使用 PocketCtl

- **随时掌握进度** — 实时查看会话输出、状态、工具调用、文件改动、计划和
  Sub-agent 活动。
- **在 Runtime 支持时直接处理** — 从 Web 或 iOS 发送后续消息、回答问题、
  处理审批、调整任务方向或中断当前 Turn。
- **可视化选择项目目录** — 在 Web 或 iOS 上新建会话时直接浏览并选择工作
  目录，无需手动输入路径。
- **保留原生终端体验** — 受管 Codex 和 OpenCode 会话继续使用官方 TUI，
  同时与 PocketCtl 共享同一个 Runtime。
- **断线后恢复上下文** — Relay 持久化规范化事件用于重放，Daemon 重启后会
  重新协调受支持的受管会话。
- **远程查看会话文档** — 以安全快照形式捕获会话关键文档，在 Web 或 iOS
  查看与下载。
- **用项目组织会话** — 在 Web 或 iOS 上把会话归入项目、置顶重要会话并归档
  已完成的会话，让活跃列表保持聚焦。
- **只关注真正需要处理的事项** — 可选的 Attention Inbox 会聚合待回答问题、
  审批、高风险操作和恢复信号，并保留对应会话上下文。
- **沉淀受治理的项目知识（实验性）** — 可选的 Memory 工作台将仓库源码转化
  为经评审才发布的 Wiki 和带影响分析的依赖代码图谱，并对 Skill 文档保持
  显式治理。

## Agent 支持范围

PocketCtl 按真实能力开放控制。发现一个会话，并不代表它会自动获得远程控制能力。

| Agent | 查看能力 | 远程交互 | 集成方式 |
|---|---|---|---|
| **Claude Code** | 实时历史与输出 | 用户独立启动的终端会话可在空闲或退出后通过 `--resume` 接力；PocketCtl 创建的 PTY 支持 Web/iOS 审批，独立终端会话仍以原生终端为权威。 | 自动发现，不宣称共享 Runtime。详见 [Claude 跨端控制](docs/claude-cross-device-control.md)。 |
| **Codex CLI 0.144.1+** | Thread、Turn、Item、计划与交互 | 受管会话支持共享输入、Steer/Interrupt、审批、问题、标准 MCP Elicitation，以及带自动补全的 `/` 命令与技能显式调用。 | 可选 Launcher 将官方 TUI 和 Daemon 连接到同一个 App Server。详见 [Codex 受管终端控制](docs/codex-managed-terminal.md)。 |
| **Codex Desktop** | 增量同步 rollout 历史、状态、模型、Token、工具、计划和文件改动 | 只读，不支持远程输入、审批、中断、终止、恢复或创建会话。 | 自动发现的 Observer；以 `codex-desktop` 与 Codex CLI 分开显示。 |
| **OpenCode 1.17.11+** | 会话、内容、状态、命令与交互 | 受管会话支持共享输入、Permission 和 Question；已独立运行的进程保持只读，直到通过 Launcher 安全恢复。 | 可选 Launcher 将官方 TUI 和 Daemon 连接到同一个共享 Server。详见 [OpenCode 受管终端控制](docs/opencode-managed-terminal.md)。 |
| **ZCode Desktop** | 从本地 SQLite 增量同步历史 | 只读，不支持远程输入、审批、恢复或控制。 | 针对 Desktop 拥有会话、显式启用的 Observer。 |
| **ZCode Runtime** | 原生 ZCode 会话的实时事件与 Turn 状态 | PocketCtl 创建的会话支持远程创建、共享输入和中断活动 Turn；其余反向交互请求保持不支持。 | Daemon 拥有的 `zcode app-server --stdio` 运行时，与 ZCode Desktop Observer 分开显示。 |

PocketCtl 可通过 Agent Provider 扩展。公共适配协议见
[添加 Agent](docs/adding-an-agent.md)。

## 工作原理

```text
┌────────────────────┐       HTTPS / WSS       ┌────────────────────┐
│ Web 客户端 / iOS   │ ◄─────────────────────► │       Relay        │
└────────────────────┘                         │ 认证 + 事件重放     │
                                               └─────────┬──────────┘
                                                         │ WSS
                                               ┌─────────▼──────────┐
                                               │ PocketCtl Daemon   │
                                               │      开发机         │
                                               └─────────┬──────────┘
                                                         │ 本地 Runtime
                                               ┌─────────▼──────────┐
                                               │  AI 编码 Agent CLI │
                                               └────────────────────┘
```

- **Daemon** 与代码仓库运行在同一台开发机上，发现 Agent 会话，并把不同
  Runtime 的真实能力转换为统一协议。
- **Relay** 负责设备认证、命令路由，以及会话事件的持久化、历史重放和重连。
- **Web 与 iOS 客户端** 展示同一批会话，只开放 Daemon 明确确认支持的操作。

## 快速开始

最快的使用方式是连接 `pocketctl.me` 提供的托管 Relay。

### 1. 安装 Daemon

安装脚本支持 macOS 和 Linux 的 x86-64、ARM64 架构，会下载已发布的二进制，
并使用 GitHub Release 的 SHA-256 校验文件验证完整性。

```bash
curl -fsSL https://www.pocketctl.me/install.sh | bash
```

### 2. 登录并启动

```bash
pocketctl login --prod
pocketctl daemon start --prod
pocketctl daemon status
```

无浏览器的服务器可以改用邮箱验证码：

```bash
pocketctl login --prod --email
```

### 3. 打开客户端

使用 [Web 客户端](https://www.pocketctl.me/app)，或从
[App Store](https://apps.apple.com/cn/app/pocketctl/id6778710005) 安装 PocketCtl。
Daemon 会自动发现 `PATH` 中兼容的 Agent CLI。

## 启用共享终端控制

受管 Launcher 是可选且可随时撤销的。它不会安装、替换或升级底层 Agent CLI。

### Codex

```bash
pocketctl agent codex enable
pocketctl agent codex status
codex
```

单次绕过 PocketCtl 可使用 `codex --native ...`；执行
`pocketctl agent codex disable` 可移除 PocketCtl Launcher。

**单机多 Codex 账号。** 隔离的 Codex home（`~/.codex-a`、`~/.codex-proxy`
等）可以同时监听——通过可重复的 `--codex-home <目录>` 参数或
`POCKETCTL_CODEX_HOMES` 环境变量添加额外 home，之后在 Web 或 iOS 新建
会话时即可选择对应账号。

### OpenCode

```bash
pocketctl agent opencode enable
pocketctl agent opencode status
opencode
```

单次绕过 PocketCtl 可使用 `opencode --native ...`；执行
`pocketctl agent opencode disable` 可移除 PocketCtl Launcher。

## Memory（实验性）

Memory 把 Agent 对仓库的了解沉淀为经过评审的持久知识，而不是随会话消失的
上下文。它是可选功能，在 Web 端的 Memory 工作台中管理。

- **知识账本** — 从仓库源码提炼的候选知识进入带证据和置信度的不可变账本。
  任何条目都需要评审后才会接受；修正会创建新版本，而不是覆盖历史。
- **依赖代码图谱** — 查看组件之间的依赖关系，修改前先做影响分析。
- **Skill 文档治理** — 操作型 Skill 文档（触发条件、前置条件、操作步骤、
  验证方法、回滚说明）走显式的「候选 → 评审 → 批准/发布」流程，而不是
  静默修改。
- **回合前上下文注入** — 每个新回合开始时，Daemon 在 750ms 硬预算内把相关
  知识编译为隐藏上下文包，经 Agent 原生通道投递。投递始终 fail-open ——
  任何失败都不会延迟或阻塞你的输入 —— 且 Daemon 从不持久化或记录上下文包
  内容。
- **MCP 访问** — 宿主 Agent 可通过 MCP 桥接查询同一份知识，工具与工作台
  共享单一事实来源。

模型辅助的知识提炼在服务端运行，需要已配置的模型 Provider；未配置时工作台
保持不可用，而不是降级运行。关于哪些数据会离开开发机，见
[安全与数据边界](#安全与数据边界)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pocketctl login [--prod] [--email]` | 通过浏览器设备流或邮箱验证码登录。 |
| `pocketctl daemon start [--prod]` | 启动 Daemon 并发现本地 Agent。 |
| `pocketctl daemon status` | 查看 Daemon、Relay 和已发现 Agent 的状态。 |
| `pocketctl daemon doctor` | 诊断配置和连接问题。 |
| `pocketctl daemon diagnose <会话ID>` | 检查单个会话是否已代理，并输出原因和恢复建议。 |
| `pocketctl daemon logs` | 定位或跟踪 Daemon 日志。 |
| `pocketctl daemon update [--version TAG]` | 下载并校验已发布的更新。 |
| `pocketctl agent <agent> status` | 查看 Launcher、能力和 Runtime 状态。 |
| `pocketctl agent zcode sync enable` | 启用只读 ZCode 历史同步；重启 Daemon 后生效。 |
| `pocketctl uninstall [--yes] [--keep-binary]` | 移除 Daemon 和本地 PocketCtl 数据。 |

运行 `pocketctl help`，或对相应子命令使用 `--help` 查看全部参数。

## 安全与数据边界

PocketCtl 让代码仓库和 Agent 进程留在开发机上，但这**不代表会话内容只在本地**。

- 生产环境传输使用 HTTPS/WSS。
- 会话和工具内容**不是端到端加密**。配置的 Relay 可以读取并持久化路由、
  历史重放、通知和账户功能所需的规范化内容。
- 如果 Relay 配置了 `MIMO_API_KEY`，生成会话标题所需的文本会优先发送给小米
  MiMo（关闭思考模式）。MiMo 超时后，若配置了 `DEEPSEEK_API_KEY` 则回退到
  DeepSeek；两者均未配置时跳过标题生成。
- 如果启用 Memory，模型辅助的知识提炼会把相关仓库文本发送给服务端配置的
  模型 Provider。回合前上下文包与其他会话内容一样经已认证的 Relay 传输；
  Daemon 从不持久化或记录上下文包内容。
- 受管 Codex/OpenCode 的本地 Endpoint 和 Runtime 凭据保留在开发机上，
  客户端通过已认证的 Relay 通信。

使用托管服务或连接敏感代码仓库前，请阅读当前的
[隐私政策](https://www.pocketctl.me/privacy.html)。

## 自托管

支持的生产部署入口只有经过加固的两种路径：

- [`docker-compose.prod.yml`](docker-compose.prod.yml)：基于 Compose 部署。
- `deploy/deploy.sh`：基于 systemd、PostgreSQL 和 Nginx 的裸机部署。

两种路径都要求显式配置 TLS、认证密钥，以及相互独立的 PostgreSQL 管理员和
应用账户凭据。生产 Compose 拓扑只公开 Nginx；Relay 和 PostgreSQL 保留在
内部网络中。

`scripts/deploy.sh` 是已退役的旧部署入口，会主动退出并给出迁移说明；不要用于
新的生产部署。

## 构建与测试

发布工具链使用 Go 1.25 和 Node.js 22。

```bash
git clone https://github.com/pocketctl/pocketctl.git
cd pocketctl
make build
make test
```

公共仓库包含 Go Daemon、TypeScript Relay、Vue Web 客户端、部署定义和集成文档。
iOS 源码不属于 GitHub 公共镜像。

## 参与贡献与仓库说明

欢迎在 [GitHub](https://github.com/pocketctl/pocketctl/issues) 提交 Issue 和 Pull Request。
扩展新 Runtime 时，请保留“发现会话、只读观察、接力恢复、共享控制”之间的边界。

Gitee 仓库保存规范源码历史；GitHub 是用于公开审阅和 Release 资产的过滤镜像，
两边的 Commit ID 可能不同。

## License

[MIT](LICENSE)
