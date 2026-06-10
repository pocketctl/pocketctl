# pocketctl 产品化路线图

## 当前状态 vs 目标状态

| 维度 | 当前 | 目标 |
|------|------|------|
| 用户系统 | 无，共享 API Key | 注册/登录/JWT，多用户隔离 |
| 移动端 | 浏览器 H5（响应式） | App Store 原生 APP |
| 付费 | 无 | Apple IAP 订阅 |
| Daemon 安装 | 手动编译 | 一行命令安装 |
| 部署 | 本地 Docker Compose | 云端生产环境 |
| CI/CD | 无 | GitHub Actions 自动构建发布 |
| 代理支持 | 仅 Claude Code | Claude Code + Codex + OpenCode |

---

## Phase 1.5：多代理支持（2-3 周）

> 目标：支持 Codex 和 OpenCode 代理，与 Claude Code 并行工作。

### 1.5.1 代理适配器架构重构

当前架构完全硬编码为 Claude Code，需要重构为可插拔的适配器模式。

**现状分析：**

| 代理 | CLI | 流式 JSON | 会话恢复 | 会话存储 | pocketctl 集成 |
|------|-----|-----------|----------|----------|---------------|
| Claude Code | `claude -p "..." --output-format stream-json` | ✅ | `--resume <id>` | `~/.claude/sessions/` JSONL | ✅ 完整 |
| Codex | `codex exec --json "..."` | ✅ | `codex exec resume <id>` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | ❌ 仅 discovery |
| OpenCode | `opencode run --format json "..."` | ✅ | `--session <id>` / `--continue` | `XDG_DATA_HOME/opencode/storage/session/{pid}/{sid}.json` | ❌ 仅 discovery |

**好消息：三个代理都支持 NDJSON 流式输出，可以用统一接口处理。**

- [ ] 定义 `AgentAdapter` 接口
  ```go
  type AgentAdapter interface {
      // 构建 CLI 参数
      BuildArgs(prompt, sessionID string, config SessionConfig) []string
      // 解析 stdout 流式 JSON 行
      ParseStreamLine(line string) ([]protocol.DaemonEvent, error)
      // 解析 JSONL 会话文件行（可选，用于终端会话监听）
      ParseJSONLLine(line string) ([]protocol.DaemonEvent, error)
      // 会话文件目录
      SessionDir() string
      // 发现已有会话
      DiscoverSessions() ([]DiscoveredSession, error)
  }
  ```
- [ ] 将现有 `ClaudeAdapter` 重构为接口实现
- [ ] 更新 `SessionManager.CreateSession()` 按 agent 类型选择 adapter
- [ ] 更新 `watcher` 支持多目录监听（`~/.claude/sessions/` + `~/.codex/sessions/` + XDG）

**改动文件：**
- `internal/adapter/adapter.go`（新建，接口定义）
- `internal/adapter/claude.go`（重构为接口实现）
- `internal/session/manager.go`（adapter 注册与选择）
- `internal/watcher/watcher.go`（多目录支持）

### 1.5.2 Codex Adapter

- [ ] `internal/adapter/codex.go`（新建）
  - `codex exec --json --sandbox workspace-write -a never "prompt"` 启动
  - 解析 NDJSON stdout 事件（事件类型待抓取样本分析）
  - `codex exec resume <id>` 恢复会话
- [ ] `internal/watcher/codex_watcher.go`（新建）
  - 扫描 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 发现终端会话
  - 解析 JSONL 文件提取事件
- [ ] `cmd/pocketctl/main.go` 注册 Codex watcher

### 1.5.3 OpenCode Adapter

- [ ] `internal/adapter/opencode.go`（新建）
  - `opencode run --format json --dangerously-skip-permissions "prompt"` 启动
  - 解析 NDJSON stdout 事件（text/tool_use/step_start/step_finish/reasoning/error）
  - `opencode run --session <id> "prompt"` 恢复会话
- [ ] `internal/watcher/opencode_watcher.go`（新建）
  - 扫描 `XDG_DATA_HOME/opencode/storage/session/` 目录
  - 解析 JSON 文件提取会话和消息
- [ ] `cmd/pocketctl/main.go` 注册 OpenCode watcher

### 1.5.4 iOS 适配

- [ ] NewSessionSheet 代理选择器支持 claude-code / codex / opencode
- [ ] Session 列表显示代理类型图标
- [ ] 验证所有代理的 title 生成流程正常工作

