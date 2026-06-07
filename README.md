# pocketctl

**Your coding agents, in your pocket.**

pocketctl 是一个远程 AI 编码代理控制系统。它让你在远程机器上运行 AI 编码代理（如 Claude Code、OpenCode、Codex），并通过 Web 浏览器随时随地监控和交互。

## 架构

```
┌─────────────┐    WebSocket    ┌─────────────┐    WebSocket    ┌─────────────┐
│   Web UI    │ ◄────────────► │    Relay     │ ◄────────────► │   Daemon    │
│  (Browser)  │                │  (Node.js)   │                │   (Go CLI)  │
└─────────────┘                └──────┬───────┘                └──────┬──────┘
                                      │                               │
                                      ▼                               ▼
                               ┌─────────────┐               ┌─────────────┐
                               │ PostgreSQL  │               │ Agent CLI   │
                               │  (Events)   │               │ (claude等)  │
                               └─────────────┘               └─────────────┘
```

- **Daemon** — 运行在远程机器上的轻量守护进程，负责发现、启动和管理 AI 代理进程
- **Relay** — 中央 WebSocket 路由服务器，负责消息转发和事件持久化
- **Web UI** — Vue 3 单页应用，提供会话列表、实时对话、工具调用查看等功能

## 快速开始

### 前置条件

- [Docker](https://www.docker.com/) 和 Docker Compose
- [Go 1.25+](https://go.dev/)（编译 Daemon）
- 远程机器上安装了至少一个 AI 代理 CLI（`claude`、`opencode` 或 `codex`）

### 1. 启动 Relay 和 Web UI

```bash
git clone <repo-url> && cd pocketctl
docker compose up -d
```

服务启动后：

| 服务 | 地址 |
|------|------|
| Web UI | http://localhost:3000 |
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
  --api-key <your-api-key>
```

Daemon 会自动扫描 `PATH` 发现可用的代理 CLI，并注册到 Relay。

### 3. 使用 Web UI

1. 在浏览器中打开 `http://localhost:3000`
2. 在浏览器控制台设置 API Key：
   ```js
   localStorage.setItem('pocketctl_api_key', '<your-api-key>')
   ```
3. 刷新页面，点击 **"+ New Session"** 创建新会话

## CLI 命令

```
pocketctl daemon start   --relay <URL> --api-key <KEY>   启动代理守护进程
pocketctl daemon stop                                     停止运行中的守护进程
pocketctl daemon status                                   查看守护进程状态和已发现的代理
pocketctl daemon logs                                     查看日志（提示 tail 命令）
pocketctl version                                         显示版本号
```

### `daemon start` 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--relay` | 是 | Relay WebSocket 地址（如 `ws://host:8080/ws`） |
| `--api-key` | 是 | Relay 认证 API Key |

## 配置

### Relay 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `POCKETCTL_API_KEY` | `""`（空=无认证） | WebSocket 认证密钥 |
| `DATABASE_URL` | `postgresql://localhost:5432/pocketctl` | PostgreSQL 连接地址 |
| `PORT` | `8080` | 监听端口 |

### Docker Compose 默认值

| 服务 | 配置 |
|------|------|
| PostgreSQL | 用户 `pocketctl`，密码 `pocketctl`，数据库 `pocketctl` |
| Relay API Key | `test-api-key` |
| Web UI | `http://localhost:3000` |

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

### 会话状态

| 状态 | 说明 |
|------|------|
| `running` | 代理正在处理 |
| `completed` | 代理成功完成 |
| `error` | 代理出错终止 |
| `killed` | 会话被手动终止 |

## 数据库

Relay 使用 PostgreSQL 存储事件历史，支持断线重连后的消息重放。

```sql
-- 三个核心表
daemons   -- 注册的守护进程（id, hostname, agents, status, last_heartbeat）
sessions  -- 代理会话（session_id, daemon_id, agent_type, cwd, status）
events    -- 事件流（session_id, event_type, payload JSONB, 自增 id）
```

## 项目结构

```
pocketctl/
├── cmd/pocketctl/main.go          # CLI 入口
├── internal/
│   ├── adapter/claude.go          # Claude Code stream-json 输出解析器
│   ├── daemon/pid.go              # PID 文件管理
│   ├── discovery/discovery.go     # 代理 CLI 自动发现
│   ├── protocol/types.go          # WebSocket 消息类型定义
│   ├── session/manager.go         # 会话生命周期管理
│   └── ws/client.go               # WebSocket 客户端（含自动重连）
├── relay/
│   └── src/
│       ├── server.ts              # Fastify + WebSocket 入口
│       ├── router.ts              # 消息路由逻辑
│       └── db.ts                  # PostgreSQL 连接和查询
├── web/
│   └── src/
│       ├── composables/useWebSocket.ts  # WebSocket 组合式函数
│       ├── views/                 # 页面组件
│       └── components/            # UI 组件
├── docker-compose.yml
├── go.mod
└── go.sum
```

## 技术栈

| 组件 | 技术 |
|------|------|
| Daemon | Go 1.25, gorilla/websocket |
| Relay | TypeScript, Fastify v5, @fastify/websocket, PostgreSQL |
| Web UI | Vue 3, Vue Router 4, Vite 6, TypeScript |
| 部署 | Docker Compose, PostgreSQL 17, Nginx |

## License

MIT
