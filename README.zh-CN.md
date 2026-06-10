# pocketctl

**Your coding agents, in your pocket.**

pocketctl 是一个远程 AI 编码代理控制系统。它让你在远程机器上运行 AI 编码代理（如 Claude Code、OpenCode、Codex），并通过 iOS App 或 Web 浏览器随时随地监控和交互。

## 架构

```
┌─────────────┐    WebSocket    ┌─────────────┐    WebSocket    ┌─────────────┐
│   iOS App   │ ◄────────────► │    Relay     │ ◄────────────► │   Daemon    │
│  (SwiftUI)  │                │  (Node.js)   │                │   (Go CLI)  │
└─────────────┘                └──────┬───────┘                └──────┬──────┘
                                      │                               │
                                      ▼                               ▼
                               ┌─────────────┐               ┌─────────────┐
                               │ PostgreSQL  │               │ Agent CLI   │
                               │  (Events)   │               │ (claude等)  │
                               └─────────────┘               └─────────────┘
                                      │
                                      ▼
                               ┌─────────────┐
                               │ 智谱 GLM-4.6│  ← Session 标题自动生成
                               │  (LLM API)  │
                               └─────────────┘
```

- **Daemon** — 运行在远程机器上的轻量守护进程，负责发现、启动和管理 AI 代理进程
- **Relay** — 中央 WebSocket 路由服务器，负责消息转发、事件持久化和 LLM 标题生成
- **iOS App** — SwiftUI 原生应用，提供会话列表、实时对话、工具调用查看等功能
- **Web UI** — Vue 3 单页应用（可选）

## 快速开始

### 前置条件