**改动文件：**
- `ios/Pocketctl/Views/NewSessionSheet.swift`
- `ios/Pocketctl/Views/SessionListView.swift`

---

## Phase 1：云部署 + 用户体验优化（1-2 周）

> 目标：把服务端部署到云上，让系统可以通过公网访问，验证基本可用性。

### 1.1 生产环境部署

- [ ] 创建 `docker-compose.prod.yml`
  - PostgreSQL 强密码
  - 设置 `POCKETCTL_API_KEY`
  - PostgreSQL/Relay 端口不对外暴露
  - Web 容器 Nginx 监听 443 + SSL
- [ ] 配置 HTTPS（Let's Encrypt / 已有证书）
- [ ] WSS 代理配置（Nginx websocket 升级 + 长超时）
- [ ] 安全加固：CORS 限制、关闭 debug 日志

**改动文件：**
- `docker-compose.prod.yml`（新建）
- `web/nginx.conf`（加 SSL 配置）

### 1.2 Daemon 一键安装

- [ ] 创建安装脚本 `install.sh`
  ```bash
  curl -fsSL https://pocketctl.com/install.sh | bash
  ```
  - 检测 OS/架构（macOS arm64/amd64, Linux）
  - 下载对应二进制
  - 安装到 `/usr/local/bin/pocketctl`
- [ ] Homebrew Formula（`brew tap pocketctl/tap && brew install pocketctl`）
- [ ] 版本号注入：Go build 时 `-ldflags "-X main.version=v0.1.0"`

**改动文件：**
- `scripts/install.sh`（新建）
- `Makefile`（新建，构建/发布自动化）

### 1.3 Web UI 体验优化

- [ ] 登录页（替代 localStorage 手动设 API Key）
  - 输入 API Key → 验证 → 存 localStorage
  - 已有 Key 自动跳过
- [ ] Session 列表优化
  - 显示 hostname（已完成 ✅）
  - 空状态引导（提示安装 Daemon）
  - 下拉刷新（移动端）
- [ ] Session 详情优化
  - 加载状态骨架屏
  - 消息发送后自动滚到底部

**改动文件：**
- `web/src/views/LoginView.vue`（新建）
- `web/src/views/SessionList.vue`
- `web/src/views/SessionDetail.vue`
- `web/src/router/index.ts`（或 `main.ts`，加路由守卫）

---

## Phase 2：用户系统 + 多租户（2-3 周）

> 目标：支持多用户注册，每个用户只能看到自己的 Daemon 和 Session。

### 2.1 用户认证系统

- [ ] 数据库新增 `users` 表
  ```sql
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] 数据库新增 `user_daemons` 表（用户 ↔ Daemon 绑定）
  ```sql
  CREATE TABLE user_daemons (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    daemon_id VARCHAR(64) REFERENCES daemons(daemon_id),
    display_name VARCHAR(100),  -- 用户给 daemon 起的别名
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] Relay 新增 REST API 端点（Fastify 路由）
  - `POST /api/auth/register` — 注册（email + password）
  - `POST /api/auth/login` — 登录，返回 JWT access_token + refresh_token
  - `POST /api/auth/refresh` — 刷新 token
- [ ] JWT 认证中间件
  - WebSocket 连接：从 query param 读取 JWT（替代 API Key）
  - REST API：从 Authorization header 读取 JWT
- [ ] 密码安全：bcrypt hash

**改动文件：**
- `relay/src/db.ts`（新增 users/user_daemons 表、CRUD 函数）
- `relay/src/auth.ts`（新建，JWT 签发/验证/bcrypt）
- `relay/src/server.ts`（新增 REST 路由）
- `relay/src/router.ts`（WebSocket 连接改为 JWT 认证）
- `relay/package.json`（新增 `jsonwebtoken`、`bcryptjs`）

### 2.2 多租户隔离

- [ ] Daemon 注册时绑定用户
  - Daemon 连接时携带 user JWT
  - Router 将 daemon_id 关联到 user_id
- [ ] Session 查询隔离
  - `listSessions()` 改为按 user_id 过滤
  - 只返回该用户的 Daemon 下的 Session
- [ ] 事件推送隔离
  - `session_discovered`、`session_status` 等只推给关联用户
  - `daemon_status` 只推给该 Daemon 的拥有者
- [ ] `sessions` 表加 `user_id` 列（反范化，加速查询）

**改动文件：**
- `relay/src/router.ts`（所有路由加 user_id 过滤）
- `relay/src/db.ts`（所有查询加 user_id 条件）

### 2.3 前端适配

- [ ] 登录/注册页面
- [ ] Token 管理（access_token + refresh_token 自动刷新）
- [ ] 路由守卫（未登录跳转登录页）
- [ ] WebSocket 连接改为 JWT 认证
- [ ] 退出登录

**改动文件：**
- `web/src/views/LoginView.vue`（登录/注册表单）
- `web/src/composables/useAuth.ts`（新建，token 管理）
- `web/src/composables/useWebSocket.ts`（JWT 替代 API Key）
- `web/src/views/SessionList.vue`
- `web/src/views/SessionDetail.vue`

### 2.4 Daemon 认证改造

- [ ] Daemon 连接时使用 JWT（替代 API Key）
  - `pocketctl login --phone 138xxxx --code <SMS_CODE>` 先登录获取 token 并存储
  - `pocketctl daemon start --token <JWT>` 或 `POCKETCTL_TOKEN` 环境变量
- [ ] **登录流程追加短信验证码**：`pocketctl login` 交互式输入手机号 → 发验证码 → 输入验证码 → 验证并保存 token
  - API: `POST /api/auth/sms/send` 发送验证码
  - API: `POST /api/auth/sms/verify` 验证并返回 access/refresh token
  - Daemon 侧：交互式 CLI 输入 + `internal/api/client.go` 已有 SendSMS/VerifySMS 实现

**改动文件：**
- `cmd/pocketctl/main.go`（`login` 子命令完善：手机号输入、验证码发送验证、token 持久化）
- `internal/api/client.go`（已实现 SendSMS/VerifySMS）
- `internal/ws/client.go`（JWT 替代 API Key）

### 2.5 Daemon 自更新

- [ ] `pocketctl daemon update` 命令
  - 自动检测当前版本，从 release 下载最新版
  - 支持 `--version <tag>` 指定版本
  - 下载后验证 SHA256，自动替换二进制并重启
  - 支持 `--prod` 参数切换到生产下载源
  - 支持 macOS 和 Linux，自动识别架构
  - **优先级较高**：方便发布后快速迭代 daemon

**改动文件：**
- `cmd/pocketctl/main.go`（新增 `daemon update` 子命令）
- `internal/update/checker.go`（新建，版本检测/下载/校验）
- `Makefile`（可选：增加版本号注入 tag 信息）

---

## Phase 3：移动端 APP（2-3 周）

> 目标：上架 App Store，支持推送通知。

### 3.1 技术选型：Capacitor（最快上架）

> 理由：现有 Vue 3 代码已经移动端适配，Capacitor 直接包裹即可，
> 几天内可以出 TestFlight 版本。后续需要时再转 React Native。

- [ ] 集成 Capacitor
  ```
  npm install @capacitor/core @capacitor/cli
  npx cap init
  npx cap add ios
  npx cap add android
  ```
- [ ] 原生能力接入
  - `@capacitor/push-notifications` — APNs 推送
  - `@capacitor/local-notifications` — 本地通知
  - `@capacitor/app` — 前后台生命周期
  - `@capacitor/haptics` — 触觉反馈
- [ ] APP 壳配置
  - `Info.plist` — 权限声明（推送通知）
  - App Icon + Launch Screen
  - URL Scheme（`pocketctl://`）

**改动文件：**
- `web/capacitor.config.ts`（新建）
- `web/ios/`（Capacitor 生成）
- `web/android/`（Capacitor 生成）
- `web/package.json`（新增 Capacitor 依赖）

### 3.2 推送通知

- [ ] Relay 新增推送服务
  - 集成 APNs（iOS）/ FCM（Android）
  - 用户注册/登录时上报 device token
  - Session 状态变更时发送推送