- [Docker](https://www.docker.com/) 和 Docker Compose
- [Go 1.25+](https://go.dev/)（编译 Daemon）
- 远程机器上安装了至少一个 AI 代理 CLI（`claude`、`opencode` 或 `codex`）
- [可选] 智谱 AI API Key（用于 Session 标题自动生成）

### 1. 启动 Relay

```bash
git clone <repo-url> && cd pocketctl
docker compose up -d
```

服务启动后：

| 服务 | 地址 |
|------|------|
| Relay WebSocket | ws://localhost:8080/ws |
| PostgreSQL | localhost:5432 |

### 2. 编译并启动 Daemon

在安装了 AI 代理的远程机器上：

```bash
cd pocketctl
go build -o pocketctl ./cmd/pocketctl

# 启动 daemon，连接到 relay
./pocketctl daemon start \
  --relay ws://<relay-host>:8080 \
  --token <your-jwt-token>
```

Daemon 会自动扫描 `PATH` 发现可用的代理 CLI，并注册到 Relay。

### 3. 使用 iOS App

1. 在 Xcode 中打开 `ios/Pocketctl.xcodeproj`
2. 编译并安装到 iPhone/iPad
3. 登录后即可查看和管理远程 AI 代理会话

### 4. Session 标题自动生成

Relay 集成了智谱 GLM-4.6 API，可自动为每个 Session 生成简洁的中文标题：

```
新建 Session → "Terminal Session-1def4567"  (默认名称)
       ↓ 等待首条用户消息 + 助手回复
       ↓ 调用 GLM-4.6 生成标题
       → "React暗色模式组件"                  (LLM 生成)
```

配置方式：在 Relay 的 `.env` 中设置 `ZHIPU_API_KEY`（从 [open.bigmodel.cn](https://open.bigmodel.cn) 获取）。

## CLI 命令

```
pocketctl login          [--relay <URL>] [--prod]           手机号短信验证登录
pocketctl daemon start   [--relay <URL>] [--prod] [--token] 启动代理守护进程
pocketctl daemon stop                                     停止运行中的守护进程
pocketctl daemon status                                   查看守护进程状态和已发现的代理
pocketctl daemon logs                                     查看日志（提示 tail 命令）
pocketctl daemon doctor                                   诊断连接和配置问题
pocketctl daemon update  [--version <TAG>] [--no-restart]  自更新到最新版本
pocketctl version                                         显示版本号
```

### `login` 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--relay` | 否 | Relay WebSocket 地址（默认 `ws://localhost:8080/ws`） |
| `--prod` | 否 | 连接生产环境 |

### `daemon start` 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--relay` | 否 | Relay WebSocket 地址（默认从 `~/.pocketctl/auth.json` 读取） |
| `--prod` | 否 | 连接生产环境 |
| `--token` | 否 | JWT 认证 Token（默认从 `~/.pocketctl/auth.json` 读取） |
| `--id` | 否 | Daemon ID（默认自动生成，重启后复用） |

### `daemon update` 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--version` | 否 | 指定升级版本（如 `v0.2.0`，默认升级到 latest） |
| `--no-restart` | 否 | 仅替换二进制，不重启 daemon |

## 配置

### Relay 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `POCKETCTL_API_KEY` | `""`（空=无认证） | WebSocket 认证密钥 |
| `DATABASE_URL` | `postgresql://localhost:5432/pocketctl` | PostgreSQL 连接地址 |
| `PORT` | `8080` | 监听端口 |
| `NODE_ENV` | `development` | 运行环境（`development` / `production`） |
| `ZHIPU_API_KEY` | 空 | 智谱 AI API Key（用于 Session 标题自动生成，未设置则跳过） |
| `COS_SECRET_ID` | 空 | 腾讯云 API 密钥 ID（用于短信发送） |
| `COS_SECRET_KEY` | 空 | 腾讯云 API 密钥 Key（用于短信发送） |
| `SMS_SDK_APP_ID` | 空 | 腾讯云短信应用 SDK AppID |
| `SMS_SIGN_NAME` | 空 | 短信签名名称 |
| `SMS_TEMPLATE_ID` | 空 | 短信模板 ID |
| `DEV_SMS_PHONE` | 空 | 开发模式测试手机号 |
| `DEV_SMS_CODE` | 空 | 开发模式测试验证码 |

### Docker Compose 默认值

| 服务 | 配置 |
|------|------|
| PostgreSQL | 用户 `pocketctl`，密码 `pocketctl`，数据库 `pocketctl` |
| Relay API Key | 设置 `POCKETCTL_API_KEY` 环境变量 |

## WebSocket 协议

所有消息均为 JSON 格式，通过 Relay 路由转发。

### Daemon → Relay（控制消息）

**注册：**
```json
{"type": "register", "daemon_id": "uuid", "hostname": "host", "agents": ["claude-code"]}
```

**心跳：**
```json
{"type": "ping"}
```

### Client → Relay → Daemon（命令）

**创建会话：**
```json
{"type": "session_create", "agent": "claude-code", "cwd": "/path/to/project", "prompt": "Fix the bug"}
```

**发送消息：**
```json
{"type": "user_message", "session_id": "sess-uuid", "content": "Now add tests"}
```

**终止会话：**
```json
{"type": "session_kill", "session_id": "sess-uuid"}
```

**重放历史：**（Relay 直接处理，不转发给 Daemon）
```json
{"type": "replay", "session_id": "sess-uuid", "last_seq": 0}
```

### Daemon → Relay → Client（事件）

**会话已创建：**
```json
{"type": "session_created", "session_id": "sess-uuid"}
```

**代理文本输出：**
```json
{"type": "agent_text", "session_id": "sess-uuid", "text": "I'll fix that...", "streaming": false}
```

**工具调用：**
```json
{"type": "tool_call", "session_id": "sess-uuid", "call_id": "call-uuid", "tool": "Read", "input": {"file_path": "main.go"}}
```

**工具结果：**
```json
{"type": "tool_result", "session_id": "sess-uuid", "call_id": "call-uuid", "output": "file contents..."}
```

**会话状态变更：**
```json
{"type": "session_status", "session_id": "sess-uuid", "status": "completed", "cost_usd": 0.05, "turns": 3}
```

**错误：**
```json
{"type": "error", "session_id": "sess-uuid", "error": "description"}
```

**Session 标题生成请求：**（Daemon → Relay，触发 LLM 标题生成）
```json
{"type": "generate_title_request", "session_id": "sess-uuid", "user_message": "帮我写一个React组件", "assistant_message": "好的，我来帮你创建..."}
```

**Session 标题更新：**（Relay → Client，LLM 生成的标题）
```json
{"type": "session_title_update", "session_id": "sess-uuid", "title": "React暗色模式组件"}
```

### 会话状态

| 状态 | 说明 |
|------|------|
| `running` | 代理正在处理 |
| `idle` | 代理空闲，等待用户输入 |
| `busy` | 代理忙（工具调用中） |
| `completed` | 代理成功完成 |
| `error` | 代理出错终止 |
| `killed` | 会话被手动终止 |
| `exited` | 进程已退出 |
| `disconnected` | Daemon 离线（临时状态） |

## 数据库

Relay 使用 PostgreSQL 存储事件历史，支持断线重连后的消息重放。

```sql
-- 核心表
daemons           -- 注册的守护进程（daemon_id, hostname, agents, status, last_heartbeat, user_id）
sessions          -- 代理会话（session_id, daemon_id, agent_type, cwd, title, source, status, user_id）
events            -- 事件流（session_id, event_type, payload JSONB, event_hash 去重）
users             -- 用户账户（email, phone, password_hash）
devices           -- iOS 推送设备（user_id, device_token, platform）
deleted_sessions  -- 已删除 session 的墓碑表（用于防止重新发现已删除的 session）
```

## 项目结构

```
pocketctl/
├── cmd/pocketctl/main.go          # CLI 入口
├── internal/
│   ├── adapter/
│   │   ├── claude.go              # Claude Code stream-json 输出解析器
│   │   └── claude_jsonl.go        # JSONL 文件解析（提取消息、标题）
│   ├── api/client.go              # HTTP API 客户端（认证、SMS）
│   ├── config/config.go           # 配置管理（~/.pocketctl/auth.json）
│   ├── daemon/                    # PID 文件、守护进程状态管理
│   ├── discovery/discovery.go     # 代理 CLI 自动发现
│   ├── notify/                    # 终端通知
│   ├── protocol/types.go          # WebSocket 消息类型定义
│   ├── session/manager.go         # 会话生命周期管理（含标题生成触发）
│   ├── update/updater.go          # Daemon 自更新（版本检测、下载、校验、替换）
│   ├── watcher/
│   │   ├── watcher.go             # Session 文件监控（fsnotify）
│   │   ├── tailer.go              # JSONL 文件尾随（实时事件流）
│   │   └── process.go             # 进程存活监控
│   └── ws/client.go               # WebSocket 客户端（含自动重连）
├── relay/
│   └── src/
│       ├── server.ts              # Fastify + WebSocket 入口
│       ├── router.ts              # 消息路由逻辑（含 generate_title_request 处理）
│       ├── db.ts                  # PostgreSQL 连接和查询
│       ├── title.ts               # GLM-4.6 标题生成服务
│       ├── auth.ts                # JWT 认证
│       ├── push.ts                # iOS 推送通知（APNs）
│       └── config/
│           └── sms.ts             # 腾讯云短信发送服务
├── ios/
│   └── Pocketctl/
│       ├── App/                   # SwiftUI App 入口
│       ├── Models/                # Session、WebSocketEvent 数据模型
│       ├── ViewModels/            # SessionList、SessionDetail、DaemonList
│       ├── Views/                 # UI 视图组件
│       └── Services/              # WebSocket、API、Keychain、Push
├── web/                           # Vue 3 Web UI（可选）
├── docs/                          # 文档（路线图、测试报告、上线计划）
├── .claude/skills/                # Claude Code 技能（自动化工作流）
├── docker-compose.yml
├── go.mod
└── go.sum
```

## 技术栈

| 组件 | 技术 |
|------|------|
| Daemon | Go 1.25, gorilla/websocket, fsnotify |
| Relay | TypeScript, Fastify v5, @fastify/websocket, PostgreSQL |
| iOS App | SwiftUI, URLSessionWebSocketTask, Swift 6 |
| Web UI | Vue 3, Vue Router 4, Vite 6, TypeScript（可选） |
| LLM | 智谱 GLM-4.6（Session 标题自动生成） |
| 部署 | Docker Compose, PostgreSQL 17 |

## License

MIT