- [ ] 数据库新增 `devices` 表
  ```sql
  CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    device_token VARCHAR(255) NOT NULL,
    platform VARCHAR(16),  -- 'ios' | 'android'
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] 推送触发场景
  - Agent 完成任务（session → completed）
  - Agent 出错（session → error）
  - Daemon 上线/离线

**改动文件：**
- `relay/src/push.ts`（新建，APNs/FCM 推送）
- `relay/src/router.ts`（事件触发推送）
- `relay/src/db.ts`（devices 表）

### 3.3 App Store 上架准备

- [ ] Apple Developer 配置
  - App ID、推送证书、Provisioning Profile
- [ ] App Store Connect
  - 应用名称、描述、截图、分类
  - 隐私政策 URL、用户协议 URL
- [ ] 审核准备
  - Demo 账号（供苹果审核使用）
  - 确保无 debug 日志、无测试数据
  - 隐藏未完成功能

---

## Phase 4：订阅付费（1-2 周）

> 目标：通过 Apple IAP 实现订阅收入。

### 4.1 订阅系统

- [ ] App Store Connect 配置
  - 创建订阅组（免费版 / 个人版 / 专业版）
  - 定价：免费 ¥0 / 个人 ¥18/月 / 专业 ¥48/月
- [ ] Relay 新增订阅验证
  - Apple IAP 收据验证（App Store Server API v2）
  - `POST /api/subscribe/verify` — 验证 App Store 收据
  - Apple Server Notification V2 回调 — 自动续订/过期/退款
- [ ] 数据库新增 `subscriptions` 表
  ```sql
  CREATE TABLE subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    plan VARCHAR(32) NOT NULL,         -- 'free' | 'personal' | 'pro'
    platform VARCHAR(16),              -- 'apple' | 'stripe'
    original_transaction_id VARCHAR(255),
    expires_at TIMESTAMPTZ,
    status VARCHAR(32),                -- 'active' | 'expired' | 'cancelled'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] 功能限制（按计划）
  - 免费版：1 个 Daemon，基础监控
  - 个人版：无限 Daemon，推送通知，消息发送
  - 专业版：多人共享，API 访问，优先支持

**改动文件：**
- `relay/src/subscribe.ts`（新建，Apple IAP 验证）
- `relay/src/server.ts`（新增 webhook 路由）
- `relay/src/db.ts`（subscriptions 表）
- `relay/src/router.ts`（按计划限制功能）
- `web/src/views/SubscribeView.vue`（新建，订阅页面）

### 4.2 Apple 审核注意事项

- 必须使用 Apple IAP（不能引导用户去网页付费）
- 必须有恢复购买功能
- 必须提供隐私政策和用户协议
- 订阅说明必须清晰（价格、周期、续订规则）

---

## Phase 5：生产加固 + 运维（持续）

> 目标：保障线上稳定运行。

### 5.1 CI/CD

- [ ] GitHub Actions
  - Go 二进制自动构建（macOS arm64/amd64, Linux amd64）
  - Relay Docker 镜像构建 + 推送
  - Web Docker 镜像构建 + 推送
  - 自动创建 GitHub Release
- [ ] 版本管理
  - `git tag v0.1.0` 触发发布流程

**改动文件：**
- `.github/workflows/release.yml`（新建）
- `.github/workflows/test.yml`（新建）

### 5.2 监控与告警

- [ ] `/health` 端点增强（内存、连接数、数据库延迟）
- [ ] 日志结构化（JSON 格式）
- [ ] 腾讯云监控告警（CPU > 80%、内存 > 90%、带宽 > 90%）

### 5.3 数据安全

- [ ] 数据库自动备份（腾讯云 PostgreSQL 快照）
- [ ] JWT secret 轮换机制
- [ ] 速率限制（防止暴力注册/登录）
- [ ] WebSocket 消息大小限制

---

## 时间线总览

```
Week 1-2   Phase 1: 云部署 + 体验优化
Week 3-5   Phase 1.5: 多代理支持（Codex + OpenCode）
Week 6-8   Phase 2: 用户系统 + 多租户
Week 9-11  Phase 3: 移动端 APP + 推送
Week 12-13 Phase 4: 订阅付费
Week 14+   Phase 5: 持续运维 + 迭代
           ──────────────────────────
           约 3-3.5 个月上架 App Store
```

## 优先级排序原则

1. **先能跑**（Phase 1）→ 线上可访问
2. **先能扩**（Phase 1.5）→ 多代理支持，扩大用户群
3. **先能用**（Phase 2）→ 多用户隔离
4. **先能卖**（Phase 3+4）→ APP + 订阅
5. **再优化**（Phase 5）→ 自动化运维
